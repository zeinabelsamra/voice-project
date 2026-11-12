"""
Summarizes each e-Delphyn category by month (instead of embedding all raw
rows, which is too slow on a CPU-only laptop), embeds the summaries with
Ollama (nomic-embed-text), and stores them in a local Chroma vector database.

app.py calls sync_index() automatically whenever live_data.py fetches data
that changed -- only changed months are re-embedded. Running this file by
hand (or via refresh_data.py) syncs the index from data_snapshot/ instead.
"""

import os
import json
import pandas as pd
import chromadb
import ollama

from categories import CATEGORIES, CATEGORY_LABELS, IDENTIFIER_COLS, SNAPSHOT_DIR

DB_DIR = os.path.join(os.path.dirname(__file__), "chroma_db")
EMBED_MODEL = "nomic-embed-text"
COLLECTION_NAME = "bloodbank"


def summarize_group(category, period_label, group_df):
    label = CATEGORY_LABELS.get(category, category)
    lines = [f"[{label}] {period_label}: {len(group_df)} record(s)"]
    for col in group_df.columns:
        key = col.strip().lower()
        if key in IDENTIFIER_COLS or key in ("date", "time"):
            continue
        series = group_df[col].dropna()
        series = series[series.astype(str).str.strip() != ""]
        if series.empty:
            continue
        # Bug: `dtype == object` short-circuits this for almost every real
        # column, since pandas loads plain strings as object dtype whether
        # or not they're actually categorical -- so a near-unique free-text
        # column (order form numbers, delivery notes, bag/box IDs not
        # already caught by IDENTIFIER_COLS) was getting a "breakdown" line
        # too, listing up to 8 values that each occur once. That's not a
        # summary, it's noise -- and it gets WORSE as real data grows: a
        # busy month has more of exactly this kind of high-cardinality
        # column, each one crowding out the genuinely useful categorical
        # breakdowns (Group, Component, Reason...) in the limited context
        # the small local LLM actually reads.
        #
        # An absolute cap alone (nunique() <= 20) isn't quite enough either:
        # a quiet month with only, say, 15 records will make even a fully
        # per-row-unique ID column (nunique() == 15) pass that cap. Require
        # actual repetition too -- most values appearing more than once --
        # so a column only counts as categorical when it plausibly is one,
        # independent of how many rows happen to be in this group.
        nunique = series.nunique()
        if nunique <= 20 and nunique <= max(3, len(series) * 0.5):
            counts = series.astype(str).value_counts().head(8)
            parts = ", ".join(f"{k}: {v}" for k, v in counts.items())
            lines.append(f"  {col} breakdown: {parts}")
    return "\n".join(lines)


def chunks_from_rows(rows_by_category, verbose=True):
    """{chunk_id: summary_text} -- one chunk per category per month. The id is
    stable ("transfusion:2026-11"), so sync_index can tell which months
    actually changed and only re-embed those."""
    chunks = {}
    for category in CATEGORIES:
        rows = rows_by_category.get(category) or []
        if not rows:
            if verbose:
                print(f"Skipping {category}: no data")
            continue

        df = pd.DataFrame(rows)
        date_col = next((c for c in df.columns if c.strip().lower() == "date"), None)
        if date_col is None:
            chunks[f"{category}:all"] = summarize_group(category, "all records", df)
        else:
            dates = pd.to_datetime(df[date_col], errors="coerce")
            periods = dates.dt.to_period("M")
            for period, group_df in df.groupby(periods.fillna(pd.Period("1900-01", freq="M"))):
                label = str(period) if str(period) != "1900-01" else "unknown date"
                chunks[f"{category}:{label}"] = summarize_group(category, label, group_df)
        if verbose:
            print(f"Loaded {category} ({len(rows)} row(s))")
    return chunks


def load_snapshot_rows():
    rows_by_category = {}
    for category in CATEGORIES:
        path = os.path.join(SNAPSHOT_DIR, f"{category}.json")
        if not os.path.exists(path):
            print(f"Skipping {category}: no snapshot found (run fetch_snapshot.py first)")
            continue
        with open(path, "r", encoding="utf-8") as f:
            rows_by_category[category] = json.load(f)
    return rows_by_category


def get_or_create_collection(client=None):
    client = client or chromadb.PersistentClient(path=DB_DIR)
    return client.get_or_create_collection(COLLECTION_NAME)


def sync_index(collection, rows_by_category, verbose=True):
    """Bring the vector index in line with rows_by_category, re-embedding
    only chunks that are new or whose summary text changed, and deleting
    chunks that no longer exist. Returns (embedded, deleted) counts."""
    chunks = chunks_from_rows(rows_by_category, verbose=verbose)
    existing = collection.get(include=["documents"])
    current = dict(zip(existing["ids"], existing["documents"]))

    to_delete = [cid for cid in current if cid not in chunks]
    to_embed = [cid for cid, text in chunks.items() if current.get(cid) != text]

    if to_delete:
        collection.delete(ids=to_delete)

    batch_size = 100
    for i in range(0, len(to_embed), batch_size):
        ids = to_embed[i:i + batch_size]
        docs = [chunks[cid] for cid in ids]
        embeddings = [ollama.embeddings(model=EMBED_MODEL, prompt=d)["embedding"] for d in docs]
        collection.upsert(ids=ids, documents=docs, embeddings=embeddings)
        if verbose:
            print(f"Indexed {i + len(ids)}/{len(to_embed)} changed chunk(s)")

    return len(to_embed), len(to_delete)


def main():
    collection = get_or_create_collection()
    embedded, deleted = sync_index(collection, load_snapshot_rows())
    print(f"Done. {embedded} chunk(s) embedded, {deleted} removed. Vector DB saved to", DB_DIR)


if __name__ == "__main__":
    main()
