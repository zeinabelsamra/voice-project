"""
Schema drift audit: compares the ACTUAL columns/values in data_snapshot/
(built by fetch_snapshot.py from whatever DB it's currently pointed at --
the synthetic fixture, or real eDelphyn) against what categories.py
hard-codes (IDENTIFIER_COLS, CATEGORY_KEYWORDS, COMPONENT_MARKERS,
BOOLEAN_FLAG_COLS).

Why this matters: every one of those lists is matched by exact lowercase
string equality (see structured_query.py). If real eDelphyn's column names,
casing, or component spellings differ even slightly from the fixture this
was tuned against, matching breaks SILENTLY -- no error, just wrong/missing
answers -- because a mismatched identifier column stops being excluded from
breakdowns, or a component regex stops matching real values, etc.

Run this any time fetch_snapshot.py pulls from a new/different source
(especially the first time it points at real eDelphyn instead of the test
fixture), BEFORE trusting any chatbot answers against that data.

Usage: venv\\Scripts\\python.exe audit_schema.py
"""

import json
import os
import re

from categories import (
    CATEGORIES, CATEGORY_LABELS, CATEGORY_KEYWORDS, COMPONENT_MARKERS,
    IDENTIFIER_COLS, SNAPSHOT_DIR,
)

BOOLEAN_FLAG_COLS = {"issued", "returned"}  # kept in sync with structured_query.py


def _load(category):
    path = os.path.join(SNAPSHOT_DIR, f"{category}.json")
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def audit_category(category, rows):
    print(f"\n=== {category}  ({CATEGORY_LABELS.get(category, category)}) ===")
    if not rows:
        print("  (empty snapshot -- nothing to audit)")
        return []

    cols = list(rows[0].keys())
    n = len(rows)
    issues = []

    # 1. Every non-identifier, non-date column will end up either (a) an
    #    IDENTIFIER_COLS exclusion, (b) a breakdown/summary column, or (c)
    #    completely ignored if it's high-cardinality and NOT excluded --
    #    that last case is the dangerous one (PII leak into summaries, or a
    #    useless mega-breakdown column).
    for col in cols:
        key = col.strip().lower()
        if key in ("date", "time"):
            continue
        distinct = len(set(str(r.get(col, "")) for r in rows))
        ratio = distinct / n if n else 0
        is_identifier = key in IDENTIFIER_COLS
        if not is_identifier and ratio > 0.5 and distinct > 20:
            issues.append(
                f"  [HIGH CARDINALITY, NOT EXCLUDED] '{col}': {distinct}/{n} distinct "
                f"({ratio:.0%}) but not in IDENTIFIER_COLS -- likely a raw ID/name/free-text "
                f"column that will bloat or leak into breakdowns/summaries. If it identifies "
                f"a person or record, add its lowercased name to IDENTIFIER_COLS."
            )

    # 2. Does this category's own keyword string actually share vocabulary
    #    with its real column names? (Sanity check, not a hard failure --
    #    CATEGORY_KEYWORDS is free-text description, not required to match
    #    column names -- but a total mismatch is worth a human look.)
    kw_words = set(re.findall(r"[a-z]+", CATEGORY_KEYWORDS.get(category, "").lower()))
    col_words = set(re.findall(r"[a-z]+", " ".join(cols).lower()))
    if kw_words and not (kw_words & col_words):
        issues.append(
            f"  [NOTE] CATEGORY_KEYWORDS for '{category}' shares no words with its actual "
            f"column names {cols} -- not necessarily wrong, but worth eyeballing."
        )

    # 3. Component markers: does the actual Component column's real values
    #    get matched by ANY configured pattern? A real eDelphyn spelling
    #    ("PRBC", "SDP", ...) that doesn't match "red|rbc|prc|pack" etc.
    #    means _narrow_by_component silently returns nothing for that
    #    component, and its questions get answered against the WRONG
    #    (unfiltered) rows instead of an error.
    comp_col = next((c for c in cols if c.strip().lower() == "component"), None)
    if comp_col:
        real_values = sorted(set(str(r.get(comp_col, "")).strip() for r in rows if r.get(comp_col)))
        for val in real_values:
            if not any(re.search(pattern, val, re.IGNORECASE) for _, pattern in COMPONENT_MARKERS):
                issues.append(
                    f"  [UNMATCHED COMPONENT VALUE] Component='{val}' matches none of the "
                    f"COMPONENT_MARKERS regexes -- a question naming it won't narrow rows "
                    f"correctly. Add a pattern for it in categories.py."
                )

    print(f"  columns: {cols}")
    print(f"  rows: {n}")
    if issues:
        for i in issues:
            print(i)
    else:
        print("  no issues detected")
    return issues


def main():
    total_issues = 0
    for category in CATEGORIES:
        rows = _load(category)
        if rows is None:
            print(f"\n=== {category} ===\n  (no snapshot file -- run fetch_snapshot.py first)")
            continue
        total_issues += len(audit_category(category, rows))

    print(f"\n{'='*60}")
    if total_issues:
        print(f"{total_issues} potential issue(s) found -- review categories.py against them "
              f"before trusting chatbot answers on this data.")
    else:
        print("No schema drift detected against categories.py's assumptions.")


if __name__ == "__main__":
    main()
