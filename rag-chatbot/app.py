"""
Local web frontend for the RAG chatbot.
Run with: venv\\Scripts\\python.exe app.py
Then open http://127.0.0.1:5000 in a browser.
"""

from flask import Flask, request, jsonify, send_from_directory
import chromadb
from chat import retrieve, ask, DB_DIR, COLLECTION_NAME
from structured_query import (
    try_exact_count, try_exact_breakdown, try_exact_patient, try_exact_trend,
    resolve_patient_reference,
)

app = Flask(__name__, static_folder="static")

client = chromadb.PersistentClient(path=DB_DIR)
collection = client.get_collection(COLLECTION_NAME)


@app.route("/")
def index():
    return send_from_directory("static", "index.html")


@app.route("/api/chat", methods=["POST"])
def chat_api():
    data = request.get_json(force=True)
    question = (data.get("question") or "").strip()
    history = data.get("history") or []
    # Which patient/donor the frontend last resolved a lookup to -- kept
    # OUTSIDE the `history` window it slices to the last few exchanges (see
    # static/index.html) so a name mentioned further back than that isn't
    # lost. Only ever used as a last-resort fallback within
    # resolve_patient_reference, and only for questions that already mention
    # "patient"/"donor" themselves -- see its docstring.
    patient_context = data.get("patientContext")
    if not question:
        return jsonify({"error": "question is required"}), 400

    rows = retrieve(collection, question, history)
    # Patient lookup checked first: it's the most specific and only ever
    # fires when a name/ID was actually named. Trend checked before
    # breakdown: breakdown's own gate is eager enough to intercept trend
    # wording ("increasing", "over time") first with a misleading "no field
    # exists" -- see try_exact_trend's docstring. Breakdown checked before
    # count: a question like "as a total which one" matches both triggers,
    # and "which one" signals the user wants a ranked breakdown, not a bare
    # sum.
    exact_fact = (
        try_exact_patient(question, history, patient_context)
        or try_exact_trend(question, history)
        or try_exact_breakdown(question, history)
        or try_exact_count(question, history)
    )
    answer = ask(question, rows, exact_fact, history)

    matched_patient, _, _, _ = resolve_patient_reference(question, history, patient_context)
    return jsonify({
        "answer": answer,
        "sources": rows,
        "exact_fact": exact_fact,
        # Echoed back so the frontend can keep remembering it across turns
        # even once `history` itself has trimmed the original mention away.
        "patientContext": matched_patient or patient_context,
    })


if __name__ == "__main__":
    # threaded=True: without it, Flask's dev server handles one request at a
    # time -- a couple of questions that fall through to the LLM (each
    # taking 45-80s on this CPU-only phi3:mini) queue up back-to-back
    # instead of running concurrently, so a second question can end up
    # waiting on a first one that has nothing to do with it.
    app.run(host="127.0.0.1", port=5000, debug=False, threaded=True)
