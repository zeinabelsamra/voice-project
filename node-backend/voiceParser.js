// node-backend/voiceParser.js — Rule-based field extractor v9

function titleCase(s) {
  return s.trim().split(/\s+/).map(word =>
    word.split('-').map(part =>
      part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()
    ).join('-')
  ).join(' ');
}

// ── STOP WORDS (not part of a name) ─────────────────────────────
const STOP_WORDS = /^(room|ward|file|blood|diagnosis|time|date|am|pm|and|with|for|the|is|are|was|positive|negative|rh|routine|stat|units|unit|packed|ffp|platelet|hemodialysis|dialysis|anemia|surgery|trauma|cancer|dr|doctor|nurse|technician|orderly|a|b|o|ab|at|in|on|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirty|fifteen|forty|twenty|today|yesterday|delivery|transfusion|next|new|another|name|number|num)$/i;

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
    .replace(/\.\s+/g, ', ')   // ". " → ", "
    .replace(/\.$/, '')         // trailing period
    .replace(/,\s*,/g, ',')     // double commas
    .trim();
}

// ── TIME → HH:MM (24hr) ──────────────────────────────────────────
function extractTime(text) {
  const t = text.toLowerCase();

  let m = t.match(/\b(\d{1,2})[:\.](\d{2})\s*(am|pm)?\b/);
  if (m) {
    let h = parseInt(m[1]), min = m[2], p = (m[3] || '').toLowerCase();
    if (p === 'pm' && h !== 12) h += 12;
    if (p === 'am' && h === 12) h = 0;
    return String(h).padStart(2, '0') + ':' + min;
  }

  const W = { one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12 };

  m = t.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(thirty|fifteen|forty[\s\-]?five|forty|twenty[\s\-]?five|twenty|ten)?\s*(am|pm)\b/i);
  if (m) {
    let h = W[m[1].toLowerCase()] || 0, min = 0;
    const mw = (m[2] || '').toLowerCase().replace(/[\s\-]/g, '');
    if (mw === 'thirty') min = 30; else if (mw === 'fifteen') min = 15;
    else if (mw === 'fortyfive') min = 45; else if (mw === 'forty') min = 40;
    else if (mw === 'twenty') min = 20; else if (mw === 'ten') min = 10;
    const p = (m[3] || '').toLowerCase();
    if (p === 'pm' && h !== 12) h += 12; if (p === 'am' && h === 12) h = 0;
    return String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
  }

  m = t.match(/(?:^|[\s,])(?:time\s+(?:is\s+)?|at\s+)(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(thirty|fifteen|forty[\s\-]?five|forty|twenty|ten|o'?clock)?\b/i);
  if (m) {
    let h = W[m[1].toLowerCase()] || 0, min = 0;
    const mw = (m[2] || '').toLowerCase().replace(/[\s\-]/g, '');
    if (mw === 'thirty') min = 30; else if (mw === 'fifteen') min = 15;
    else if (mw === 'fortyfive') min = 45; else if (mw === 'forty') min = 40;
    else if (mw === 'twenty') min = 20; else if (mw === 'ten') min = 10;
    return String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
  }

  const W24 = { thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,eighteen:18,nineteen:19 };
  m = t.match(/\b(thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)\s*(thirty|fifteen|forty|twenty|ten|hundred|zero\s*zero)?\b/i);
  if (m) {
    let h = W24[m[1].toLowerCase()] || 0, min = 0;
    const mw = (m[2] || '').toLowerCase().replace(/[\s\-]/g, '');
    if (mw === 'thirty') min = 30; else if (mw === 'fifteen') min = 15;
    else if (mw === 'forty') min = 40; else if (mw === 'twenty') min = 20;
    else if (mw === 'ten') min = 10;
    return String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
  }

  m = t.match(/half\s+past\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)/i);
  if (m) return String(W[m[1].toLowerCase()]).padStart(2, '0') + ':30';
  m = t.match(/quarter\s+past\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)/i);
  if (m) return String(W[m[1].toLowerCase()]).padStart(2, '0') + ':15';

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
  // Handles "patient name Zainab" AND "patient name, Zainab" (comma after name)
  m = raw.match(/patient\s+name[,\s]+(?:is\s+)?([A-Za-z][A-Za-z\s\-\']{1,40})/i);
  if (m) { const n = stopAtKeyword(m[1]); if (n && n.trim().length >= 2) return titleCase(n); }

  // ── Priority 2: "patient [,]? Name" ─────────────────────────────
  m = raw.match(/\bpatient[,\s]+(?:is\s+)?([A-Za-z][A-Za-z\s\-\']{1,40})/i);
  if (m) { const n = stopAtKeyword(m[1]); if (n && n.trim().length >= 2) return titleCase(n); }

  // ── Priority 3: "name [,]? Name" ────────────────────────────────
  // The key fix: allow comma between "name" and the actual name
  m = raw.match(/\bname[,\s]+(?:is\s+)?([A-Za-z][A-Za-z\s\-\']{1,40})/i);
  if (m) { const n = stopAtKeyword(m[1]); if (n && n.trim().length >= 2) return titleCase(n); }

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
    { key:'frbc', label:'Filtered RBC', re:/filtered\s+r\.?[bp]\.?c\.?|filtered\s+packed\s+cells?|f\.?r\.?[bp]\.?c/i },
    { key:'ffp',  label:'FFP',          re:/\bffp\b|fresh\s+frozen\s+plasma/i },
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
  if (hits.length === 0) return results;
  hits.sort((a, b) => a.pos - b.pos);
  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i];
    const segEnd = i + 1 < hits.length ? hits[i + 1].pos : raw.length;
    const segment = raw.slice(hit.end, segEnd).trim();
    const seg = segment.toLowerCase();
    const comp = { key: hit.key, label: hit.label, unit_no: '', blood_group: '', expiry_date: '', notes: '' };
    // Match 7-digit number — also handles "1, 2, 3, 4, 5, 6, 7" (Whisper reads digits aloud)
    const unitM = segment.match(/\b(\d{7})\b/)
               || segment.match(/\b(\d)\s*,\s*(\d)\s*,\s*(\d)\s*,\s*(\d)\s*,\s*(\d)\s*,\s*(\d)\s*,\s*(\d)\b/);
    if (unitM) comp.unit_no = unitM[1].length === 7 ? unitM[1] : unitM.slice(1, 8).join('');
    const bgResult = extractBloodGroup(seg);
    if (bgResult) comp.blood_group = bgResult.bg + (bgResult.rh === 'Pos' ? '+' : bgResult.rh === 'Neg' ? '-' : '');
    const expDate = extractDate(seg);
    if (expDate) comp.expiry_date = expDate;
    results.push(comp);
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

  // ── Destination — multiple trigger patterns ──────────────────────
  // Allow comma OR space after keyword (Whisper inserts periods that normalize to commas)
  let m = raw.match(/(?:destination|send\s+to|deliver\s+to|going\s+to|transfer\s+to)[,\s]+(?:is[,\s]+)?([A-Za-z][A-Za-z\s\-]+?)(?:,|$)/i)
        || raw.match(/\bto\s+(?:hospital\s+)?([A-Z][A-Za-z\s\-]{3,30}?)(?:\s+hospital)?\s*(?:,|$)/);
  if (m) result.ext_destination = titleCase(m[1].trim().replace(/\s+/g, ' '));

  // ── Date & Time ─────────────────────────────────────────────────
  const dateVal = extractDate(t);
  if (dateVal) result.ext_delivery_date = dateVal;
  const timeVal = extractTime(t);
  if (timeVal) result.ext_delivery_hour = timeVal;

  // ── Technician (up to 4-word name) ──────────────────────────────
  m = raw.match(/technician[,\s]+(?:name[,\s]+)?(?:is[,\s]+)?([A-Za-z]+(?:[\s\-][A-Za-z]+){0,3})/i);
  if (m) result.ext_technician_name = titleCase(m[1]);

  // ── Integrity ────────────────────────────────────────────────────
  if (/integrity[,\s]+(?:is[,\s]+)?(?:yes|ok|okay|good|intact|fine|complete|proper|pass)/i.test(t))
    result.ext_integrity = 'yes';
  else if (/integrity[,\s]+(?:is[,\s]+)?(?:no|bad|fail|failed|damaged|broken|compromised|poor)/i.test(t))
    result.ext_integrity = 'no';

  // ── Test checkboxes ──────────────────────────────────────────────
  const allConfirmed = /all\s+tests?\s+(?:confirmed|negative|ok|clear)/i.test(t)
                    || /tests?\s+all\s+(?:confirmed|negative|ok|clear)/i.test(t)
                    || /all\s+(?:confirmed|negative|results?\s+negative)/i.test(t);
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

  // ── TIME ────────────────────────────────────────────────────────
  const timeVal = extractTime(t);
  if (timeVal) {
    if (/life\s+sav/i.test(t)) {
      if (isDelivery) result.ls_time_d = timeVal; else result.ls_time_t = timeVal;
    } else if (isDelivery) result.delivery_time = timeVal;
    else result.request_time = timeVal;
  }

  // ── DATE ────────────────────────────────────────────────────────
  const dateVal = extractDate(t);
  if (dateVal) {
    if (/expir/i.test(t))     result.expiry_date   = dateVal;
    else if (isDelivery)      result.delivery_date = dateVal;
    else                      result.request_date  = dateVal;
  }

  // ── ROOM ────────────────────────────────────────────────────────
  let m = t.match(/\broom\s+([0-9]+\s*[a-z]?)\b/i)
        || t.match(/\bward\s+([0-9]+\s*[a-z]?)\b/i)
        || t.match(/\b(icu|itu|er|nicu|picu|ccu)\b/i);
  if (!m) m = t.match(/\b([0-9]{3,4}[a-z]?)\b/i);
  if (m) {
    const room = (m[1] || m[0]).trim().toUpperCase().replace(/\s+/g, '');
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
  m = t.match(/(?:file|record|id)\s*(?:number|num|#|is)?\s*,?\s*([a-z]?\d{4,8}[a-z]?)/i);
  if (m) {
    let fn = m[1].toUpperCase();
    // If trailing letter is a blood group letter AND followed by positive/negative,
    // strip it from the file number (it belongs to blood group)
    const trailingBG = fn.match(/^(\d+)(A|B|O)$/);
    if (trailingBG && /positive|negative|pos|neg/i.test(t)) {
      fn = trailingBG[1]; // strip the blood group letter
    }
    if (isDelivery) result.d_file_number = fn; else result.file_number = fn;
  }

  // ── BLOOD GROUP + RH ────────────────────────────────────────────
  const bgResult = extractBloodGroup(t);
  if (bgResult) {
    const { bg, rh, fileNumClean } = bgResult;
    // If we found a cleaner file number embedded in the blood group detection, use it
    if (fileNumClean && !result.file_number && !result.d_file_number) {
      if (isDelivery) result.d_file_number = fileNumClean;
      else result.file_number = fileNumClean;
    }
    if (/unit\s+group/i.test(t))       result.blood_unit_group    = bg + (rh === 'Pos' ? '+' : '-');
    else if (/before\s+delivery/i.test(t)) result.patient_bg_delivery = bg + (rh === 'Pos' ? '+' : '-');
    else if (isDelivery) {
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
    if (/pack\s+cells?|packed\s+cells?|filtered\s+packed|prc|prbc|fpc|red\s+cells?/i.test(t)) {
      m = t.match(/(\d+)\s+(?:units?\s+)?(?:of\s+)?(?:pack|packed|filtered|prc|fpc)/i)
        || t.match(/(?:pack|packed|filtered|prc|fpc)[^\d]*(\d+)/i);
      if (m) result.fpc_units = parseInt(m[1]);
    }
    if (/\bffp\b|fresh\s+frozen|plasma/i.test(t)) {
      m = t.match(/(\d+)\s+(?:units?\s+)?(?:of\s+)?(?:ffp|plasma)/i)
        || t.match(/(?:ffp|plasma)[^\d]*(\d+)/i);
      if (m) result.ffp_units = parseInt(m[1]);
    }
    if (/platelet|plt/i.test(t)) {
      m = t.match(/(\d+)\s+(?:units?\s+)?(?:of\s+)?(?:platelet|plt)/i)
        || t.match(/(?:platelet|plt)[^\d]*(\d+)/i);
      if (m) result.plt_units = parseInt(m[1]);
    }
    if (!result.fpc_units) {
      m = t.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:units?\s+(?:of\s+)?)?(?:pack\s+cells?|packed\s+cells?|filtered|prc|fpc|red\s+cells?)/i);
      if (m) result.fpc_units = WORD_NUM[m[1].toLowerCase()] || 1;
    }
    if (!result.ffp_units) {
      m = t.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:units?\s+(?:of\s+)?)?(?:ffp|plasma|fresh\s+frozen)/i);
      if (m) result.ffp_units = WORD_NUM[m[1].toLowerCase()] || 1;
    }
    if (!result.plt_units) {
      m = t.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:units?\s+(?:of\s+)?)?(?:platelet|plt)/i);
      if (m) result.plt_units = WORD_NUM[m[1].toLowerCase()] || 1;
    }
    if (!result.fpc_units && !result.ffp_units && !result.plt_units) {
      m = t.match(/\b(\d+)\s+units?\b/i);
      if (m) result.fpc_units = parseInt(m[1]);
    }
    const cType = /\bstat\b/i.test(t) ? 'Stat'
      : /\broutine\b/i.test(t) ? 'Routine'
      : /pre[\s\-]?op/i.test(t) ? 'Pre-Op 24hrs'
      : null;
    if (cType) {
      if (result.fpc_units !== undefined) result.fpc_type = cType;
      if (result.ffp_units !== undefined) result.ffp_type = cType;
      if (result.plt_units !== undefined) result.plt_type = cType;
    }
  }

  // ── BLOOD UNIT NUMBERS (7 digits) ───────────────────────────────
  const unitNums = [...t.matchAll(/\b(\d{7})\b/g)].map(x => x[1]);
  if (unitNums.length > 0) {
    if (isDelivery) result.blood_unit_numbers = unitNums.join('/');
    else unitNums.slice(0, 8).forEach((u, i) => result[`blood_unit_${i + 1}`] = u);
  }

  // ── PREVIOUS TRANSFUSION (transfusion only) ──────────────────────
  if (!isDelivery) {
    if (/previous\s+transfusion|transfused\s+before|had\s+transfusion/i.test(t))
      result.previous_transfusion = !/no\s+previous|not\s+transfused|never/i.test(t);
    m = t.match(/(?:previous|prior)\s+(?:transfusion\s+)?(?:at|in)\s+([a-z\s]+?)(?:\.|,|$)/i);
    if (m) result.prev_transfusion_place = titleCase(m[1].trim());
    if      (/no\s+reaction/i.test(t))        result.prev_transfusion_reaction = 'None';
    else if (/fever/i.test(t))                result.prev_transfusion_reaction = 'Fever';
    else if (/chill/i.test(t))                result.prev_transfusion_reaction = 'Chills';
    else if (/rash/i.test(t))                 result.prev_transfusion_reaction = 'Rash';
    else if (/hemolysis/i.test(t))            result.prev_transfusion_reaction = 'Hemolysis';
    else if (/allergic\s+reaction/i.test(t))  result.prev_transfusion_reaction = 'Allergic reaction';
  }

  // ── STAFF ────────────────────────────────────────────────────────
  m = raw.match(/(?:dr|doctor|physician)\.?\s+([A-Za-z]+(?:[\s\-][A-Za-z]+)?)/i);
  if (m) {
    const dr = 'Dr. ' + titleCase(m[1]);
    if (/life\s+sav/i.test(t) && isDelivery)  result.ls_physician_d = dr;
    else if (/life\s+sav/i.test(t))            result.ls_physician_t = dr;
    else if (!isDelivery)                       result.physician = dr;
  }
  m = raw.match(/(?:nurse|phlebotomist)\s+(?:name\s+)?(?:is\s+)?([A-Za-z]+(?:[\s\-][A-Za-z]+)?)/i);
  if (m) { if (isDelivery) result.nurse = titleCase(m[1]); else result.phlebotomist = titleCase(m[1]); }
  m = raw.match(/technician\s+(?:name\s+)?(?:is\s+)?([A-Za-z]+(?:[\s\-][A-Za-z]+)?)/i);
  if (m) result.technician = titleCase(m[1]);
  m = raw.match(/orderly\s+(?:name\s+)?(?:is\s+)?([A-Za-z]+(?:[\s\-][A-Za-z]+)?)/i);
  if (m) result.orderly = titleCase(m[1]);
  m = raw.match(/received\s+by\s+([A-Za-z]+(?:[\s\-][A-Za-z]+)?)/i);
  if (m) result.received_by = titleCase(m[1]);

  // ── TYPE OF BLOOD (delivery only) ───────────────────────────────
  if (isDelivery) {
    if (/pack\s+cells?|packed\s+cells?/i.test(t))      result.blood_type_requested = 'Packed Cells';
    else if (/\bffp\b|plasma/i.test(t))                result.blood_type_requested = 'FFP';
    else if (/platelet/i.test(t))                      result.blood_type_requested = 'Platelets';
    m = t.match(/(\d+)\s*(p\.?c\.?|packed\s+cells?)/i);
    if (m)                                             result.type_of_blood = `${m[1]} P.C`;
    else if (/pack\s+cells?|packed\s+cells?/i.test(t)) result.type_of_blood = 'Packed Cells';
    else if (/\bffp\b|fresh\s+frozen/i.test(t))        result.type_of_blood = 'FFP';
    else if (/platelet/i.test(t))                      result.type_of_blood = 'Platelets';
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
  if (/life\s+sav/i.test(t)) {
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
