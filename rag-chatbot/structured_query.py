"""
Computes exact counts directly from the live e-Delphyn snapshot (data_snapshot/,
built by fetch_snapshot.py), instead of relying on the LLM to add numbers up
itself (which it does unreliably). Used as a grounding fact injected into the
chat prompt for "how many / total / count" style questions.
"""

import difflib
import json
import os
import re
import pandas as pd

from categories import (
    CATEGORIES, CATEGORY_LABELS, CATEGORY_KEYWORDS, COMPONENT_MARKERS,
    IDENTIFIER_COLS, SNAPSHOT_DIR,
)

STOPWORDS = {
    "how", "many", "what", "was", "were", "the", "in", "of", "for", "a", "an",
    "to", "is", "are", "total", "count", "number", "and", "there", "did",
    # "registered" and "units" appear in most category labels -- treating
    # them as real keywords would let unrelated categories false-match.
    "registered", "units",
    # "blood" is generic domain vocabulary that appears all over the labels
    # and would falsely pull in unrelated categories if treated as a real
    # keyword.
    "blood",
    # Common filler verbs that show up in natural phrasing ("how many
    # requests were made") but carry no data signal -- without this, a
    # leftover "made" gets mistaken for a real (but unmatched) breakdown
    # attribute instead of falling through to a plain count.
    "made",
}

# Boolean status flags, not real categorical breakdown dimensions -- already
# covered by dedicated summary stats (returnedCount/notReturnedCount etc. in
# server.js's excelSummary), so excluded here to avoid a plain count question
# ("how many platelet units were issued") getting wrapped in a near-useless
# "broken down by Issued: 1 (n)" instead of just answering with the count.
BOOLEAN_FLAG_COLS = {"issued", "returned"}

COUNT_TRIGGERS = ("how many", "how much", "total", "count", "number of", "amount of")
# Breakdown questions have too many natural phrasings to list ("most common",
# "top", "which X", "common", "main reason", "distribution of"...) -- rather
# than maintaining a growing keyword list, try_exact_breakdown now just
# checks whether the question actually names a real column (see
# _find_breakdown_column). That's a stronger, self-updating signal: it's
# already required to find a matching category AND a matching column name,
# so a false trigger needs both category wording and column wording to
# coincidentally line up, which is rare.

# Same identifier/high-cardinality columns excluded from ingest.py's summaries
# -- not useful (or appropriate) as a "breakdown by" column either.

# Columns that can identify a single person and are searched by
# try_exact_patient() -- deliberately a *subset* of IDENTIFIER_COLS: those
# are excluded from aggregate breakdowns (privacy -- no "top patients"
# ranking), but a direct, single-record lookup by an exact name/ID someone
# already typed is a different thing and is what this set is for.
PATIENT_LOOKUP_COLS = {"patient", "donor", "patient number"}

# Words that can follow "patient"/"donor" in a question without being part
# of the name/ID being looked up.
PATIENT_LOOKUP_STOPWORDS = {
    "the", "a", "an", "is", "does", "did", "has", "have", "had", "what",
    "who", "blood", "type", "group", "for", "of", "named", "called",
    "name", "id", "record", "records", "details", "info", "information",
    "show", "me", "tell", "about", "patient", "donor", "number", "s",
    # Trend/frequency wording -- a patient-scoped trend question isn't
    # supported (see try_exact_trend, which is category-scoped only), but
    # when that falls through to a "no record found" refusal, these should
    # still be stripped so the message names just the actual person
    # attempted ("Person6 Family6") instead of echoing back a garbled
    # "Person6 Family6 donations increased over time" candidate string.
    "increased", "increasing", "decreased", "decreasing", "trend",
    "trending", "trends", "over", "time", "again",
}

_cache = None


def _singularize(word):
    """Light plural-stripping so "nationalities"/"nationality" and
    "donors"/"donor" match as equals instead of relying on fuzzy-match luck."""
    if word.endswith("ies") and len(word) > 4:
        return word[:-3] + "y"
    if word.endswith("s") and not word.endswith("ss") and len(word) > 3:
        return word[:-1]
    return word


def _keyword_pairs(text):
    """(original, singularized) for each real word in `text`. Keeping both
    forms matters: exact-matching on the singularized form handles
    plurals ("nationalities" == "nationality") cleanly, while fuzzy typo
    matching (see _fuzzy_overlap) needs the ORIGINAL forms -- comparing
    singularized stems made unrelated words look deceptively close (e.g.
    "request" vs "requested" scores 0.875, above the typo cutoff, once
    "requests" gets shortened to "request")."""
    text = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", text)
    words = re.findall(r"[a-zA-Z]+", text.lower())
    return [(w, _singularize(w)) for w in words if w not in STOPWORDS and len(w) > 2]


def _keywords(text):
    """Singularized keyword set, for exact-match comparisons (column names,
    attribute-word bookkeeping) where typo tolerance isn't needed."""
    return {sw for _, sw in _keyword_pairs(text)}


# Words for IDENTIFIER_COLS -- e.g. "patient", "donor" -- describe what a
# record IS, not an attribute someone is asking to break it down by ("patient
# requests" just means requests for patients, it isn't asking to group rows
# by patient name). Without this, a plain count question like "how many
# patient requests" gets misread as demanding a breakdown by an unmatched
# "patient" field and wrongly told no such field exists, instead of just
# answering the count.
IDENTIFIER_KEYWORDS = _keywords(" ".join(IDENTIFIER_COLS))

# Words for COMPONENT_MARKERS (e.g. "platelet", "plasma") name a component
# VALUE that _narrow_by_component already filters rows by -- they aren't an
# unmatched breakdown attribute, so a question like "how many platelet units"
# shouldn't be told "no 'platelet' field exists".
COMPONENT_MARKER_KEYWORDS = _keywords(" ".join(phrase for phrase, _ in COMPONENT_MARKERS))


def _load_all():
    global _cache
    if _cache is not None:
        return _cache
    tables = []
    for category in CATEGORIES:
        path = os.path.join(SNAPSHOT_DIR, f"{category}.json")
        if not os.path.exists(path):
            continue
        with open(path, "r", encoding="utf-8") as f:
            rows = json.load(f)
        if not rows:
            continue
        df = pd.DataFrame(rows)
        date_col = next((c for c in df.columns if c.strip().lower() == "date"), None)
        df["_parsed_date"] = (
            pd.to_datetime(df[date_col], errors="coerce") if date_col else pd.NaT
        )
        tables.append({"category": category, "df": df})
    _cache = tables
    return tables


def _fuzzy_overlap(question_text, target_text):
    """How many words in `question_text` match a word in `target_text`.
    Plurals match exactly via singularization; typos (e.g. "RQUESTS" for
    "REQUESTS") are caught by fuzzy-matching the ORIGINAL word forms only --
    see _keyword_pairs for why singularized forms aren't used here. Cutoff
    sits between real typos we want to catch (patients/pateints=0.875,
    requests/rquests=0.933) and coincidental spelling variants we don't want
    crossing categories (centres/centers=0.857, requested/requests=0.824)."""
    q_pairs = _keyword_pairs(question_text)
    t_pairs = _keyword_pairs(target_text)
    t_singular = {sw for _, sw in t_pairs}
    t_original = [ow for ow, _ in t_pairs]

    count = 0
    for ow, sw in q_pairs:
        if sw in t_singular:
            count += 1
        elif difflib.get_close_matches(ow, t_original, n=1, cutoff=0.86):
            count += 1
    return count


def _narrow_by_component(question_text, tables):
    """If the question names a specific blood component, filter each
    matched category's rows down to just that component. Categories are a
    single unified table now (not sibling files split by component), so
    this filters rows rather than selecting among entries."""
    q_lower = question_text.lower()
    for phrase, pattern in COMPONENT_MARKERS:
        if phrase not in q_lower:
            continue
        narrowed = []
        for entry in tables:
            df = entry["df"]
            comp_col = next((c for c in df.columns if c.strip().lower() == "component"), None)
            if comp_col is None:
                narrowed.append(entry)
                continue
            mask = df[comp_col].astype(str).str.contains(pattern, case=False, regex=True, na=False)
            if mask.any():
                narrowed.append({**entry, "df": df[mask]})
        if narrowed:
            return narrowed
    return tables


def _named_values_in(question_text, df):
    """(col, val) pairs where `val` -- an actual value present in one of
    df's own non-identifier columns -- is named (whole word/phrase) in
    question_text. Shared by _narrow_by_named_value (turns this into a row
    filter) and _matching_tables (also uses it as a category-matching
    SIGNAL in its own right -- see the comment there). Word-boundary
    matched (not bare substring) so a value like "Male" can't falsely match
    inside "female"; length-gated to avoid 1-2 char values (e.g. "0"/"1"
    flags) matching on any short number in the question."""
    q_lower = question_text.lower()
    pairs = []
    for col in df.columns:
        key = col.strip().lower()
        if key in IDENTIFIER_COLS or key in BOOLEAN_FLAG_COLS or key in ("date", "time", "_parsed_date"):
            continue
        for val in df[col].astype(str).str.strip().unique():
            if len(val) >= 3 and re.search(rf"\b{re.escape(val.lower())}\b", q_lower):
                pairs.append((col, val))
    return pairs


def _narrow_by_named_value(question_text, tables):
    """If the question names a specific VALUE that actually appears in one
    of the matched tables' own (non-identifier) columns -- e.g. "clotted"
    for Reason="Clotted" -- filter rows down to just that value. Mirrors
    _narrow_by_component's approach but generalized to any column, not just
    "Component" -- without this, "how many clotted units were wasted"
    silently counted ALL wasted units (ignoring "clotted" entirely) instead
    of just the matching 136, because nothing here previously understood
    that "clotted" refers to a VALUE rather than a column name to filter
    by."""
    narrowed = []
    for entry in tables:
        df = entry["df"]
        pairs = _named_values_in(question_text, df)
        if not pairs:
            narrowed.append(entry)
            continue
        mask = pd.Series(False, index=df.index)
        for col, val in pairs:
            mask = mask | (df[col].astype(str).str.strip() == val)
        narrowed.append({**entry, "df": df[mask]})
    return narrowed


def _category_value_keywords(tables):
    """Singularized keywords for every VALUE (not column name) present in
    these tables' own non-identifier columns -- e.g. "clotted" for
    Reason="Clotted". _attribute_keywords subtracts this out so a named
    VALUE that _narrow_by_named_value already filtered rows by doesn't ALSO
    get flagged as an unmatched attribute/column name (which previously
    made "how many clotted units" and "which month had the most clotted
    units" both wrongly answer "no 'clotted' field exists")."""
    kws = set()
    for entry in tables:
        df = entry["df"]
        for col in df.columns:
            key = col.strip().lower()
            if key in IDENTIFIER_COLS or key in BOOLEAN_FLAG_COLS or key in ("date", "time", "_parsed_date"):
                continue
            for val in df[col].dropna().astype(str).unique():
                kws |= _keywords(val)
    return kws


def _matching_tables(question_text):
    scored = []
    for entry in _load_all():
        target_text = CATEGORY_LABELS.get(entry["category"], entry["category"]) + " " + \
            CATEGORY_KEYWORDS.get(entry["category"], "")
        overlap = _fuzzy_overlap(question_text, target_text)
        if overlap == 0 and _named_values_in(question_text, entry["df"]):
            # No literal category-keyword match, but the question names a
            # real VALUE from this category's own data (e.g. "clotted" only
            # ever appears as a Reason value in the wasted category) -- that
            # counts as a match in its own right. Without this, a
            # value-only question ("what's the group breakdown for clotted
            # units?") scored 0 everywhere and came back with NO matched
            # category at all, which made _effective_text (see below)
            # silently glue on the ENTIRE previous turn as a fallback --
            # including whatever value or year THAT turn happened to name,
            # contaminating this question's narrowing with unrelated terms
            # from a prior, unrelated question.
            overlap = 1
        if overlap > 0:
            scored.append((overlap, entry))
    if not scored:
        return []
    best = max(s for s, _ in scored)
    candidates = [e for s, e in scored if s == best]
    candidates = _narrow_by_component(question_text, candidates)
    return _narrow_by_named_value(question_text, candidates)


def _looks_like_count_question(question):
    q_lower = question.lower().strip()
    if any(t in q_lower for t in COUNT_TRIGGERS):
        return True
    # Typos like "how man" (meant "how many") shouldn't silently skip the
    # exact-count path -- if it opens with "how" it's almost always asking
    # for a quantity in this dataset (counts/totals of units, records, etc).
    first_word = q_lower.split()[0] if q_lower.split() else ""
    return first_word == "how"


def _last_user_message(history):
    for h in reversed(history or []):
        if h.get("role") == "user":
            return h.get("content", "")
    return ""


def _effective_text(question, history):
    """Follow-ups that don't name any real category on their own ("do it as
    bullet points", "what about 2023") carry no signal for matching -- borrow
    the previous question's wording so matching still has something to work
    with. Judged by whether the question actually matches a category by
    itself (via _matching_tables), NOT by word count -- a short but complete
    question ("how many units were wasted?" is 5 words) must never be
    mistaken for a contextless follow-up and get the prior turn prepended."""
    if not _matching_tables(question):
        prior = _last_user_message(history)
        if prior:
            return f"{prior} {question}"
    return question


def _fails_soft(fn):
    """These run unconditionally on every question now (no trigger-phrase
    gate for breakdown), so an edge case in unfamiliar data shouldn't crash
    the request -- fall through to the normal LLM answer instead."""
    def wrapped(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except Exception as e:
            print(f"[{fn.__name__}] failed soft: {e}")
            return None
    wrapped.__name__ = fn.__name__
    return wrapped


@_fails_soft
def try_exact_count(question, history=None):
    if not _looks_like_count_question(question):
        return None

    combined = _effective_text(question, history or [])
    # Prefer a year mentioned in the current question; fall back to one
    # borrowed from the prior turn via `combined`.
    year_match = re.search(r"\b(20\d{2})\b", question) or re.search(r"\b(20\d{2})\b", combined)
    tables = _matching_tables(combined)
    if not tables:
        return None

    total = 0
    details = []
    for entry in tables:
        sub = entry["df"]
        if year_match:
            year = int(year_match.group(1))
            sub = sub[sub["_parsed_date"].dt.year == year]
        n = len(sub)
        total += n
        if n > 0:
            details.append(f"{CATEGORY_LABELS.get(entry['category'], entry['category'])}: {n} record(s)")

    year_note = f" in {year_match.group(1)}" if year_match else ""
    breakdown = f" Breakdown: {'; '.join(details)}" if len(details) > 1 else ""
    return f"{total} record(s){year_note}.{breakdown}"


def _extract_identifier_candidate(question):
    """Text following "patient"/"donor" in the question, with filler words
    stripped -- e.g. "what blood type does patient John Doe have" -> "John
    Doe". Also reports whether it *looks* like an actual name/ID (a
    capitalized word or an alphanumeric token like "PN00045"), as opposed to
    ordinary lowercase wording ("patient requests") that just happens to
    follow the trigger word -- try_exact_patient uses that flag to tell "no
    such patient" apart from "this wasn't a patient-lookup question"."""
    m = re.search(r"\b(patient|donor)\b(.*)", question, re.IGNORECASE)
    if not m:
        return None
    words = re.findall(r"[A-Za-z0-9]+", m.group(2))
    words = [w for w in words if w.lower() not in PATIENT_LOOKUP_STOPWORDS]
    if not words:
        return None
    looks_like_name = any(w[:1].isupper() or any(c.isdigit() for c in w) for w in words)
    return " ".join(words), looks_like_name


def _find_patient_field(question, candidate_cols):
    """Which single column (if any) the question is asking about for a
    matched patient/donor -- e.g. "what blood group does ... have" -> "Group".
    Uses _fuzzy_overlap (typo-tolerant, same machinery _matching_tables uses
    for category names) rather than a plain exact-keyword-set intersection --
    without that, a typo like "nationalityy"/"nationalitty" scores 0 against
    every column and silently falls back to dumping every record instead of
    answering the one field that was actually asked about. Scoped to just
    this patient's own columns, and picks the MOST PRECISE match on a tie
    (score vs. extra unmatched column-keywords) so "Group" wins over "Unit
    Group" for a question that only said "group", rather than whichever
    happened to be iterated first."""
    if not _keywords(question):
        return None
    best_col, best_score, best_extra = None, 0, None
    for col in candidate_cols:
        if col.strip().lower() in PATIENT_LOOKUP_COLS or col.strip().lower() in ("date", "time"):
            continue  # asking "have" about the patient's own name/date isn't a field lookup
        col_kw = _keywords(col)
        if not col_kw:
            continue
        score = _fuzzy_overlap(question, col)
        if score == 0:
            continue
        extra = len(col_kw) - score
        if score > best_score or (score == best_score and (best_extra is None or extra < best_extra)):
            best_col, best_score, best_extra = col, score, extra
    return best_col


# Phrasing that's asking about FREQUENCY ("did they donate more than once")
# rather than a single field's value or the raw record list -- the LLM
# fallback answers these from generic vector-search chunks that don't even
# contain this specific patient's records, so it tends to confidently guess
# wrong (verified: it claimed no evidence of repeat donations for a person
# who has 3 dated donation records right in the snapshot). Answering from
# an exact per-category count instead of the LLM removes that guesswork.
_FREQUENCY_TRIGGERS = (
    r"more than once", r"only once", r"just once", r"multiple times",
    r"how many times", r"how often", r"\bever\b", r"\bagain\b",
)


def _looks_like_frequency_question(question):
    q_lower = question.lower()
    return any(re.search(t, q_lower) for t in _FREQUENCY_TRIGGERS)


def _find_patient_field_by_value(question, raw_rows):
    """When the question names a VALUE instead of the field itself (e.g. "is
    he male or female" instead of "what's his gender"), infer the column
    from what this patient's OWN rows actually contain. Deliberately scoped
    to just those rows' real values (not any value in the whole dataset) so
    a generic word can't falsely claim a field -- and skips ID-ish columns
    (IDENTIFIER_COLS) and 0/1 flag columns (BOOLEAN_FLAG_COLS), plus
    anything under 3 characters, since matching on e.g. "1" would fire on
    almost any question that happens to contain a small number."""
    q_words = set(re.findall(r"[a-z0-9+\-]+", question.lower()))
    if not q_words:
        return None
    votes = {}
    for _, row in raw_rows:
        for col, val in row.items():
            key = col.strip().lower()
            if (
                key in PATIENT_LOOKUP_COLS or key in IDENTIFIER_COLS
                or key in BOOLEAN_FLAG_COLS or key in ("date", "time")
            ):
                continue
            val_str = str(val).strip().lower()
            if len(val_str) >= 3 and val_str in q_words:
                votes[col] = votes.get(col, 0) + 1
    if not votes:
        return None
    return max(votes.items(), key=lambda x: x[1])[0]


def _known_identifier_values():
    values = set()
    for entry in _load_all():
        df = entry["df"]
        for col in df.columns:
            if col.strip().lower() not in PATIENT_LOOKUP_COLS:
                continue
            values |= set(v for v in df[col].dropna().astype(str).str.strip() if v)
    return values


_ORDINAL_WORDS = {
    "first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5,
    "sixth": 6, "seventh": 7, "eighth": 8, "ninth": 9, "tenth": 10,
}


def _extract_page_request(question):
    """Parses pagination wording into (marker, n):
      - ("last", N)  for "last 5"                  -> records[-N:]
      - ("skip", N)  for "skip the first 30..."     -> records[N:]
      - (page_number, page_size) for "second 20"/"first 10" -> that page

    "skip" is checked before the ordinal-word scan below on purpose --
    "skip the FIRST 30" would otherwise match the word "first" and get
    misread as "show page 1 of size 30" (i.e. the exact 30 records the
    question asked to skip), which is a silently WRONG answer rather than
    a missed one.

    "next"/"more" without a number is treated as page 2 of a default-25
    page -- a best-effort guess since nothing here tracks how many were
    actually shown last turn; precise wording ("second 20", "last 5",
    "skip 30") is what actually pages reliably. Returns None if the
    question isn't asking for a specific slice at all."""
    q_lower = question.lower()

    if re.search(r"\blast\b", q_lower):
        size_match = re.search(r"\b(\d{1,3})\b", q_lower)
        return "last", int(size_match.group(1)) if size_match else 25

    skip_match = re.search(r"\bskip\b.*?(\d{1,3})", q_lower)
    if skip_match:
        return "skip", int(skip_match.group(1))

    page_number = None
    for word, n in _ORDINAL_WORDS.items():
        if re.search(rf"\b{word}\b", q_lower):
            page_number = n
            break
    if page_number is None:
        m = re.search(r"\b(\d{1,2})(?:st|nd|rd|th)\b", q_lower)
        if m:
            page_number = int(m.group(1))

    size_match = re.search(r"\b(\d{1,3})\b", q_lower)
    page_size = int(size_match.group(1)) if size_match else None

    if page_number is None and re.search(r"\b(next|more)\b", q_lower):
        page_number = 2
    if page_number is None and page_size is None:
        return None
    return page_number or 1, page_size or 25


# Pronouns that plausibly refer back to a patient/donor named earlier in
# the conversation ("what's HER nationality?", "was HE a donor before?").
# Deliberately narrow and imprecise -- "they"/"his"/etc. can just as easily
# refer to something else entirely (a nurse, a unit), so this only ever
# gets used to OPEN the gate below; whether a patient is actually found
# still depends on history/patient_context resolving to a real match.
_PRONOUNS = {"he", "she", "him", "her", "his", "hers", "they", "them", "their", "theirs"}


def _has_followup_pronoun(question):
    return bool(set(re.findall(r"[a-z]+", question.lower())) & _PRONOUNS)


def _find_matched_identifier(text, lower_map):
    """(matched_value, candidate, looks_like_name) for a name/ID mentioned in
    `text`, or None if nothing in it matches a known patient/donor."""
    extraction = _extract_identifier_candidate(text)
    if not extraction:
        return None
    candidate, looks_like_name = extraction
    if len(candidate) < 3:
        return None
    matched = lower_map.get(candidate.lower())
    if not matched:
        close = difflib.get_close_matches(candidate.lower(), list(lower_map.keys()), n=1, cutoff=0.6)
        matched = lower_map[close[0]] if close else None
    return matched, candidate, looks_like_name


def resolve_patient_reference(question, history=None, patient_context=None):
    """Figures out which patient/donor `question` is about, trying (in
    order): a name/ID stated in the question itself; one implied by
    conversation history (via _effective_text's carry-forward, then by
    scanning prior user turns most-recent-first); and finally
    `patient_context` -- a name the caller remembers independently of
    `history`, for when history has been trimmed for prompt-size reasons
    (the frontend keeps only the last few exchanges -- see
    static/index.html's history.slice(-6) -- so a name mentioned earlier
    than that has already fallen out of what the backend even sees).

    Gated on the CURRENT question containing "patient"/"donor", OR clearly
    asking for another slice of records (_extract_page_request -- e.g. "give
    me the third 20 records"), OR referring back with a pronoun (_PRONOUNS
    -- e.g. "what's HER nationality?") -- all three drop the trigger word
    entirely once a patient is already the obvious subject of the
    conversation. Anything matching none of them returns (None, None,
    False) immediately, so an unrelated question later in the conversation
    ("how many units were wasted?") can never silently inherit a stale
    patient context from three turns ago instead of being treated as the
    plain aggregate question it is -- each of these signals is narrow
    enough that this only ever fires when there's actually a patient in
    play (matched/history/context still all have to succeed below), not on
    every sentence that happens to contain "they" or a number.

    Returns (matched_value_or_None, candidate_text_or_None, looks_like_name,
    looked_like_patient_question). That last flag is True whenever the gate
    opened at all (trigger word, pagination wording, or pronoun) even if
    resolution ultimately failed -- letting a caller tell "this genuinely
    wasn't about a patient" apart from "this WAS about a patient but no one
    could be identified", which matters for deciding whether to stay silent
    (defer to breakdown/count) or actively say "not sure who you mean"
    instead of leaving it to the LLM to guess at an unnamed "they".
    """
    known = _known_identifier_values()
    if not known:
        return None, None, False, False
    lower_map = {v.lower(): v for v in known}

    result = _find_matched_identifier(question, lower_map)
    candidate, looks_like_name = None, False
    if result is not None:
        matched, candidate, looks_like_name = result
        if matched or looks_like_name:
            return matched, candidate, looks_like_name, True

    # Either no trigger word at all, OR "patient"/"donor" was said but
    # followed by ordinary lowercase wording that doesn't look like a name
    # attempt (e.g. "patient REQUESTS are there", "donor DONATIONS this
    # year") -- "patient requests"/"donor donations" are literally this
    # app's own CATEGORY names (see categories.py), not a person reference.
    # Without requiring the SAME pagination/pronoun signal here as the
    # no-trigger-word case, a plain aggregate question like "are patient
    # requests trending up?" would proceed to check history/patientContext
    # and could silently answer about a stale, unrelated patient from
    # earlier in the conversation instead of the whole-category question
    # that was actually asked.
    if not (_extract_page_request(question) or _has_followup_pronoun(question)):
        return None, None, False, False

    # Either "patient"/"donor" was said but nothing nameable followed it
    # (e.g. "the donor above"), or this is bare pagination wording with no
    # trigger word at all (e.g. "the third 20 records") -- either way, a
    # pure follow-up. Recover who was actually being discussed.
    combined = _effective_text(question, history or [])
    if combined != question:
        combined_result = _find_matched_identifier(combined, lower_map)
        if combined_result and combined_result[0]:
            return combined_result[0], candidate, looks_like_name, True

    for h in reversed(history or []):
        if h.get("role") != "user":
            continue
        hist_result = _find_matched_identifier(h.get("content", ""), lower_map)
        if hist_result and hist_result[0]:
            return hist_result[0], candidate, looks_like_name, True

    if patient_context and patient_context.lower() in lower_map:
        return lower_map[patient_context.lower()], candidate, looks_like_name, True

    return None, candidate, looks_like_name, True


@_fails_soft
def try_exact_patient(question, history=None, patient_context=None):
    """Exact single-record lookup for a named patient/donor, run BEFORE the
    breakdown/count paths. The vector DB never sees patient/donor names at
    all (ingest.py only embeds monthly aggregates, and those columns are
    excluded from them -- see IDENTIFIER_COLS), so without this, a question
    naming a real patient falls through to an unrelated aggregate and
    answers it as if it were relevant. This searches the raw per-record
    snapshot directly instead, and reports plainly when no match exists
    rather than letting a different question quietly stand in for it."""
    matched, candidate, looks_like_name, looked_like_patient_question = resolve_patient_reference(
        question, history, patient_context
    )

    if not matched and looks_like_name:
        # The current question itself named someone specific but no such
        # patient/donor exists -- say so now rather than silently falling
        # back to a prior patient and answering about the wrong person.
        return (
            f"No record found for patient/donor '{candidate}'. "
            "It may not exist in the data, or the name/ID may be spelled differently."
        )

    if not matched and looked_like_patient_question:
        # This WAS clearly about some patient ("did THEY donate again?") --
        # just not one anything here could identify. Say so explicitly
        # instead of quietly deferring to breakdown/count/the LLM, which
        # would otherwise answer about an unspecified "they" as if it knew
        # who that was (see chat.py's ask() -- the LLM has no way to know
        # this resolution already failed).
        return "I'm not sure who you're referring to -- could you name the patient or donor?"

    if not matched:
        return None

    # Resolve `matched` to every equivalent identifier for the SAME person --
    # "Patient number" (e.g. "HN00006") only exists as a column in the
    # transfusion category; donors/requests only have the person's NAME in
    # a "Patient"/"Donor" column, never their patient number. Searching on
    # just `matched` therefore only ever found the transfusion rows when
    # looked up by number, silently missing the donor/request records for
    # that same real person -- and any field (Nationality, Gender, City...)
    # that only lives in THOSE categories. Two passes: first find `matched`
    # anywhere, collect whatever OTHER identifier values sit alongside it on
    # those same rows (e.g. the name "Person6  Family6" next to "HN00006"),
    # then re-search using the whole resolved set.
    target_values = {matched}
    for entry in _load_all():
        df = entry["df"]
        id_cols = [c for c in df.columns if c.strip().lower() in PATIENT_LOOKUP_COLS]
        if not id_cols:
            continue
        mask = pd.Series(False, index=df.index)
        for c in id_cols:
            mask = mask | (df[c].astype(str).str.strip() == matched)
        for c in id_cols:
            target_values.update(v for v in df.loc[mask, c].dropna().astype(str).str.strip() if v)

    # Prefer a name (contains a space) over a bare ID for the display label
    # in the response below -- "Person6  Family6" reads better than "HN00006".
    display_name = next((v for v in target_values if " " in v), matched)

    raw_rows = []  # (label, row_dict) -- kept structured so a specific
    # column (e.g. "Group") can be pulled back out below, instead of only
    # ever having pre-joined "col: val, col: val" strings to work with.
    all_cols = set()
    for entry in _load_all():
        df = entry["df"]
        label = CATEGORY_LABELS.get(entry["category"], entry["category"])
        id_cols = [c for c in df.columns if c.strip().lower() in PATIENT_LOOKUP_COLS]
        if not id_cols:
            continue
        mask = pd.Series(False, index=df.index)
        for c in id_cols:
            mask = mask | df[c].astype(str).str.strip().isin(target_values)
        for _, row in df[mask].iterrows():
            row_dict = {
                c: row[c] for c in df.columns
                if c != "_parsed_date" and str(row.get(c, "")).strip() != ""
            }
            raw_rows.append((label, row_dict))
            all_cols.update(row_dict.keys())

    if not raw_rows:
        return None

    # If the question named a specific field ("what blood group does..."),
    # answer just that instead of dumping every record -- someone asking a
    # one-word-answer question doesn't want 45 rows of unrelated columns.
    requested_col = _find_patient_field(question, all_cols) or _find_patient_field_by_value(question, raw_rows)
    if requested_col:
        values = [
            str(row[requested_col]).strip() for _, row in raw_rows
            if requested_col in row and str(row[requested_col]).strip()
        ]
        if values:
            counts = {}
            for v in values:
                counts[v] = counts.get(v, 0) + 1
            if len(counts) == 1:
                return f"{display_name}'s {requested_col}: {values[0]} (consistent across all {len(values)} matching record(s))."
            ranked = sorted(counts.items(), key=lambda x: -x[1])
            breakdown = ", ".join(f"{v} ({n})" for v, n in ranked)
            return f"{display_name}'s {requested_col} varies across {len(values)} record(s): {breakdown}."

    # Frequency question ("did they donate more than once?") -- an exact
    # per-category count, computed directly rather than left to the LLM
    # (which has no access to this patient's specific rows at all -- see
    # _looks_like_frequency_question's docstring for why that goes wrong).
    if not requested_col and _looks_like_frequency_question(question):
        by_category = {}
        for label, _ in raw_rows:
            by_category[label] = by_category.get(label, 0) + 1
        breakdown = ", ".join(f"{label}: {n}" for label, n in sorted(by_category.items(), key=lambda x: -x[1]))
        return f"{display_name} appears in {len(raw_rows)} record(s) total -- {breakdown}."

    records = [
        f"[{label}] " + ", ".join(f"{c}: {v}" for c, v in row.items())
        for label, row in raw_rows
    ]
    total = len(records)

    page = _extract_page_request(question)
    if page:
        marker, n = page
        if marker == "last":
            start = max(0, total - n)
            sliced = records[start:]
        elif marker == "skip":
            start = n
            sliced = records[start:]
        else:
            start = (marker - 1) * n
            sliced = records[start:start + n]
        if not sliced:
            return f"'{display_name}' only has {total} record(s) total -- nothing at position {start + 1} onward."
        return (
            f"Records {start + 1}-{start + len(sliced)} of {total} for '{display_name}':\n"
            + "\n".join(sliced)
        )

    note = f" (showing first 25 of {total})" if total > 25 else ""
    return f"Found {total} record(s) for '{display_name}'{note}:\n" + "\n".join(records[:25])


def _breakdown_column_candidates(tables):
    cols = {}
    for entry in tables:
        for col in entry["df"].columns:
            key = col.strip().lower()
            if key in IDENTIFIER_COLS or key in BOOLEAN_FLAG_COLS or key in ("date", "time", "_parsed_date"):
                continue
            cols[col] = None
    return list(cols.keys())


def _attribute_keywords(question_kw, tables):
    """Question words that aren't just the category name -- the actual
    thing being asked about (e.g. "priority" once "requests" has already
    done its job picking the category)."""
    category_kw = set()
    for entry in tables:
        category_kw |= _keywords(CATEGORY_LABELS.get(entry["category"], entry["category"]))
        category_kw |= _keywords(CATEGORY_KEYWORDS.get(entry["category"], ""))
    value_kw = _category_value_keywords(tables)
    return question_kw - category_kw - IDENTIFIER_KEYWORDS - COMPONENT_MARKER_KEYWORDS - value_kw


def _find_breakdown_column(question_kw, tables):
    # See _attribute_keywords: words that already earned their keep picking
    # the category shouldn't also be allowed to justify a column match on
    # their own -- otherwise a question about an attribute nothing has data
    # for (e.g. "priority" when the matched category has no Priority column)
    # silently gets answered with an unrelated column instead of admitting
    # there's no match.
    attribute_kw = _attribute_keywords(question_kw, tables) or question_kw

    # Column names are the dataset's own headers, not free-text someone
    # could typo -- plain (singularized) exact-set overlap is enough here,
    # no need for _fuzzy_overlap's typo tolerance.
    best_col, best_score = None, 0
    for col in _breakdown_column_candidates(tables):
        score = len(attribute_kw & _keywords(col))
        if score > best_score:
            best_score, best_col = score, col
    return best_col


@_fails_soft
def try_exact_breakdown(question, history=None):
    """For "what are the top reasons / which X is most common" style questions --
    a real value_counts() across ALL matching rows, not the LLM eyeballing a
    handful of sampled chunks (which is where it tends to go wrong). No
    trigger-phrase gate -- see the comment above BREAKDOWN_TRIGGERS."""
    combined = _effective_text(question, history or [])
    year_match = re.search(r"\b(20\d{2})\b", question) or re.search(r"\b(20\d{2})\b", combined)
    tables = _matching_tables(combined)
    if not tables:
        return None

    q_kw = _keywords(combined)
    column = _find_breakdown_column(q_kw, tables)
    if not column:
        # A word beyond the category name was clearly named (e.g. "priority")
        # but matches no real column -- say so plainly instead of silently
        # falling through to the LLM, which tends to grab an unrelated field
        # and confidently mislabel it as the answer.
        attribute_kw = _attribute_keywords(q_kw, tables)
        if attribute_kw:
            available = sorted(_breakdown_column_candidates(tables))
            return (
                f"No '{', '.join(sorted(attribute_kw))}' field exists in this data. "
                f"Available fields: {', '.join(available)}."
            )
        return None

    counts = {}
    total = 0
    for entry in tables:
        sub = entry["df"]
        if year_match:
            year = int(year_match.group(1))
            sub = sub[sub["_parsed_date"].dt.year == year]
        total += len(sub)
        if column not in sub.columns:
            # Matched categories aren't guaranteed to share every column --
            # still count its rows toward the total, just skip its breakdown.
            continue
        for val, n in sub[column].dropna().astype(str).value_counts().items():
            counts[val] = counts.get(val, 0) + int(n)

    if not counts:
        return None

    top = sorted(counts.items(), key=lambda x: -x[1])[:8]
    year_note = f" in {year_match.group(1)}" if year_match else ""
    ranked = ", ".join(f"{rank}. {val} ({n})" for rank, (val, n) in enumerate(top, 1))
    return f"{total} record(s){year_note}, broken down by {column} (most common first): {ranked}"


_TREND_TRIGGERS = (
    r"\btrend", r"\bincreasing\b", r"\bdecreasing\b", r"\bover time\b",
    r"\bby month\b", r"\bmonth over month\b", r"\bmonthly\b", r"\bgrowing\b",
    r"\bdeclining\b", r"\brising\b", r"\bfalling\b",
    r"\b(which|what)\s+month\b", r"\b(which|what)\s+period\b",
)  # \btrend (no trailing \b) deliberately matches trend/trends/trending too


def _looks_like_trend_question(question):
    q_lower = question.lower()
    return any(re.search(t, q_lower) for t in _TREND_TRIGGERS)


@_fails_soft
def try_exact_trend(question, history=None):
    """Month-by-month record counts for a matched category, for questions
    about change OVER TIME ("is wastage increasing or decreasing?") rather
    than a flat categorical breakdown. try_exact_breakdown deliberately
    never offers Date as a breakdown column (one row per exact date isn't a
    meaningful category), so without this, a genuine trend question landed
    on "No 'increasing, decreasing, time' field exists" -- technically true
    (no column is literally named that) but misleading, since it reads as
    "this can't be answered" rather than "this needed a different kind of
    answer". Reports the real chronological counts rather than asserting a
    single "trend" verdict a small, noisy dataset can't really support --
    let the numbers speak and the reader judge the direction."""
    if not _looks_like_trend_question(question):
        return None
    combined = _effective_text(question, history or [])
    tables = _matching_tables(combined)
    if not tables:
        return None

    monthly = {}
    for entry in tables:
        periods = entry["df"]["_parsed_date"].dt.to_period("M")
        for period, count in periods.value_counts(dropna=True).items():
            monthly[period] = monthly.get(period, 0) + int(count)

    if not monthly:
        return None
    ordered = sorted(monthly.items())
    total = sum(n for _, n in ordered)
    series = ", ".join(f"{period}: {n}" for period, n in ordered)
    label = (
        CATEGORY_LABELS.get(tables[0]["category"], tables[0]["category"])
        if len(tables) == 1 else "matching"
    )
    # Highest/lowest month is a precise, answerable fact (unlike "is this
    # trending up" over a small noisy series, which is a judgment call the
    # numbers alone don't settle) -- worth stating directly rather than
    # only handing back the raw series for "which month had the most X"
    # style questions. Ties reported explicitly (all of them) rather than
    # letting max()/min() silently pick one and present it as unique.
    peak_n = max(n for _, n in ordered)
    low_n = min(n for _, n in ordered)
    peak_months = ", ".join(str(p) for p, n in ordered if n == peak_n)
    low_months = ", ".join(str(p) for p, n in ordered if n == low_n)
    peak_note = f" Highest: {peak_months} ({peak_n} each)." if "," in peak_months else f" Highest: {peak_months} ({peak_n})."
    low_note = f" Lowest: {low_months} ({low_n} each)." if "," in low_months else f" Lowest: {low_months} ({low_n})."
    peak_note += low_note
    return (
        f"{total} {label} record(s) by month, chronological order "
        f"(judge the overall direction from the counts): {series}.{peak_note}"
    )
