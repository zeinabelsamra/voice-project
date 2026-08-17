"""
Refreshes the chatbot's data end to end: re-fetches the live snapshot from
eDelphyn via the Node backend, then rebuilds the Chroma vector index from it.

Run this by hand whenever you want the chatbot brought up to date, or wire
it into a scheduled task (e.g. Windows Task Scheduler) to run every N
minutes: venv\\Scripts\\python.exe refresh_data.py
"""

import fetch_snapshot
import ingest


def main():
    fetch_snapshot.main()
    ingest.main()


if __name__ == "__main__":
    main()
