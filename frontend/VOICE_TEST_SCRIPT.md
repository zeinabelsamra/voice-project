# Full Test Script — Transfusion & Delivery Forms

End-to-end walkthrough: voice fill → validation → save (with its safety
checks) → export → edit/view mode → drafts. Everything in Part 1 has been
run against `node-backend/voiceParser.js` directly and confirmed to land
correctly field-by-field, not just eyeballed.

---

## PART 1 — Voice fill (one take each)

Select the tab first, click the mic, read the whole paragraph in one
continuous recording. Keep the sentence order — the parser relies on each
name (nurse/technician/orderly/etc.) being immediately followed by the next
recognized keyword to know where the name ends; reordering can make a name
swallow the next phrase.

### 🩸 Transfusion tab

> Patient name John Miller. File number 117432. Blood group A positive. Room 401A. Diagnosis hemodialysis. Date today. Time 10:30 am. Two units filtered packed cells routine. One unit FFP stat. One unit platelets pre-op 24 hours. Blood unit 2601231, blood unit 2601232, blood unit 2601233, blood unit 2601234, blood unit 2601235, blood unit 2601236, blood unit 2601237, blood unit 2601238. Previous transfusion at Al Rassoul Hospital, no reaction. Nurse Maya Khoury. Doctor Sarah Haddad. Life saving, Doctor Karim Aziz, time 5:00 pm.

Fills 30 fields: Date, Time, Room, Patient Name, File Number, Blood Group, RH, Diagnosis, FPC/FFP/Platelet units + type, all 8 compatible blood units, Previous Transfusion (Yes) + place + reaction, Phlebotomist, Physician, Life Saving Case + its own Physician + Time.

**Then fill by hand** (no voice support): the ✓ checkbox next to each component row; the "Others" component row/units/type/checkbox.

**Check:** "Voice-filled: 30 fields" counter under the form.

### 🚚 Delivery tab

> Patient name Lina Fares. File number I21062. Blood group O positive. Room 1009A. Type of blood requested packed cells, two P.C. Unit group A positive. Blood group before delivery A positive. Allergic to latex. Nurse Maya Khoury. Technician Rami Nasser. Orderly Fadi Choueiri. Received by Grace Abou Jaoude. Date today. Time 2:15 pm. Blood unit 2601231, blood unit 2601663. No leakage. No gas. 250 milliliters. Expiry date, 10 September. 4 degrees. Life saving, Doctor Karim Aziz, time 5:00 pm.

Fills 25 fields: Date, Time, Expiry Date, Room, Patient Name, File Number, Blood Unit Group, Patient Blood Group (Before Delivery), Patient Blood Group + RH, Blood Unit N°, Nurse, Technician, Orderly, Received By, Type of Blood Requested, Type of Blood, Leakage, Gases, Volume, Temperature, Allergies, Life Saving Case + its own Physician + Time.

**Then fill by hand** (no voice support): Similar Names / Isolation / Risk to Fall / Allergy Label checkboxes; Integrity Yes/No radio (Blood Bank section); Pre-Transfusion Safety Card Yes/No radio (Nurse section).

**Check:** "Voice-filled: 25 fields" counter under the form.

⚠️ **Heads up before you save this one:** the script deliberately sets the patient to **O+** and the blood unit to **A+** — those are *incompatible* (O+ recipients can only take O+/O-). That's intentional, see Step 4 below; it's testing the compatibility guard, not a mistake in the script.

---

## PART 2 — Save & its safety checks

### Step 1 — Required-field validation
Before filling anything, click **💾 Save Record** on an empty form. You should see a red **"⚠ Required fields missing: ..."** banner listing exactly:
- Transfusion: Patient Name, File Number, Blood Group, RH Factor, Diagnosis, Physician
- Delivery: Patient Name, File Number, Blood Group, RH Factor, Room/Ward, Type of Blood Requested, Nurse's Name, Blood Unit Numbers, Technician

Now do the voice fills from Part 1 and confirm the banner clears once those fields are filled.

### Step 2 — Save the Transfusion record
Click **💾 Save Record** on the Transfusion form. Should succeed with no warnings (nothing in that script triggers a block).

### Step 3 — Expiry-block check (Delivery)
Before saving Delivery, change **Expiry Date** to a past date, e.g. `2026-01-01`, and click Save. Expect: **"❌ Blood unit expired ... days ago — delivery blocked"** and the save is refused. Then set it back to `10 September` (or any future date) to continue.

### Step 4 — Blood compatibility warning (Delivery)
Click **💾 Save Record** on the Delivery form as filled (O+ patient / A+ unit). Expect a popup showing **Patient: O+ / Unit: A+** with **Cancel** / **Override** buttons.
- Click **Cancel** once, to confirm the save is aborted and no record is created.
- Click Save again, then click **Override** — it will ask you to confirm a second time ("This could be life-threatening") — confirm, and the record should save.

### Step 5 — Duplicate same-day record warning
With the Delivery record already saved once, fill the form again with the **same File Number** (`I21062`) and Save. Expect: **"⚠ A delivery record for ... already exists today ... Save anyway?"** confirm dialog.

### Step 6 — File-number ownership conflict
Change **Patient Name** to something else (e.g. "Wrong Person") but keep **File Number** `I21062`, and Save. Expect: **"❌ File number already assigned to Lina Fares — cannot save"**, blocked. Revert the name and file number to test cleanly.

---

## PART 3 — Lookup, drafts, edit/view, export

### Step 7 — File-number lookup autofill
On either form, type a **File Number** you already saved (`117432` or `I21062`) into that field and tab out (blur). It should auto-suggest/fill the known patient's name and blood group from history.

### Step 8 — Draft auto-save & restore
Start filling a form (a few fields, don't save), then refresh the page. A **"📝 Unsaved draft found"** banner should appear with **Restore** / **Dismiss**. Click Restore and confirm the fields come back; try again and click Dismiss instead and confirm the banner disappears and fields stay empty.

### Step 9 — Edit / View mode
Open a saved record from the recent-records list (or wherever your app surfaces it). It should load in **view mode** (fields read-only, an info bar reading "Viewing record for ..." with **✏️ Edit** / **✕ Close**). Click **Edit** — fields become editable and the Save button changes to **💾 Update Record**. Change one field and update; confirm it persists. Click **✕ Close** to exit view mode.

### Step 10 — Export
On each saved form, click **📄 PDF** and **📝 Word** and confirm the exported file includes every field you filled — including the manual-only checkboxes/radios from Part 1, which only export correctly (per `exportForm.js`) if they were actually clicked.

### Step 11 — Dashboard/analytics reflect the new records
Check the daily/weekly/monthly counters and the recent-records table pick up both new records (transfusion + delivery counts increment, patient names appear in the list).

---

## Notes on the voice parser
Previously, one recording could only fill *either* the regular Physician/Time/Blood-Group fields *or* their Life-Saving/unit-group/before-delivery counterparts — never both — because the parser grabbed the first match found anywhere and routed it based on a keyword ("life saving", "unit group", "before delivery") appearing **anywhere** in the whole recording, not near that specific mention. Fixed in `voiceParser.js` by splitting the transcript at the "life saving" keyword and extracting time/physician separately per half, and by pulling "unit group ___" / "before delivery ___" from their own small windows before searching the rest for the patient's own blood group.

Known remaining gap (not fixed, worked around by script ordering): staff-name fields (nurse/technician/orderly/received-by) capture text until they hit a recognized keyword — if the next word isn't one, the name swallows it. The scripts above avoid this by keeping names adjacent to the next keyword and putting free-text phrases (like "Allergic to latex") away from name mentions.
