# Setting up the RAG chatbot on a new machine

The chatbot answers questions about blood bank records by pulling a snapshot
from `node-backend`'s API and reasoning over it with a **local, offline**
LLM (Ollama) — nothing here calls out to any cloud AI service.

Two layers of setup, and it matters which one you're missing:

- **Layer 1 (whole system):** `node-backend` has to actually be running and
  able to reach its databases. This isn't specific to the chatbot — it's a
  prerequisite for testing SBB at all.
- **Layer 2 (chatbot-specific):** Ollama + its models + this folder's own
  Python environment.

Steps marked 🌐 below need an internet connection (once). Everything else,
including actually using the chatbot afterward, runs fully offline.

These instructions assume Windows (matches how this was built/tested). On
macOS/Linux, replace `venv\Scripts\python.exe` with `venv/bin/python` and
`venv\Scripts\pip` with `venv/bin/pip`.

---

## Layer 1 — `node-backend` must already be running

1. `node-backend/.env` is not in the repo (it holds DB passwords and a JWT
   secret — never commit it). You need a copy of this file with working
   credentials for:
   - `DB_SERVER`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_PORT` (BloodBankDB)
   - `EDELPHYN_DB_SERVER`, `EDELPHYN_DB_NAME`, `EDELPHYN_DB_USER`,
     `EDELPHYN_DB_PASSWORD`, `EDELPHYN_DB_PORT` (the e-Delphyn/hospital LIS
     database the chatbot's data actually comes from)
   - `JWT_SECRET` (any machine running node-backend needs this — the
     chatbot mints its own short-lived login token using this same secret)

   Having the file isn't enough on its own -- the SQL Server(s) it points
   to also have to be reachable **over the network** from this laptop
   (uses SQL login auth via the `mssql`/`tedious` driver, not Windows
   Integrated Auth, so no extra ODBC driver install is needed, but it does
   need a real network path to the server -- a VPN, hospital LAN, etc.).
2. 🌐 From `node-backend/`: `npm install`, then `node server.js`. It
   should print `Blood Bank server running on http://localhost:3000`.

If this step can't be completed (no DB access, no `.env`, no network path
to the SQL Server), **nothing below will work** — this isn't a
chatbot-specific limitation.

## Layer 2 — the chatbot itself

1. 🌐 **Install Ollama**: https://ollama.com/download
2. 🌐 **Pull the two models it uses** (~3GB total):
   ```
   ollama pull nomic-embed-text
   ollama pull phi3:mini
   ```
3. 🌐 **Set up the Python environment**, from `rag-chatbot/`:
   ```
   python -m venv venv
   venv\Scripts\pip install -r requirements.txt
   ```
4. **Pull the data snapshot and build the local index** (needs
   node-backend running from Layer 1, but no internet):
   ```
   venv\Scripts\python.exe refresh_data.py
   ```
   Re-run this any time the underlying data has changed — it's not automatic.
5. **Start the chatbot**:
   ```
   venv\Scripts\python.exe app.py
   ```
6. Open **http://127.0.0.1:5000** in a browser.

---

## Known limitations worth knowing before testing

- **Local only**: the server binds to `127.0.0.1`, so only the machine
  it's running on can reach it — no one else on the network can test it
  remotely as-is.
- **No authentication** in front of `/api/chat`. Fine for a single person
  testing locally; not something to expose more broadly without adding
  auth first.
- **Not everything is answered from verified data.** Open-ended questions
  fall back to the local LLM, which is visibly marked in the UI with an
  "⚠️ Not verified against records" badge — that badge is the signal for
  which answers are grounded and which are the model's best guess.
