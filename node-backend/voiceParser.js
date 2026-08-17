// node-backend/voiceParser.js — Rule-based field extractor v9

function titleCase(s) {
  return s.trim().split(/\s+/).map(word =>
    word.split('-').map(part =>
      part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()
    ).join('-')
  ).join(' ');
}

// ── STOP WORDS (not part of a name) ─────────────────────────────
const STOP_WORDS = /^(room|ward|file|blood|diagnosis|time|date|am|pm|and|with|for|the|is|are|was|positive|negative|rh|routine|stat|units|unit|packed|ffp|platelet|hemodialysis|dialysis|anemia|surgery|trauma|cancer|dr|doctor|nurse|technician|orderly|a|b|o|ab|at|in|on|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirty|fifteen|forty|twenty|today|yesterday|delivery|transfusion|next|new|another|name|number|num|destination|hospital|send|going|transfer|component|integrity|expiry|expiration|technician|no|leakage|gas|gases|received|volume|milliliter|milliliters|temperature|degrees|allerg|allergies)$/i;

const WORD_NUM = { one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10 };

// ════════════════════════════════════════════════════════════════
// SHARED DELIVERY DETECTOR
// ════════════════════════════════════════════════════════════════
function detectIsDelivery(text) {
  return /\b(deliver|delivery|technician|orderly|leakage|leak|gases|gas|expiry|expiration|expired|integrity|received\s+by|received|no\s+leakage|no\s+leak|no\s+gas|temperature|degrees|volume|milliliter|allerg|blood\s+unit\s+number|blood\s+unit\s+group|type\s+of\s+blood)\b/i.test(text);
}

function stopAtKeyword(str) {
  const words = str.trim().split(/\s+/);
  const result = [];
  for (const w of words) {
    const clean = w.replace(/[,.\-]/g, '').toLowerCase();
    if (STOP_WORDS.test(clean)) break;
    result.push(w.replace(/[,.]$/g, '').replace(/-$/, ''));
  }
  return result.length > 0 ? result.join(' ') : null;
}

function looksLikeName(str) {
  if (!str || str.trim().length < 2) return false;
  const words = str.trim().split(/\s+/);
  if (!words.every(w => /^[A-Za-z\-\']+$/.test(w))) return false;
  if (words.some(w => STOP_WORDS.test(w.replace(/[\-,\.\']/g, '')))) return false;
  return true;
}

// ── NORMALIZE TRANSCRIPT ─────────────────────────────────────────
// Whisper inserts periods when speaker pauses between fields.
// Convert them to commas so the parser sees natural separators.
function normalizeTranscript(text) {
  return text
    .replace(/\.\s+/g, ', ')                      // ". " → ", "
    .replace(/\.$/, '')                            // trailing period
    .replace(/,\s*,/g, ',')                        // double commas
    .replace(/\bback\s+cells?\b/gi, 'packed cells')   // Whisper mishearings
    .replace(/\bpact\s+cells?\b/gi, 'packed cells')
    .replace(/\bpak\s+cells?\b/gi, 'packed cells')
    .replace(/\bthe\s+clinician\b/gi, 'technician')
    .replace(/\bclinician\b/gi, 'technician')
    .trim();
}

// ── BLOOD UNIT NUMBER EXTRACTOR ──────────────────────────────────
// Handles: solid 7-digit, "1 2 3 4 5 6 7", "one two three four five six seven"
function extractAllUnitNums(t) {
  const DW = { zero:0,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9 };
  const found = [], seen = new Set();
  const add = n => { if (!seen.has(n)) { seen.add(n); found.push(n); } };

  // 1. Solid 7-digit numbers anywhere
  for (const m of t.matchAll(/\b(\d{7})\b/g)) add(m[1]);

  // 2. After "blood unit" keyword: 7 comma/space-separated single digits or 7 word-digits
  for (const m of t.matchAll(/\bblood\s+unit[,\s]+/gi)) {
    const after = t.slice(m.index + m[0].length);
    const dm = after.match(/^(\d)[,\s]+(\d)[,\s]+(\d)[,\s]+(\d)[,\s]+(\d)[,\s]+(\d)[,\s]+(\d)\b/);
    if (dm) { add(dm.slice(1, 8).join('')); continue; }
    const wm = [...after.matchAll(/\b(zero|one|two|three|four|five|six|seven|eight|nine)\b/g)];
    if (wm.length >= 7) { add(wm.slice(0, 7).map(x => DW[x[1]]).join('')); continue; }

    // 3. Whisper often mis-punctuates one dictated 7-digit number into
    // uneven hyphen/comma groups ("33-12-0-45" for "3312045"). Only accept
    // it if stripping separators leaves exactly 7 digits — that keeps this
    // from swallowing an unrelated number that happens to follow.
    const gm = after.match(/^([\d][\d,\-\s]{4,14}\d)\b/);
    if (gm) {
      const stripped = gm[1].replace(/[,\-\s]/g, '');
      if (/^\d{7}$/.test(stripped)) add(stripped);
    }
  }

  return found;
}

// ── TIME → HH:MM (24hr) ──────────────────────────────────────────
function extractTime(text) {
  const W = { one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12 };
  const MIN = { thirty:30,fifteen:15,fortyfive:45,forty:40,twentyfive:25,twenty:20,ten:10 };

  const t = text.toLowerCase()
    .replace(/\b(\d{1,2})(am|pm)\b/g, '$1 $2')  // "3am"→"3 am", "3pm"→"3 pm"
    .replace(/\bp\.?\s*m\.?\b/g, 'pm')
    .replace(/\ba\.?\s*m\.?\b/g, 'am')
    .replace(/\bo'?clock\b/g, '')
    // Whisper repeatedly mishears "4:30 pm" as "for 30 pm" (drops the "4:",
    // hears "for" instead). "for <number> am/pm" is a distinctive enough
    // shape — nobody says that and means anything else — to safely recover
    // as hour 4.
    .replace(/\bfor\s+(\d{1,2})\s+(am|pm)\b/g, '4 $1 $2');

  function applyPeriod(h, p) {
    if (p === 'pm' && h !== 12) h += 12;
    if (p === 'am' && h === 12) h = 0;
    return h;
  }

  // Scan every "am"/"pm" and look at what appears immediately before it
  const apRe = /\b(am|pm)\b/g;
  let ap;
  while ((ap = apRe.exec(t)) !== null) {
    const period = ap[1];
    const before = t.slice(0, ap.index).trimEnd();

    // "3:30 pm" — a real hour is 1-12; anything else is Whisper garbage
    // (e.g. it dropped the "4:" in "4:30 pm" and left a bare "30"), so skip
    // it rather than silently building an invalid time like "42:00".
    let nm = before.match(/\b(\d{1,2})[:\.](\d{2})[,\s]*$/);
    if (nm && parseInt(nm[1]) >= 1 && parseInt(nm[1]) <= 12) return String(applyPeriod(parseInt(nm[1]), period)).padStart(2,'0') + ':' + nm[2];

    // "9 15 am" — Whisper sometimes drops the colon in "9:15 am" and just
    // leaves the hour and minute space-separated. Must check this before the
    // bare-single-number fallback below, or that fallback grabs only the "15"
    // and misreads it as the hour.
    nm = before.match(/\b(\d{1,2})\s+(\d{2})[,\s]*$/);
    if (nm && parseInt(nm[1]) >= 1 && parseInt(nm[1]) <= 12 && parseInt(nm[2]) <= 59) {
      return String(applyPeriod(parseInt(nm[1]), period)).padStart(2,'0') + ':' + nm[2];
    }

    // "3 pm" / "3,pm"
    nm = before.match(/\b(\d{1,2})[,\s]*$/);
    if (nm && parseInt(nm[1]) >= 1 && parseInt(nm[1]) <= 12) return String(applyPeriod(parseInt(nm[1]), period)).padStart(2,'0') + ':00';

    // "three thirty pm" / "three pm"
    nm = before.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)[,\s]*(thirty|fifteen|forty[\s-]?five|forty|twenty[\s-]?five|twenty|ten)?[,\s]*$/i);
    if (nm) {
      let h = W[nm[1].toLowerCase()] || 0;
      const mw = (nm[2] || '').toLowerCase().replace(/[\s-]/g,'');
      h = applyPeriod(h, period);
      return String(h).padStart(2,'0') + ':' + String(MIN[mw] || 0).padStart(2,'0');
    }
  }

  // No am/pm — unambiguous formats only
  let m = t.match(/\b(\d{1,2})[:\.](\d{2})\b/);
  if (m) return String(parseInt(m[1])).padStart(2,'0') + ':' + m[2];

  const W24 = { thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,eighteen:18,nineteen:19 };
  m = t.match(/\b(thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)[,\s]*(thirty|fifteen|forty|twenty|ten)?\b/i);
  if (m) {
    const h = W24[m[1].toLowerCase()] || 0;
    const mw = (m[2]||'').toLowerCase();
    return String(h).padStart(2,'0') + ':' + String(MIN[mw]||0).padStart(2,'0');
  }

  // "hour 3 pm" already caught above; handle "hour three" / "at three" with no am/pm
  m = t.match(/(?:at|hour|time\s*(?:is)?)[,\s]+(\d{1,2})\b/i)
    || t.match(/(?:at|hour|time\s*(?:is)?)[,\s]+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/i);
  if (m) {
    const raw = m[1].toLowerCase();
    const h = W[raw] !== undefined ? W[raw] : parseInt(raw);
    return String(h).padStart(2,'0') + ':00';
  }

  m = t.match(/half\s+past\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)/i);
  if (m) return String(W[m[1].toLowerCase()]).padStart(2,'0') + ':30';
  m = t.match(/quarter\s+past\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)/i);
  if (m) return String(W[m[1].toLowerCase()]).padStart(2,'0') + ':15';

  console.log('⏰ extractTime: no match in:', t.slice(0,150));
  return null;
}

// ── DATE → YYYY-MM-DD ────────────────────────────────────────────
function extractDate(text) {
  const t = text.toLowerCase();
  const today = new Date();
  if (/\b(today|day\s+to\s+day)\b/.test(t)) return today.toISOString().split('T')[0];
  if (/\byesterday\b/.test(t)) {
    const d = new Date(today); d.setDate(d.getDate() - 1);
    return d.toISOString().split('T')[0];
  }
  let m = t.match(/\b(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})\b/);
  if (m) return `${m[3]}-${String(m[2]).padStart(2,'0')}-${String(m[1]).padStart(2,'0')}`;
  const MON = { january:'01',february:'02',march:'03',april:'04',may:'05',june:'06',
    july:'07',august:'08',september:'09',october:'10',november:'11',december:'12' };
  m = t.match(/\b(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december)\b/i);
  if (m) return `${today.getFullYear()}-${MON[m[2].toLowerCase()]}-${String(m[1]).padStart(2,'0')}`;
  m = t.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})\b/i);
  if (m) return `${today.getFullYear()}-${MON[m[1].toLowerCase()]}-${String(m[2]).padStart(2,'0')}`;
  return null;
}

// ════════════════════════════════════════════════════════════════
// PATIENT NAME EXTRACTOR — v9
// Handles Whisper period-separated transcripts like:
// "Patient name, Zainab Al-Samra, file number..."
// ════════════════════════════════════════════════════════════════
function extractPatientName(raw) {
  let m;

  // ── Priority 1: "patient name [,]? Name" ────────────────────────
  // Allow commas inside the name (Whisper pauses between name parts become commas after normalization)
  m = raw.match(/patient\s+name[,\s]+(?:is\s+)?([A-Za-z][A-Za-z\s\-\',]{1,50})/i);
  if (m) { const n = stopAtKeyword(m[1].replace(/,\s*/g, ' ').replace(/\s+/g, ' ').trim()); if (n && n.trim().length >= 2) return titleCase(n); }

  // ── Priority 2: "patient [,]? Name" ─────────────────────────────
  m = raw.match(/\bpatient[,\s]+(?:is\s+)?([A-Za-z][A-Za-z\s\-\',]{1,50})/i);
  if (m) { const n = stopAtKeyword(m[1].replace(/,\s*/g, ' ').replace(/\s+/g, ' ').trim()); if (n && n.trim().length >= 2) return titleCase(n); }

  // ── Priority 3: "name [,]? Name" ────────────────────────────────
  m = raw.match(/\bname[,\s]+(?:is\s+)?([A-Za-z][A-Za-z\s\-\',]{1,50})/i);
  if (m) { const n = stopAtKeyword(m[1].replace(/,\s*/g, ' ').replace(/\s+/g, ' ').trim()); if (n && n.trim().length >= 2) return titleCase(n); }

  // ── Priority 4: "for Name" ───────────────────────────────────────
  m = raw.match(/\bfor\s+([A-Za-z][A-Za-z\s\-\']{2,40})/i);
  if (m) { const n = stopAtKeyword(m[1]); if (n && n.includes(' ')) return titleCase(n); }

  // ── Priority 5: "Mr/Mrs/Ms/Dr Name" ─────────────────────────────
  m = raw.match(/\b(?:Mr|Mrs|Ms|Dr)\.?\s+([A-Za-z][A-Za-z\s\-\']{1,30})/i);
  if (m) { const n = stopAtKeyword(m[1]); if (n && n.trim().length >= 2) return titleCase(n); }

  // ── Priority 6: comma-separated segment fallback ─────────────────
  // "Delivery, Zainab Al-Samra, file number..."
  const segments = raw.split(/,\s*/);
  for (const seg of segments.slice(0, 5)) {
    const s = seg.trim()
      .replace(/^(next\s+patient|patient|delivery|transfusion|name|number)\s*/i, '')
      .trim();
    if (!s || s.length < 2) continue;
    const words = s.split(/\s+/);
    if (words.length >= 1 && words.length <= 4 && looksLikeName(s) && !/\d/.test(s)) {
      return titleCase(s);
    }
  }

  // ── Priority 7: form type word directly before name ──────────────
  m = raw.match(/(?:transfusion|delivery)[,\s]+([A-Za-z][A-Za-z\s\-\']{2,30}?)(?:,|file|room|blood|\d|$)/i);
  if (m) { const n = stopAtKeyword(m[1]); if (n && looksLikeName(n)) return titleCase(n); }

  return null;
}

// ════════════════════════════════════════════════════════════════
// BLOOD GROUP EXTRACTOR — handles split transcripts
// e.g. "3467A. Positive." → Whisper split "AB positive" across segments
// ════════════════════════════════════════════════════════════════
function extractBloodGroup(t) {
  // Standard: "A positive", "AB negative", "O pos"
  let m = t.match(/(?<!\d[\s,])\b(a|b|ab|o)\s+(positive|negative|pos|neg)\b/i);
  if (m) return { bg: m[1].toUpperCase(), rh: /pos/i.test(m[2]) ? 'Pos' : 'Neg' };

  // With symbol: "A+", "O-"
  m = t.match(/(?<!\d[\s,])\b(a|b|ab|o)\s*(\+|\-)\b/);
  if (m) return { bg: m[1].toUpperCase(), rh: m[2] === '+' ? 'Pos' : 'Neg' };

  // "blood group A positive"
  m = t.match(/(?:blood\s+(?:group|type)|type\s+is)\s+(a|b|ab|o)\b/i);
  if (m) {
    const bg = m[1].toUpperCase();
    const rh = /positive|pos|\+/i.test(t) ? 'Pos' : /negative|neg|\-/i.test(t) ? 'Neg' : null;
    return { bg, rh };
  }

  // ── FIX: "Positive" or "Negative" alone after a file number with trailing letter ──
  // e.g. "file number 3467A, Positive" — the A was the blood group, got swallowed
  // Look for file number ending in blood group letter + standalone positive/negative
  m = t.match(/(?:file|record|id)[^,]*,?\s*(\d+)(a|b|o|ab)\s*,?\s*(positive|negative|pos|neg)/i);
  if (m) return { bg: m[2].toUpperCase(), rh: /pos/i.test(m[3]) ? 'Pos' : 'Neg', fileNumClean: m[1] };

  // Standalone "positive"/"negative" after a comma — look backwards for blood group
  // "AB, Positive" or "3467, AB, Positive"
  m = t.match(/\b(a|b|ab|o)\b[^,\d]{0,10},?\s*(positive|negative|pos|neg)\b/i);
  if (m) return { bg: m[1].toUpperCase(), rh: /pos/i.test(m[2]) ? 'Pos' : 'Neg' };

  return null;
}

// ════════════════════════════════════════════════════════════════
// EXT DELIVERY COMPONENT EXTRACTOR
// ════════════════════════════════════════════════════════════════
function extractExtComponents(raw) {
  const results = [];
  const COMP_DEFS = [
    { key:'frbc', label:'Filtered RBC', re:/filtered\s+r\.?[bp]\.?c\.?|filtered\s+packed\s+cells?|f\.?r\.?[bp]\.?c\.?|\bfrbc\b|filtered\s+red\s+blood\s+cells?/i },
    { key:'ffp',  label:'FFP',          re:/\bffp\b|fresh\s+frozen(?:\s+plasma)?|\bplasma\b/i },
    { key:'plt',  label:'Platelets',    re:/\bplatelets?\b|\bplt\b/i },
  ];
  const hits = [];
  for (const def of COMP_DEFS) {
    const re = new RegExp(def.re.source, 'gi');
    let m;
    while ((m = re.exec(raw)) !== null) {
      hits.push({ pos: m.index, end: m.index + m[0].length, key: def.key, label: def.label });
    }
  }

  // Helper to extract unit/blood group/date/notes from a text segment
  function extractCompData(segment) {
    const seg = segment.toLowerCase();
    const comp = { unit_no: '', blood_group: '', expiry_date: '', notes: '' };
    const DW = { zero:0,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9 };

    // 1. Solid 7-digit number
    let unitM = segment.match(/\b(\d{7})\b/);
    if (unitM) {
      comp.unit_no = unitM[1];
    } else {
      // 2. Seven single digits separated by commas or spaces ("3, 4, 5, 6, 7, 8, 9")
      unitM = segment.match(/\b(\d)[,\s]+(\d)[,\s]+(\d)[,\s]+(\d)[,\s]+(\d)[,\s]+(\d)[,\s]+(\d)\b/);
      if (unitM) {
        comp.unit_no = unitM.slice(1, 8).join('');
      } else {
        // 3. Seven word-digits after "unit number" keyword ("one, two, three, four, five, six, seven")
        const uKeyM = seg.match(/unit\s*(?:number|no\.?|#|:)?[,\s]*/i);
        if (uKeyM) {
          const afterKey = seg.slice(uKeyM.index + uKeyM[0].length);
          const wordDigits = [...afterKey.matchAll(/\b(zero|one|two|three|four|five|six|seven|eight|nine)\b/g)];
          if (wordDigits.length >= 7) {
            comp.unit_no = wordDigits.slice(0, 7).map(m => DW[m[1]]).join('');
          }
        }
      }
    }

    const bgResult = extractBloodGroup(seg);
    if (bgResult) comp.blood_group = bgResult.bg + (bgResult.rh === 'Pos' ? '+' : bgResult.rh === 'Neg' ? '-' : '');
    const expDate = extractDate(seg);
    if (expDate) comp.expiry_date = expDate;
    const noteM = segment.match(/\b(?:notes?|remark|comment)\s*[,:\-]?\s*([A-Za-z][A-Za-z0-9\s\-]{1,60}?)(?:,|$)/i);
    if (noteM) comp.notes = noteM[1].trim();
    return comp;
  }

  if (hits.length > 0) {
    hits.sort((a, b) => a.pos - b.pos);
    for (let i = 0; i < hits.length; i++) {
      const hit = hits[i];
      const segEnd = i + 1 < hits.length ? hits[i + 1].pos : raw.length;
      const segment = raw.slice(hit.end, segEnd).trim();
      const data = extractCompData(segment);
      results.push({ key: hit.key, label: hit.label, ...data });
    }
    return results;
  }

  // No component keyword — look for bare 7-digit unit numbers and put them in order
  const bareUnits = [...raw.matchAll(/\bunit\s*(?:number|no\.?|#|:)?\s*:?\s*(\d{7})\b/gi)];
  for (const um of bareUnits) {
    // Extract data from the text following the unit number (up to next "unit" keyword or end)
    const nextUm = raw.indexOf('unit', um.index + um[0].length);
    const segEnd = nextUm !== -1 ? nextUm : raw.length;
    const segment = raw.slice(um.index, segEnd);
    const data = extractCompData(segment);
    if (data.unit_no) results.push({ key: '__bare__', label: '', ...data });
  }

  return results;
}

// ════════════════════════════════════════════════════════════════
// EXT DELIVERY DEDICATED PARSER
// ════════════════════════════════════════════════════════════════
function parseExtDelivery(raw, t) {
  const result = {};

  // ── Patient name ────────────────────────────────────────────────
  const nameVal = extractPatientName(raw);
  if (nameVal) result.ext_patient_name = nameVal;

  // ── Destination — strip commas (Whisper pauses), stop at field keywords ──
  // "hospital" intentionally NOT a stop word — it's part of the destination name
  const DEST_STOP = /^(today|yesterday|date|time|technician|integrity|test|filtered|ffp|platelet|note|unit|patient)$/i;
  let m = raw.match(/(?:destination|send\s+to|deliver\s+to|going\s+to|transfer\s+to)[,\s]+(?:is[,\s]+)?([A-Za-z][A-Za-z\s\-\',]{2,60})/i)
        || raw.match(/\bto\s+(?:hospital\s+)?([A-Za-z][A-Za-z\s\-\',]{3,50}?)(?:\s+hospital)?\s*(?:,|$)/i);
  if (m) {
    const destWords = [];
    for (const w of m[1].replace(/,\s*/g, ' ').replace(/\s+/g, ' ').trim().split(/\s+/)) {
      if (DEST_STOP.test(w.replace(/[.\-']/g, '').toLowerCase())) break;
      destWords.push(w.replace(/[,.]$/g, ''));
    }
    if (destWords.length) result.ext_destination = titleCase(destWords.join(' '));
  }

  // ── Date & Time ─────────────────────────────────────────────────
  const dateVal = extractDate(t);
  if (dateVal) result.ext_delivery_date = dateVal;
  const timeVal = extractTime(t);
  console.log('⏰ timeVal:', timeVal, '| searched in:', t.slice(0, 120));
  if (timeVal) result.ext_delivery_hour = timeVal;

  // ── Technician — allow commas between name parts from Whisper pauses ──
  m = raw.match(/technician[,\s]+(?:name[,\s]+)?(?:is[,\s]+)?([A-Za-z][A-Za-z\s\-\',]{1,50})/i);
  if (m) {
    const n = stopAtKeyword(m[1].replace(/,\s*/g, ' ').replace(/\s+/g, ' ').trim());
    if (n && n.trim().length >= 2) result.ext_technician_name = titleCase(n);
  }

  // ── Integrity ────────────────────────────────────────────────────
  if (/integrity[,\s]+(?:is[,\s]+)?(?:yes|ok|okay|good|intact|fine|complete|proper|pass)/i.test(t))
    result.ext_integrity = 'yes';
  else if (/integrity[,\s]+(?:is[,\s]+)?(?:no|bad|fail|failed|damaged|broken|compromised|poor)/i.test(t))
    result.ext_integrity = 'no';

  // ── Test checkboxes ──────────────────────────────────────────────
  const allConfirmed = /all[,\s]+tests?[,\s]+(?:confirmed|negative|ok|clear)/i.test(t)
                    || /tests?[,\s]+all[,\s]+(?:confirmed|negative|ok|clear)/i.test(t)
                    || /all[,\s]+(?:confirmed|negative|results?[,\s]+negative)/i.test(t);
  if (allConfirmed) {
    ['hiv','hbsag','hcv','hb_core','sts','iat','kell'].forEach(k => { result['ext_test_' + k] = true; });
  } else {
    if (/\bhiv\b/i.test(t))                               result.ext_test_hiv     = true;
    if (/\bhbsag\b|\bhepatitis\s+b\s+surface/i.test(t))   result.ext_test_hbsag   = true;
    if (/\bhcv\b|\bhepatitis\s+c\b/i.test(t))             result.ext_test_hcv     = true;
    if (/\bhb\s+core\b|\bhepatitis\s+b\s+core/i.test(t))  result.ext_test_hb_core = true;
    if (/\bsts\b|\bsyphilis/i.test(t))                    result.ext_test_sts     = true;
    if (/\biat\b|\banti[\s\-]?globulin/i.test(t))         result.ext_test_iat     = true;
    if (/\bkell\b/i.test(t))                              result.ext_test_kell    = true;
  }

  // ── Component rows ───────────────────────────────────────────────
  const extComps = extractExtComponents(raw);
  if (extComps.length > 0) result.ext_components = extComps;

  return result;
}

// ════════════════════════════════════════════════════════════════
// MAIN RULE ENGINE
// ════════════════════════════════════════════════════════════════
function parseWithRules(transcript, formType) {
  // ── Normalize periods → commas (Whisper inserts periods on pauses) ──
  const normalized = normalizeTranscript(transcript);
  const t   = normalized.toLowerCase().trim();
  const raw = normalized.trim();
  const result = {};

  // ── Ext Delivery — dedicated fast-path ───────────────────────
  if (formType === 'ext_delivery') return parseExtDelivery(raw, t);

  console.log('  → Normalized:', normalized);

  // Explicit tab wins. In 'both' mode use keyword detection.
  const isDelivery = formType === 'delivery'
    || (formType !== 'transfusion' && detectIsDelivery(t));

  console.log(`  → isDelivery: ${isDelivery} (formType=${formType})`);

  // ── LIFE-SAVING SEGMENT SPLIT ──────────────────────────────────
  // A single recording can mention a regular time/physician AND a
  // life-saving time/physician ("...Doctor Sarah Haddad... Life saving,
  // Doctor Karim Aziz, 5pm."). Split the transcript at the "life saving"
  // keyword so each half is searched independently instead of letting the
  // first time/doctor found anywhere get stolen by the life-saving branch.
  const lsIdx = t.search(/life[\s-]+sav/i);
  const hasLifeSaving = lsIdx !== -1;
  const tGeneral   = hasLifeSaving ? t.slice(0, lsIdx)   : t;
  const tLS        = hasLifeSaving ? t.slice(lsIdx)      : '';
  const rawGeneral = hasLifeSaving ? raw.slice(0, lsIdx) : raw;
  const rawLS      = hasLifeSaving ? raw.slice(lsIdx)    : '';

  // ── TIME ────────────────────────────────────────────────────────
  const timeGeneral = extractTime(tGeneral);
  if (timeGeneral) {
    if (isDelivery) result.delivery_time = timeGeneral; else result.request_time = timeGeneral;
  }
  if (hasLifeSaving) {
    const timeLS = extractTime(tLS);
    if (timeLS) {
      if (isDelivery) result.ls_time_d = timeLS; else result.ls_time_t = timeLS;
    }
  }

  // ── DATE ────────────────────────────────────────────────────────
  if (isDelivery) {
    // Delivery date: today/yesterday always maps here even if "expiry" is also in text
    if (/\b(today|day\s+to\s+day)\b/i.test(t)) {
      result.delivery_date = new Date().toISOString().split('T')[0];
    } else if (/\byesterday\b/i.test(t)) {
      const _d = new Date(); _d.setDate(_d.getDate() - 1);
      result.delivery_date = _d.toISOString().split('T')[0];
    } else {
      const dateVal = extractDate(t);
      if (dateVal) result.delivery_date = dateVal;
    }
    // Expiry date: extract from segment immediately after "expiry" keyword
    const expSegM = t.match(/expir\w*[,\s]+(.{3,60})/i);
    if (expSegM) {
      const expDate = extractDate(expSegM[1]);
      if (expDate && expDate !== result.delivery_date) result.expiry_date = expDate;
    }
  } else {
    const dateVal = extractDate(t);
    if (dateVal) {
      if (/expir/i.test(t)) result.expiry_date = dateVal;
      else                  result.request_date = dateVal;
    }
  }

  // ── ROOM ────────────────────────────────────────────────────────
  // Whisper can comma/hyphen-split a room number the same way it does file
  // numbers and blood units ("210B" → "2, 10B"); tolerate those separators.
  let m = t.match(/\broom[,\s]+([0-9][0-9,\-\s]{0,6}[0-9]?\s*[a-z]?)\b/i)
        || t.match(/\bward[,\s]+([0-9][0-9,\-\s]{0,6}[0-9]?\s*[a-z]?)\b/i)
        || t.match(/\b(icu|itu|er|nicu|picu|ccu)\b/i);
  if (!m) m = t.match(/\b([0-9]{3,4}[a-z]?)\b/i);
  if (m) {
    const room = (m[1] || m[0]).trim().toUpperCase().replace(/[,\-\s]/g, '');
    if (isDelivery) result.d_room = room; else result.room = room;
  }

  // ── PATIENT NAME ────────────────────────────────────────────────
  const nameVal = extractPatientName(raw);
  if (nameVal) {
    if (isDelivery) result.d_patient_name = nameVal; else result.patient_name = nameVal;
  }

  // ── FILE NUMBER ─────────────────────────────────────────────────
  // v9 fix: also match numbers with trailing letters (e.g. "3467A")
  // but strip the trailing letter if it's a blood group (A/B/O/AB)
  // Whisper sometimes hyphenates, comma-splits, or space-splits a dictated
  // number ("883521" → "88352, 1" or "117-432"); allow those separators
  // and strip them back out. (A wrong capture here still gets caught by
  // the frontend's "needs verification" flag on File Number, so being a
  // bit more permissive is an acceptable trade — see index.html HIGH_RISK_VOICE_LABELS.)
  m = t.match(/(?:file|record|id)\s*(?:number|num|#|is)?\s*,?\s*([a-z]?\d[\d,\-\s]{2,12}\d?[a-z]?)/i);
  if (m) {
    let fn = m[1].replace(/[\-\s,]/g, '').toUpperCase();
    // If trailing letter is a blood group letter AND followed by positive/negative,
    // strip it from the file number (it belongs to blood group)
    const trailingBG = fn.match(/^(\d+)(A|B|O)$/);
    if (trailingBG && /positive|negative|pos|neg/i.test(t)) {
      fn = trailingBG[1]; // strip the blood group letter
    }
    if (isDelivery) result.d_file_number = fn; else result.file_number = fn;
  }

  // ── BLOOD GROUP + RH ────────────────────────────────────────────
  // A single recording can mention up to three blood groups (patient's own,
  // "unit group X", "before delivery X"). Pull "unit group ___" and "before
  // delivery ___" from their own small windows first and strip those windows
  // out, so the leftover text is searched for the patient's own blood group
  // without the other two mentions overwriting it.
  let bgSearchText = t;

  const unitGroupM = t.match(/unit\s+group[,\s]+([^,.]{2,30})/i);
  if (unitGroupM) {
    const bgU = extractBloodGroup(unitGroupM[1]);
    if (bgU) {
      result.blood_unit_group = bgU.bg + (bgU.rh === 'Pos' ? '+' : bgU.rh === 'Neg' ? '-' : '');
      bgSearchText = bgSearchText.replace(unitGroupM[0], ' ');
    }
  }

  const beforeDeliveryM = t.match(/before\s+delivery[,\s]+([^,.]{2,30})/i);
  if (beforeDeliveryM) {
    const bgB = extractBloodGroup(beforeDeliveryM[1]);
    if (bgB) {
      result.patient_bg_delivery = bgB.bg + (bgB.rh === 'Pos' ? '+' : bgB.rh === 'Neg' ? '-' : '');
      bgSearchText = bgSearchText.replace(beforeDeliveryM[0], ' ');
    }
  }

  const bgResult = extractBloodGroup(bgSearchText);
  if (bgResult) {
    const { bg, rh, fileNumClean } = bgResult;
    // If we found a cleaner file number embedded in the blood group detection, use it
    if (fileNumClean && !result.file_number && !result.d_file_number) {
      if (isDelivery) result.d_file_number = fileNumClean;
      else result.file_number = fileNumClean;
    }
    if (isDelivery) {
      result.d_blood_group = bg;
      if (rh) result.d_rh = rh;
    } else {
      result.blood_group = bg;
      if (rh) result.rh_factor = rh;
    }
  }

  // Standalone RH if blood group already found but RH missing
  if (!result.rh_factor && !result.d_rh) {
    if      (/\brh\s*(pos|positive|\+)/i.test(t)) { if (isDelivery) result.d_rh='Pos'; else result.rh_factor='Pos'; }
    else if (/\brh\s*(neg|negative|\-)/i.test(t)) { if (isDelivery) result.d_rh='Neg'; else result.rh_factor='Neg'; }
    // Standalone positive/negative with no blood group letter visible
    else if (/\bpositive\b/i.test(t) && (result.blood_group || result.d_blood_group)) {
      if (isDelivery) result.d_rh = 'Pos'; else result.rh_factor = 'Pos';
    }
    else if (/\bnegative\b/i.test(t) && (result.blood_group || result.d_blood_group)) {
      if (isDelivery) result.d_rh = 'Neg'; else result.rh_factor = 'Neg';
    }
  }

  // ── DIAGNOSIS (transfusion only) ────────────────────────────────
  if (!isDelivery) {
    const DIAGS = [
      ['hemodialysis','Hemodialysis'], ['hemo dialysis','Hemodialysis'],
      ['haemodialysis','Hemodialysis'], ['haemo dialysis','Hemodialysis'],
      ['dialysis','Dialysis'],
      ['anemia','Anemia'], ['anaemia','Anemia'],
      ['hemorrhage','Hemorrhage'], ['haemorrhage','Hemorrhage'], ['bleeding','Hemorrhage'],
      ['surgery','Surgery'], ['operation','Surgery'],
      ['trauma','Trauma'], ['cancer','Cancer'],
      ['leukemia','Leukemia'], ['leukaemia','Leukemia'],
      ['thalassemia','Thalassemia'], ['thalassaemia','Thalassemia'],
      ['sepsis','Sepsis'], ['liver failure','Liver Failure'],
      ['renal failure','Renal Failure'], ['kidney failure','Renal Failure'],
      ['cardiac','Cardiac'], ['heart failure','Cardiac'],
      ['post-op','Post-Op'], ['postop','Post-Op'], ['post op','Post-Op'],
      ['thrombocytopenia','Thrombocytopenia'], ['coagulopathy','Coagulopathy'],
      ['sickle cell','Sickle Cell'], ['gi bleed','GI Bleed'],
      ['hypertension','Hypertension'], ['diabetes','Diabetes'],
      ['pneumonia','Pneumonia'], ['fracture','Fracture'],
      ['appendicitis','Appendicitis'], ['chemotherapy','Chemotherapy'],
      ['stroke','Stroke'], ['covid','COVID'], ['infection','Infection'],
    ];
    for (const [key, label] of DIAGS) {
      if (t.includes(key)) { result.diagnosis = label; break; }
    }
    if (!result.diagnosis) {
      m = t.match(/(?:diagnosis|diagnosed\s+with|dx)\s+(?:is\s+)?([a-z][a-z\s\-]+?)(?:\.|,|$)/i);
      if (m) result.diagnosis = titleCase(m[1].trim());
    }
  }

  // ── BLOOD COMPONENTS (transfusion only) ─────────────────────────
  if (!isDelivery) {
    // Word-number matches run FIRST so "three filtered packed cells" is caught
    // before the digit fallback can grab "24" from "24 hours" later in the text.
    // NOTE: number/units → component keyword allows a comma in between
    // ([,\s]+ instead of \s+) because Whisper turns a natural pause there
    // ("One unit. Filtered packed cells.") into a comma after normalization —
    // without it, the number never links up with its component at all.
    if (/pack\s+cells?|packed\s+cells?|filtered\s+packed|\bfiltered\b|prc|prbc|fpc|red\s+cells?/i.test(t)) {
      m = t.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten)[,\s]+(?:units?[,\s]+(?:of\s+)?)?(?:pack\s+cells?|packed\s+cells?|filtered|prc|fpc|red\s+cells?)/i);
      if (m) result.fpc_units = WORD_NUM[m[1].toLowerCase()] || 1;
      if (!result.fpc_units) {
        // digit before keyword, or digit within the same comma-segment after keyword
        m = t.match(/(\d+)[,\s]+(?:units?[,\s]+)?(?:of\s+)?(?:pack|packed|filtered|prc|fpc)/i)
          || t.match(/(?:pack|packed|filtered|prc|fpc)[^,\d]{0,15}(\d+)/i);
        if (m) result.fpc_units = parseInt(m[1]);
      }
    }
    if (/\bffp\b|fresh\s+frozen|plasma/i.test(t)) {
      m = t.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten)[,\s]+(?:units?[,\s]+(?:of\s+)?)?(?:ffp|plasma|fresh\s+frozen)/i);
      if (m) result.ffp_units = WORD_NUM[m[1].toLowerCase()] || 1;
      if (!result.ffp_units) {
        m = t.match(/(\d+)[,\s]+(?:units?[,\s]+)?(?:of\s+)?(?:ffp|plasma)/i)
          || t.match(/(?:ffp|plasma)[^,\d]{0,15}(\d+)/i);
        if (m) result.ffp_units = parseInt(m[1]);
      }
    }
    if (/platelet|plt/i.test(t)) {
      m = t.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten)[,\s]+(?:units?[,\s]+(?:of\s+)?)?(?:platelet|plt)/i);
      if (m) result.plt_units = WORD_NUM[m[1].toLowerCase()] || 1;
      if (!result.plt_units) {
        m = t.match(/(\d+)[,\s]+(?:units?[,\s]+)?(?:of\s+)?(?:platelet|plt)/i)
          || t.match(/(?:platelet|plt)[^,\d]{0,15}(\d+)/i);
        if (m) result.plt_units = parseInt(m[1]);
      }
    }
    if (!result.fpc_units && !result.ffp_units && !result.plt_units) {
      // Last resort: a bare digit+units with no component name
      m = t.match(/\b(\d{1,2})\s+units?\b/i);
      if (m && parseInt(m[1]) <= 20) result.fpc_units = parseInt(m[1]);
    }
    // Per-component urgency: find each component's position and read the
    // urgency keyword from its own segment, not the whole transcript.
    const COMP_TYPE_DEFS = [
      // \bfiltered\b catches Whisper mishearing "filtered packed cells" as "filtered patterns" etc.
      { key: 'fpc', re: /\bfiltered\b|pack\s*cells?|packed\s*cells?|prc|prbc|fpc|red\s*cells?/i },
      { key: 'ffp', re: /\bffp\b|fresh\s*frozen|plasma/i },
      { key: 'plt', re: /platelet|plt/i },
    ];
    const cHits = [];
    for (const c of COMP_TYPE_DEFS) {
      const mt = new RegExp(c.re.source, 'i').exec(t);
      if (mt) cHits.push({ key: c.key, pos: mt.index, endPos: mt.index + mt[0].length });
    }
    cHits.sort((a, b) => a.pos - b.pos);
    for (let i = 0; i < cHits.length; i++) {
      const hit = cHits[i];
      // Urgency always follows the component name in speech ("3 packed cells STAT").
      // Start segment AT the component keyword — never look back into the previous
      // component's territory, which would bleed its urgency word into this segment.
      const segStart = hit.pos;
      const segEnd   = i + 1 < cHits.length ? cHits[i + 1].pos : t.length;
      const seg = t.slice(segStart, segEnd);
      console.log(`  → [${hit.key}] seg: "${seg.trim()}"`);
      const compType = /\bstat\b/i.test(seg) ? 'Stat'
        : /\broutine\b/i.test(seg) ? 'Routine'
        : /pre[\s\-]?op|pre[\s\-]?operative|preoperative|\b24[\s\-]?hours?\b/i.test(seg) ? 'Pre-Op 24hrs'
        : null;
      if (compType) {
        if (hit.key === 'fpc' && result.fpc_units !== undefined) result.fpc_type = compType;
        else if (hit.key === 'ffp' && result.ffp_units !== undefined) result.ffp_type = compType;
        else if (hit.key === 'plt' && result.plt_units !== undefined) result.plt_type = compType;
      }
    }
  }

  // ── BLOOD UNIT NUMBERS ───────────────────────────────────────────
  const unitNums = extractAllUnitNums(t);
  if (unitNums.length > 0) {
    if (isDelivery) result.blood_unit_numbers = unitNums.join('/');
    else unitNums.slice(0, 8).forEach((u, i) => result[`blood_unit_${i + 1}`] = u);
  }

  // ── PREVIOUS TRANSFUSION (transfusion only) ──────────────────────
  if (!isDelivery) {
    if (/previous\s+transfusion|transfused\s+before|had\s+transfusion/i.test(t))
      result.previous_transfusion = !/no\s+previous|not\s+transfused|never/i.test(t);
    m = t.match(/(?:previous|prior)\s+(?:transfusion\s+)?(?:at|in)\s+([a-z][a-z\s\-\',]{2,40}?)(?:\.|,|$)/i);
    if (m) {
      const PLACE_STOP = /^(fever|chill|rash|no|none|reaction|allergic|dr|doctor|nurse|phlebotomist|and|the|a|an)$/i;
      const placeWords = [];
      for (const w of m[1].trim().split(/\s+/)) {
        if (PLACE_STOP.test(w.replace(/[,.']/g, ''))) break;
        placeWords.push(w.replace(/[,.]$/g, ''));
      }
      if (placeWords.length) result.prev_transfusion_place = titleCase(placeWords.join(' '));
    }
    if      (/no\s+reaction/i.test(t))        result.prev_transfusion_reaction = 'None';
    else if (/fever/i.test(t))                result.prev_transfusion_reaction = 'Fever';
    else if (/chill/i.test(t))                result.prev_transfusion_reaction = 'Chills';
    else if (/rash/i.test(t))                 result.prev_transfusion_reaction = 'Rash';
    else if (/hemolysis/i.test(t))            result.prev_transfusion_reaction = 'Hemolysis';
    else if (/allergic\s+reaction/i.test(t))  result.prev_transfusion_reaction = 'Allergic reaction';
  }

  // ── STAFF ────────────────────────────────────────────────────────
  // Physician mentioned before "life saving" (or the whole transcript if it
  // never says "life saving") is the regular attending physician.
  m = rawGeneral.match(/(?:dr|doctor|physician)\.?[,\s]+([A-Za-z][A-Za-z\s\-\',]{1,50})/i);
  if (m && !isDelivery) {
    const n = stopAtKeyword(m[1].replace(/,\s*/g, ' ').replace(/\s+/g, ' ').trim()) || m[1].trim();
    result.physician = 'Dr. ' + titleCase(n);
  }
  // Physician mentioned at/after "life saving" is the life-saving physician.
  if (hasLifeSaving) {
    m = rawLS.match(/(?:dr|doctor|physician)\.?[,\s]+([A-Za-z][A-Za-z\s\-\',]{1,50})/i);
    if (m) {
      const n = stopAtKeyword(m[1].replace(/,\s*/g, ' ').replace(/\s+/g, ' ').trim()) || m[1].trim();
      const dr = 'Dr. ' + titleCase(n);
      if (isDelivery) result.ls_physician_d = dr; else result.ls_physician_t = dr;
    }
  }
  m = raw.match(/(?:nurse|phlebotomist)[,\s]+(?:name[,\s]+)?(?:is[,\s]+)?([A-Za-z][A-Za-z\s\-\',]{1,50})/i);
  if (m) {
    const n = stopAtKeyword(m[1].replace(/,\s*/g, ' ').replace(/\s+/g, ' ').trim());
    if (n && n.trim().length >= 2) {
      if (isDelivery) result.nurse = titleCase(n); else result.phlebotomist = titleCase(n);
    }
  }
  m = raw.match(/technician[,\s]+(?:name[,\s]+)?(?:is[,\s]+)?([A-Za-z][A-Za-z\s\-\',]{1,50})/i);
  if (m) {
    const n = stopAtKeyword(m[1].replace(/,\s*/g, ' ').replace(/\s+/g, ' ').trim());
    if (n && n.trim().length >= 2) result.technician = titleCase(n);
  }
  m = raw.match(/orderly[,\s]+(?:name[,\s]+)?(?:is[,\s]+)?([A-Za-z][A-Za-z\s\-\',]{1,50})/i);
  if (m) {
    const n = stopAtKeyword(m[1].replace(/,\s*/g, ' ').replace(/\s+/g, ' ').trim());
    if (n && n.trim().length >= 2) result.orderly = titleCase(n);
  }
  m = raw.match(/received[,\s]+by[,\s]+([A-Za-z][A-Za-z\s\-\',]{1,50})/i);
  if (m) {
    const n = stopAtKeyword(m[1].replace(/,\s*/g, ' ').replace(/\s+/g, ' ').trim());
    if (n && n.trim().length >= 2) result.received_by = titleCase(n);
  }

  // ── TYPE OF BLOOD (delivery only) ───────────────────────────────
  if (isDelivery) {
    const isPacked = /pack\s+cells?|packed\s+cells?|\bpieces?\b/i.test(t);
    if (isPacked)                            result.blood_type_requested = 'Packed Cells';
    else if (/\bffp\b|plasma/i.test(t))     result.blood_type_requested = 'FFP';
    else if (/platelet/i.test(t))           result.blood_type_requested = 'Platelets';

    // type_of_blood: digit or word number + packed cells / pieces
    m = t.match(/(\d+)\s*(?:p\.?c\.?|packed\s+cells?|pieces?)/i);
    if (m) {
      result.type_of_blood = `${m[1]} P.C`;
    } else {
      m = t.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:p\.?c\.?|packed\s+cells?|pieces?)/i);
      if (m)            result.type_of_blood = `${WORD_NUM[m[1].toLowerCase()]} P.C`;
      else if (isPacked) result.type_of_blood = 'Packed Cells';
      else if (/\bffp\b|fresh\s+frozen/i.test(t)) result.type_of_blood = 'FFP';
      else if (/platelet/i.test(t))               result.type_of_blood = 'Platelets';
    }
  }

  // ── INTEGRITY (delivery only) ────────────────────────────────────
  if (isDelivery) {
    if      (/no\s+leakage|leakage\s+none|no\s+leak/i.test(t)) result.leakage = 'None';
    else if (/leakage|leak/i.test(t))                           result.leakage = 'Present';
    if      (/no\s+gas|gases?\s+none/i.test(t)) result.gases = 'None';
    else if (/\bgas(es)?\b/i.test(t))           result.gases = 'Present';
    m = t.match(/(\d+)\s*(?:ml|milliliter|cc)/i);
    if (m) result.volume = `${m[1]} mL`;
    m = t.match(/(\d+(?:\.\d+)?)\s*(?:degrees?|°|celsius)/i);
    if (m) result.temperature = parseFloat(m[1]);
    else {
      const W2 = {zero:0,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10};
      m = t.match(/(zero|one|two|three|four|five|six|seven|eight|nine|ten)\s+degrees?/i);
      if (m) result.temperature = W2[m[1].toLowerCase()];
    }
  }

  // ── ALLERGIES (delivery only) ────────────────────────────────────
  if (isDelivery) {
    if (/no\s+allerg|not\s+allerg|no\s+known\s+allerg/i.test(t)) result.allergy_details = 'None';
    else {
      m = t.match(/allerg(?:y|ies|ic)\s+(?:to\s+)?([a-z\s]+?)(?:,|$)/i);
      if (m) result.allergy_details = titleCase(m[1].trim());
    }
  }

  // ── LIFE SAVING ─────────────────────────────────────────────────
  if (/life[\s-]+sav/i.test(t)) {
    if (isDelivery) result.life_saving_d = true; else result.life_saving_t = true;
  }

  return result;
}

// ════════════════════════════════════════════════════════════════
// parseVoiceToFields — main entry point
// ════════════════════════════════════════════════════════════════
async function parseVoiceToFields(transcript, formType) {
  console.log('📋 Rule-based extraction — formType:', formType);
  console.log('📝 Raw transcript:', transcript);
  const fields = parseWithRules(transcript, formType);
  console.log('✅ Extracted fields:', fields);
  return { fields, method: 'rules' };
}

// ════════════════════════════════════════════════════════════════
// SPLIT BATCH TRANSCRIPT
// ════════════════════════════════════════════════════════════════
function splitBatchTranscript(text, defaultFormType) {
  if (!text) return [];

  const SPLIT_TRIGGERS = [
    /next\s+patient/i,
    /patient\s+(?:number\s+)?(?:two|three|four|five|six|seven|eight|nine|ten|\d+)/i,
    /second\s+patient/i,
    /third\s+patient/i,
    /fourth\s+patient/i,
    /new\s+patient/i,
    /another\s+patient/i,
  ];

  const combinedTrigger = new RegExp(
    SPLIT_TRIGGERS.map(r => r.source).join('|'),
    'gi'
  );

  const splitPositions = [];
  let match;
  while ((match = combinedTrigger.exec(text)) !== null) {
    splitPositions.push(match.index);
  }

  if (splitPositions.length === 0) return [];

  const rawSegments = [];
  rawSegments.push(text.slice(0, splitPositions[0]).trim());
  for (let i = 0; i < splitPositions.length; i++) {
    const start = splitPositions[i];
    const end   = i + 1 < splitPositions.length ? splitPositions[i + 1] : text.length;
    let seg = text.slice(start, end).trim();
    seg = seg.replace(combinedTrigger, '').trim();
    rawSegments.push(seg);
  }

  return rawSegments
    .map((raw, i) => {
      if (!raw || raw.length < 5) return null;
      const segIsDelivery = detectIsDelivery(raw);
      return {
        index:            i + 1,
        rawText:          raw,
        detectedFormType: segIsDelivery
          ? 'delivery'
          : (defaultFormType === 'delivery' ? 'delivery' : 'transfusion'),
      };
    })
    .filter(Boolean);
}

module.exports = { parseVoiceToFields, splitBatchTranscript };
