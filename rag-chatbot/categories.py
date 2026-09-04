"""
Shared category metadata for the eDelphyn-backed snapshot pipeline -- kept in
one place so fetch_snapshot.py, ingest.py, structured_query.py, and chat.py
can't drift out of sync. (The old Excel filename-matching code got the same
bug fixed twice in two places before it was consolidated -- see chat.py's
_matching_categories comment.)
"""

import os

SNAPSHOT_DIR = os.path.join(os.path.dirname(__file__), "data_snapshot")

CATEGORIES = [
    "external_units", "donors", "requests",
    "transfusion", "sent_to_centres", "wasted",
]

CATEGORY_LABELS = {
    "external_units":  "External Units / Donations",
    "donors":          "Registered Donors / Donations",
    "requests":        "Registered Patient Requests",
    "transfusion":     "Units Issued for Transfusion",
    "sent_to_centres": "Units Sent to Other Centres",
    "wasted":          "Wasted / Destroyed Units",
}

# Descriptive keywords per category, matched against question wording the
# same way filenames used to be (see structured_query._fuzzy_overlap).
# Deliberately avoid using real column names here (e.g. "reason",
# "nationality", "department", "destination", "hospital", "expiry", "origin")
# -- structured_query.py subtracts these words out when deciding whether a
# question names an unmatched breakdown attribute, so a column-name word
# living here would make that column silently unmatchable (see
# _attribute_keywords).
CATEGORY_KEYWORDS = {
    "external_units":  "external donations other centres referral bagserial",
    "donors":          "registered donors donations donor donation birth age",
    "requests":        "registered patient requests order form crossmatch",
    "transfusion":     "units issued transfusion patient taken nurse",
    "sent_to_centres": "units sent other centres delivery note referral",
    "wasted":          "wasted destroyed units waste wastage discard",
}

# If a question names one of these, narrow a matched category's rows to
# that component instead of the whole category (see structured_query's
# _narrow_by_component). Patterns mirror node-backend/server.js's
# classifyComponent() -- tune both together if real DES_COMPONENT text
# from eDelphyn turns out to need different matching.
COMPONENT_MARKERS = (
    ("whole blood",     "whole"),
    ("platelet",        "plat"),
    ("plasma",          "plasma|ffp"),
    ("ffp",             "plasma|ffp"),
    ("red blood cell",  "red|rbc|prc|pack"),
    ("red cells",       "red|rbc|prc|pack"),
    ("rbc",             "red|rbc|prc|pack"),
    ("packed cell",     "red|rbc|prc|pack"),
    ("cryoprecipitate", "cryo"),
    ("cryo",            "cryo"),
)

# Columns that identify individuals or are raw IDs -- excluded from
# summaries/breakdowns both for privacy and because they're too
# high-cardinality to summarize.
IDENTIFIER_COLS = {
    "patient", "donor", "patient number", "dob", "sample", "order form",
    "seq", "unit", "bag", "box", "donation", "c.m.",
}
