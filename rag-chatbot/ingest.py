"""
Reads each category snapshot in data_snapshot/ (built by fetch_snapshot.py
from live e-Delphyn data), summarizes each by month (instead of embedding
all raw rows, which is too slow on a CPU-only laptop), embeds the summaries
with Ollama (nomic-embed-text), and stores them in a local Chroma vector
database.

Run via refresh_data.py (fetches then ingests), or standalone any time the
snapshot in data_snapshot/ has already been refreshed.
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
        if series.dtype == object or series.nunique() <= 20:
            counts = series.astype(str).value_counts().head(8)
            parts = ", ".join(f"{k}: {v}" for k, v in counts.items())
            lines.append(f"  {col} breakdown: {parts}")
    return "\n".join(lines)


def load_chunks():
    chunks = []
    for category in CATEGORIES:
        path = os.path.join(SNAPSHOT_DIR, f"{category}.json")
        if not os.path.exists(path):
            print(f"Skipping {category}: no snapshot found (run fetch_snapshot.py first)")
            continue
        with open(path, "r", encoding="utf-8") as f:
            rows = json.load(f)
        if not rows:
            print(f"Skipping {category}: snapshot is empty")
            continue

        df = pd.DataFrame(rows)
        date_col = next((c for c in df.columns if c.strip().lower() == "date"), None)
        if date_col is None:
            chunks.append(summarize_group(category, "all records", df))
            print(f"Loaded {category} ({len(rows)} row(s))")
            continue

        dates = pd.to_datetime(df[date_col], errors="coerce")
        periods = dates.dt.to_period("M")
        for period, group_df in df.groupby(periods.fillna(pd.Period("1900-01", freq="M"))):
            label = str(period) if str(period) != "1900-01" else "unknown date"
            chunks.append(summarize_group(category, label, group_df))
        print(f"Loaded {category} ({len(rows)} row(s))")
    return chunks


def main():
    chunks = load_chunks()
    print(f"Total summary chunks to index: {len(chunks)}")

    client = chromadb.PersistentClient(path=DB_DIR)
    if COLLECTION_NAME in [c.name for c in client.list_collections()]:
        client.delete_collection(COLLECTION_NAME)
    collection = client.create_collection(COLLECTION_NAME)

    batch_size = 100
    for i in range(0, len(chunks), batch_size):
        batch = chunks[i:i + batch_size]
        embeddings = [ollama.embeddings(model=EMBED_MODEL, prompt=c)["embedding"] for c in batch]
        ids = [f"row-{i + j}" for j in range(len(batch))]
        collection.add(ids=ids, documents=batch, embeddings=embeddings)
        print(f"Indexed {i + len(batch)}/{len(chunks)}")

    print("Done. Vector DB saved to", DB_DIR)


if __name__ == "__main__":
    main()
