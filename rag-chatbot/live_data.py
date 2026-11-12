"""
Live e-Delphyn data for the running chatbot.

Instead of answering from a snapshot that is only as fresh as the last manual
refresh_data.py run, app.py pulls the data live from the Node backend's
/api/dashboard/category-query endpoint (the same one fetch_snapshot.py uses):

  - Data is cached in memory for LIVE_TTL_SECONDS (default 60) so a burst of
    questions doesn't hit the hospital database once per question. The first
    question after the TTL expires triggers a re-fetch.
  - Exact answers (counts, breakdowns, trends, patient lookups --
    structured_query.py) are therefore never more than LIVE_TTL_SECONDS old.
  - After each fetch whose data actually changed, the Chroma vector index is
    synced in a background thread. The sync is incremental: only monthly
    summaries whose text changed are re-embedded (usually just the current
    month), so it takes seconds, not minutes.
  - Every successful fetch is also written to data_snapshot/, so if
    node-backend / e-Delphyn becomes unreachable the chatbot falls back to
    the last good data instead of failing.

Set RAG_LIVE_DATA=0 to turn this off and answer from data_snapshot/ only
(the old behaviour, e.g. for eval_regression.py on a fixed dataset).
"""

import hashlib
import json
import os
import threading
import time

from categories import CATEGORIES, SNAPSHOT_DIR

LIVE_ENABLED = os.environ.get("RAG_LIVE_DATA", "1") != "0"
LIVE_TTL_SECONDS = int(os.environ.get("RAG_LIVE_TTL_SECONDS", "60"))

_lock = threading.Lock()            # guards fetching + the fields below
_rows_by_category = None            # {category: [row, ...]}
_fetched_at = None                  # time.time() of the data currently held
_source = None                      # "live" | "snapshot"
_last_error = None
_version = 0                        # bumps whenever the data changes
_data_hash = None

_index_lock = threading.Lock()      # one index sync at a time
_index_listeners = []               # callables(rows_by_category) run on change


def _read_snapshot():
    rows_by_category = {}
    for category in CATEGORIES:
        path = os.path.join(SNAPSHOT_DIR, f"{category}.json")
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as f:
                rows_by_category[category] = json.load(f)
        else:
            rows_by_category[category] = []
    return rows_by_category


def _write_snapshot(rows_by_category):
    os.makedirs(SNAPSHOT_DIR, exist_ok=True)
    for category, rows in rows_by_category.items():
        path = os.path.join(SNAPSHOT_DIR, f"{category}.json")
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(rows, f, ensure_ascii=False)
        os.replace(tmp, path)


def _fetch_live():
    # Imported lazily: fetch_snapshot raises at import time if JWT_SECRET is
    # missing, which shouldn't break snapshot-only mode.
    import fetch_snapshot
    token = fetch_snapshot._make_token()
    return {c: fetch_snapshot.fetch_category(token, c) for c in CATEGORIES}


def _hash(rows_by_category):
    blob = json.dumps(rows_by_category, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha1(blob.encode("utf-8")).hexdigest()


def on_change(callback):
    """Register callback(rows_by_category), run in a background thread
    whenever newly fetched data differs from what was held before."""
    _index_listeners.append(callback)


def _notify_change(rows_by_category):
    def run():
        with _index_lock:
            for cb in _index_listeners:
                try:
                    cb(rows_by_category)
                except Exception as e:  # never let indexing kill the app
                    print(f"[live_data] index sync failed: {e}")
    threading.Thread(target=run, daemon=True).start()


def _set_data(rows_by_category, source):
    global _rows_by_category, _fetched_at, _source, _version, _data_hash
    new_hash = _hash(rows_by_category)
    changed = new_hash != _data_hash
    _rows_by_category = rows_by_category
    _fetched_at = time.time()
    _source = source
    if changed:
        _data_hash = new_hash
        _version += 1
    return changed


_next_live_attempt = 0.0            # don't retry a failed live fetch every question


def get_rows():
    """{category: rows}, refreshed live when older than LIVE_TTL_SECONDS.
    Returns (rows_by_category, version)."""
    global _last_error, _next_live_attempt
    with _lock:
        now = time.time()
        if LIVE_ENABLED and now >= _next_live_attempt:
            _next_live_attempt = now + LIVE_TTL_SECONDS
            try:
                rows = _fetch_live()
                _last_error = None
                if _set_data(rows, "live"):
                    try:
                        _write_snapshot(rows)
                    except OSError as e:
                        print(f"[live_data] could not write snapshot: {e}")
                    _notify_change(rows)
                return _rows_by_category, _version
            except Exception as e:
                _last_error = str(e)
                print(f"[live_data] live fetch failed, using last good data: {e}")

        if _rows_by_category is None:
            # Nothing in memory yet (live disabled, or first fetch failed):
            # fall back to the last snapshot written to disk.
            _set_data(_read_snapshot(), "snapshot")
        return _rows_by_category, _version


def status():
    """Small dict describing where the current answers come from."""
    return {
        "source": _source,
        "data_as_of": (
            time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(_fetched_at))
            if _fetched_at else None
        ),
        "live_enabled": LIVE_ENABLED,
        "ttl_seconds": LIVE_TTL_SECONDS,
        "last_error": _last_error,
    }
