"""
Self-verifying regression check for the exact-fact paths in
structured_query.py (count / breakdown), run against WHATEVER is currently
in data_snapshot/ -- the synthetic fixture today, real eDelphyn once
fetch_snapshot.py is pointed at it.

Unlike a hand-written Q&A list (which only ever tests the columns/values
someone thought to write down), this GENERATES questions from the data's
own actual columns and values, then checks the chatbot's answer against a
number computed independently with plain pandas. That makes it meaningful
on real eDelphyn data even though nobody here knows its exact schema or
values in advance -- it only assumes CATEGORY_LABELS/column names in the
snapshot are real, which fetch_snapshot.py already guarantees.

This does NOT test the free-text LLM fallback (phi3:mini) -- there's no
ground truth to check a generated sentence against. It only checks the
paths in structured_query.py that are supposed to be 100% exact. If THOSE
fail on real data, something in categories.py needs updating (see
audit_schema.py) -- the LLM fallback being occasionally imprecise on
open-ended questions is expected and separate from that.

Usage: venv\\Scripts\\python.exe eval_regression.py
"""

import json
import os

import pandas as pd

from categories import CATEGORIES, CATEGORY_LABELS, IDENTIFIER_COLS, SNAPSHOT_DIR
from structured_query import try_exact_count, try_exact_breakdown

BOOLEAN_FLAG_COLS = {"issued", "returned"}
MAX_BREAKDOWN_CARDINALITY = 30  # skip near-unique columns -- not real categoricals


def _load_df(category):
    path = os.path.join(SNAPSHOT_DIR, f"{category}.json")
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8") as f:
        rows = json.load(f)
    if not rows:
        return None
    df = pd.DataFrame(rows)
    date_col = next((c for c in df.columns if c.strip().lower() == "date"), None)
    if date_col:
        df["_parsed_date"] = pd.to_datetime(df[date_col], errors="coerce")
    return df


def check(label, expected, actual_text, extract_number):
    """extract_number: fn(actual_text) -> int, or raises/returns None on parse failure."""
    got = extract_number(actual_text) if actual_text else None
    ok = got == expected
    status = "PASS" if ok else "FAIL"
    print(f"[{status}] {label}")
    if not ok:
        print(f"         expected: {expected}")
        print(f"         got:      {got!r}  (raw: {actual_text!r})")
    return ok


def _leading_int(text):
    import re
    m = re.match(r"\s*(\d+)", text or "")
    return int(m.group(1)) if m else None


def main():
    total, passed = 0, 0

    for category in CATEGORIES:
        df = _load_df(category)
        if df is None:
            print(f"\n=== {category}: no snapshot, skipping ===")
            continue
        label = CATEGORY_LABELS.get(category, category)
        print(f"\n=== {category} ({label}) -- {len(df)} row(s) ===")

        # 1. Plain total count.
        q = f"How many {label} records are there?"
        expected = len(df)
        actual = try_exact_count(q)
        total += 1
        passed += check(f"total count -- \"{q}\"", expected, actual, _leading_int)

        # 2. Year-scoped count, for whichever year actually has the most
        #    rows (most likely to also have SOME in other years, exercising
        #    the filter meaningfully instead of trivially matching the total).
        if "_parsed_date" in df.columns and df["_parsed_date"].notna().any():
            year = df["_parsed_date"].dt.year.value_counts().idxmax()
            year = int(year)
            expected_year = int((df["_parsed_date"].dt.year == year).sum())
            q = f"How many {label} records were there in {year}?"
            actual = try_exact_count(q)
            total += 1
            passed += check(f"year-scoped count -- \"{q}\"", expected_year, actual, _leading_int)

        # 3. Breakdown for each real categorical column.
        for col in df.columns:
            key = col.strip().lower()
            if key in IDENTIFIER_COLS or key in BOOLEAN_FLAG_COLS or key in ("date", "time", "_parsed_date"):
                continue
            distinct = df[col].dropna().astype(str).nunique()
            if distinct == 0 or distinct > MAX_BREAKDOWN_CARDINALITY:
                continue
            top_val, top_n = df[col].dropna().astype(str).value_counts().idxmax(), None
            counts = df[col].dropna().astype(str).value_counts()
            top_val, top_n = counts.idxmax(), int(counts.max())

            q = f"What is the breakdown of {col} for {label}?"
            actual = try_exact_breakdown(q)
            total += 1
            ok = bool(actual) and f"{top_val} ({top_n})" in actual
            status = "PASS" if ok else "FAIL"
            print(f"[{status}] breakdown top value -- \"{q}\"")
            if not ok:
                print(f"         expected top: {top_val} ({top_n})")
                print(f"         got: {actual!r}")
            passed += ok

    print(f"\n{'='*60}")
    print(f"{passed}/{total} checks passed")
    if passed < total:
        print("Failures above point at categories.py needing an update for this "
              "data's real column names/values -- see audit_schema.py for a "
              "structural diff.")


if __name__ == "__main__":
    main()
