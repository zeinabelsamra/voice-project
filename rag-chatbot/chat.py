"""
Simple RAG chat loop: retrieves the most relevant rows from the Chroma DB
built by ingest.py, then asks a local Ollama model to answer using them.
"""

import os
import chromadb
import ollama
from structured_query import (
    try_exact_count, try_exact_breakdown, try_exact_patient, try_exact_trend,
    _matching_tables, _effective_text,
)
from categories import CATEGORY_LABELS

DB_DIR = os.path.join(os.path.dirname(__file__), "chroma_db")
EMBED_MODEL = "nomic-embed-text"
CHAT_MODEL = "phi3:mini"
COLLECTION_NAME = "bloodbank"
TOP_K = 8


def _matching_categories(question_text):
    """Which eDelphyn category/categories does the question's wording best
    match? Thin wrapper around structured_query's category matching --
    previously this was a separate, duplicated implementation (back when it
    matched Excel filenames), which is exactly how the same bugs ("blood"
    false-matching, typo tolerance) ended up needing to be fixed twice."""
    return [entry["category"] for entry in _matching_tables(question_text)]


def retrieve(collection, question, history=None):
    combined = _effective_text(question, history or [])
    q_embedding = ollama.embeddings(model=EMBED_MODEL, prompt=combined)["embedding"]
    matched_categories = _matching_categories(combined)
    matched_labels = [CATEGORY_LABELS.get(c, c) for c in matched_categories]

    where_document = None
    if len(matched_labels) == 1:
        where_document = {"$contains": matched_labels[0]}
    elif len(matched_labels) > 1:
        where_document = {"$or": [{"$contains": label} for label in matched_labels]}

    results = collection.query(
        query_embeddings=[q_embedding], n_results=TOP_K, where_document=where_document
    )
    docs = results["documents"][0]

    if not docs and where_document:
        # Category filter matched nothing indexed -- fall back to a plain semantic search.
        results = collection.query(query_embeddings=[q_embedding], n_results=TOP_K)
        docs = results["documents"][0]

    return docs


def ask(question, context_rows, exact_fact=None, history=None):
    if exact_fact:
        # Small local models are unreliable at arithmetic -- for count/total
        # questions, report the number computed directly from the raw data
        # instead of letting the model add it up itself.
        return f"Based on the source data: {exact_fact}"

    history_block = ""
    if history:
        turns = [f"{'User' if h.get('role') == 'user' else 'Assistant'}: {h.get('content', '')}" for h in history[-4:]]
        if turns:
            history_block = "Recent conversation (for context on follow-ups like \"do it as bullet points\"):\n" + "\n".join(turns) + "\n\n"

    context = "\n".join(context_rows)
    prompt = f"""You are answering questions about a blood bank's records.
Use ONLY the data rows below to answer. If the answer isn't in the data, say so.

{history_block}Data:
{context}

Question: {question}
Answer:"""
    response = ollama.generate(model=CHAT_MODEL, prompt=prompt)
    return response["response"]


def main():
    client = chromadb.PersistentClient(path=DB_DIR)
    collection = client.get_collection(COLLECTION_NAME)
    history = []

    print("RAG chatbot ready. Type a question (or 'exit').")
    while True:
        question = input("\n> ").strip()
        if question.lower() in ("exit", "quit"):
            break
        rows = retrieve(collection, question, history)
        exact_fact = (
            try_exact_patient(question, history)
            or try_exact_trend(question, history)
            or try_exact_breakdown(question, history)
            or try_exact_count(question, history)
        )
        answer = ask(question, rows, exact_fact, history)
        print("\n" + answer)
        history.append({"role": "user", "content": question})
        history.append({"role": "assistant", "content": answer})
        history = history[-6:]


if __name__ == "__main__":
    main()
