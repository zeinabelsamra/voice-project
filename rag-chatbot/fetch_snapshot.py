"""
Fetches live e-Delphyn data from the Node backend's authenticated
/api/dashboard/category-query endpoint (one call per category) and writes
each category to data_snapshot/{category}.json.

Auth: mints its own short-lived JWT using the same JWT_SECRET the Node
backend already signs/verifies tokens with (node-backend/.env) -- no bot
user account needed, requireAuth() in server.js accepts it exactly like a
normal login token.

Run standalone, or via refresh_data.py to also rebuild the vector index.
"""

import os
import json
import time

import jwt
import requests
from dotenv import load_dotenv

from categories import CATEGORIES, SNAPSHOT_DIR

HERE = os.path.dirname(__file__)
NODE_ENV_PATH = os.path.join(HERE, "..", "node-backend", ".env")
load_dotenv(NODE_ENV_PATH)

JWT_SECRET = os.environ.get("JWT_SECRET")
if not JWT_SECRET:
    raise RuntimeError(f"JWT_SECRET not found -- expected it in {NODE_ENV_PATH}")

NODE_API_URL = os.environ.get("NODE_API_URL", "http://localhost:3000")
PAGE_SIZE = 500  # server.js caps category-query at 500 rows/page


def _make_token():
    payload = {
        "userId": 0,
        "username": "rag-chatbot-snapshot",
        "fullName": "RAG Chatbot Snapshot Service",
        "role": "service",
        "department": "BLOOD BANK",
        "exp": int(time.time()) + 300,  # minted fresh each run, only needs to survive one run
    }
    return jwt.encode(payload, JWT_SECRET, algorithm="HS256")


def fetch_category(token, category):
    """Full history, no date bounds -- structured_query.py's exact-count/
    breakdown logic supports questions about any year, so the snapshot
    needs to cover all of it, not just the dashboard's recent window."""
    all_rows = []
    page = 1
    while True:
        resp = requests.post(
            f"{NODE_API_URL}/api/dashboard/category-query",
            headers={"Authorization": f"Bearer {token}"},
            json={"category": category, "page": page, "pageSize": PAGE_SIZE},
            timeout=120,
        )
        resp.raise_for_status()
        data = resp.json()
        rows = data.get("rows", [])
        all_rows.extend(rows)
        total_pages = data.get("totalPages", 1)
        if page >= total_pages or not rows:
            break
        page += 1
    return all_rows


def main():
    os.makedirs(SNAPSHOT_DIR, exist_ok=True)
    token = _make_token()
    for category in CATEGORIES:
        print(f"Fetching {category}...")
        rows = fetch_category(token, category)
        out_path = os.path.join(SNAPSHOT_DIR, f"{category}.json")
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(rows, f, ensure_ascii=False)
        print(f"  {len(rows)} row(s) -> {out_path}")


if __name__ == "__main__":
    main()
