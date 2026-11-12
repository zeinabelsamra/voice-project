// Forms — shared state, drafts, form selection, recording, batch mode, field map
// 
// Loaded as a classic script (shared global scope) — see index.html for load order.

// ═══════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════
let mediaRecorder, audioChunks = [];
let activeForm    = 'both';
let tCount = 0, dCount = 0;
let recStartTime  = null;   // ── track when recording started
let recTimerInterval = null; // ── interval for the live timer display

// ── BATCH MODE STATE ──
let batchMode   = false;
let batchQueue  = [];
let batchCursor = 0;

// Live clock
setInterval(() => {
  document.getElementById('clock').textContent =
    new Date().toLocaleTimeString('en-GB', { hour12: false });
}, 1000);

// Check DB/mode status
function checkMode() {
  fetch('http://localhost:3000/mode-check')
    .then(r => r.json())
    .then(d => {
      if (!d.dbReady) document.getElementById('dbBanner').classList.add('show');
    }).catch(() => {});
}

// ═══════════════════════════════════════════════════════
// AUTO-SAVE DRAFT
// ═══════════════════════════════════════════════════════
function collectFormData(formType) {
  const data = { form_type: formType };
  Object.entries(FIELD_MAP).forEach(([key, map]) => {
    if (map.form !== formType) return;
    const el = document.getElementById(map.id);
    if (!el) return;
    if (map.type === 'checkbox') data[key] = el.checked;
    else if (map.type === 'radio') data[key] = el.checked ? el.value : '';
    else data[key] = el.value;
  });
  // Extra Blood Components rows (added via +) beyond each type's first row —
  // omitted entirely when there are none, so isFormEmpty() isn't fooled by
  // an always-present "[]" string.
  if (formType === 'transfusion') {
    const extraComponents = collectExtraTComponents();
    if (extraComponents.length) data.components_json = JSON.stringify(extraComponents);
    const unitEntries = collectTUnitCompEntries();
    if (unitEntries.length) data.blood_unit_entries_json = JSON.stringify(unitEntries);
  }
  if (formType === 'delivery') {
    const extraComponents = collectExtraDComponents();
    if (extraComponents.length) data.d_components_json = JSON.stringify(extraComponents);
  }
  return data;
}

function isFormEmpty(formType) {
  const data = collectFormData(formType);
  return Object.entries(data).every(([k, v]) => k === 'form_type' || !v || v === false);
}

function saveDraft(formType) {
  // Don't save drafts when viewing/editing an existing record
  if (currentEditRecord && currentEditRecord.form_type === formType) return;
  if (isFormEmpty(formType)) return;
  const data = collectFormData(formType);
  data._savedAt = new Date().toISOString();
  localStorage.setItem('draft_' + formType, JSON.stringify(data));
  // Update indicator
  const prefix = formType === 'transfusion' ? 't' : 'd';
  const ind = document.getElementById(prefix + '_draftIndicator');
  if (ind) ind.textContent = '· draft saved ' + new Date().toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });
}

function clearDraft(formType) {
  localStorage.removeItem('draft_' + formType);
  const prefix = formType === 'transfusion' ? 't' : 'd';
  const ind = document.getElementById(prefix + '_draftIndicator');
  if (ind) ind.textContent = '';
  const banner = document.getElementById(prefix + '_draftBanner');
  if (banner) banner.classList.remove('show');
}

function checkDrafts() {
  ['transfusion', 'delivery'].forEach(formType => {
    const raw = localStorage.getItem('draft_' + formType);
    if (!raw) return;
    try {
      const draft = JSON.parse(raw);
      const prefix  = formType === 'transfusion' ? 't' : 'd';
      const name    = draft.patient_name || draft.d_patient_name || '';
      const savedAt = draft._savedAt ? new Date(draft._savedAt).toLocaleString('en-GB') : '';
      const info    = document.getElementById(prefix + '_draftInfo');
      if (info) info.textContent = (name ? 'for ' + name : '') + (savedAt ? ' — saved ' + savedAt : '');
      const banner  = document.getElementById(prefix + '_draftBanner');
      if (banner) banner.classList.add('show');
    } catch {
      localStorage.removeItem('draft_' + formType);
    }
  });
}

function restoreDraft(formType) {
  const raw = localStorage.getItem('draft_' + formType);
  if (!raw) return;
  try {
    const draft  = JSON.parse(raw);
    const prefix = formType === 'transfusion' ? 't' : 'd';
    clearForm(prefix);
    setForm(formType);
    // Rebuild any extra Blood Components rows first, so the FIELD_MAP loop
    // below fills the freshly-rendered first-row inputs (t_fpc_units, ...)
    // instead of ones about to be wiped by a later render.
    if (formType === 'transfusion' && draft.components_json)   applyTComponentsFromJson(draft.components_json);
    if (formType === 'transfusion' && draft.blood_unit_entries_json) applyTUnitComponentsFromJson(draft.blood_unit_entries_json);
    if (formType === 'delivery'    && draft.d_components_json) applyDComponentsFromJson(draft.d_components_json);
    Object.entries(FIELD_MAP).forEach(([key, map]) => {
      if (map.form !== formType) return;
      const el  = document.getElementById(map.id);
      const val = draft[key];
      if (!el || val === undefined) return;
      if (map.type === 'checkbox') el.checked = !!val;
      else if (val) { el.value = String(val); el.classList.add('voice-hit'); setTimeout(() => el.classList.remove('voice-hit'), 1000); }
    });
    refreshAllSignaturePads(); // repaint any restored signature strokes from their hidden inputs
    const banner = document.getElementById(prefix + '_draftBanner');
    if (banner) banner.classList.remove('show');
    const ind = document.getElementById(prefix + '_draftIndicator');
    if (ind) ind.textContent = '· draft restored';
    setStatus('done', '📝 Draft restored!');
  } catch {
    clearDraft(formType);
  }
}

function dismissDraft(formType) {
  clearDraft(formType);
  setStatus('', '🗑 Draft discarded');
}

// Auto-save every 30 seconds
setInterval(() => {
  saveDraft('transfusion');
  saveDraft('delivery');
}, 30000);

// Check for existing drafts on page load
document.addEventListener('DOMContentLoaded', checkDrafts);

// ═══════════════════════════════════════════════════════
// FORM SELECTION
// ═══════════════════════════════════════════════════════
function setForm(form) {
  activeForm = form;
  ['Both','Transfusion','Delivery'].forEach(f => {
    const el = document.getElementById('tab'+f);
    if (el) el.classList.toggle('active', form === f.toLowerCase() || (form === 'both' && f === 'Both'));
  });
  const extDelTab = document.getElementById('tabExtDelivery');
  if (extDelTab) extDelTab.classList.toggle('active', form === 'ext_delivery');
  const cardT = document.getElementById('cardTransfusion');
  const cardD = document.getElementById('cardDelivery');
  if (cardT) cardT.classList.toggle('dimmed', form === 'delivery');
  if (cardD) cardD.classList.toggle('dimmed', form === 'transfusion');
}

// ═══════════════════════════════════════════════════════
// RECORDING — with minimum 2s guard and live timer
// ═══════════════════════════════════════════════════════
async function startRec() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder  = new MediaRecorder(stream);
    audioChunks    = [];
    recStartTime   = Date.now();

    // Start live timer display
    const timerEl = document.getElementById('recTimer');
    timerEl.textContent = '0s';
    timerEl.classList.add('show');
    recTimerInterval = setInterval(() => {
      const s = Math.floor((Date.now() - recStartTime) / 1000);
      timerEl.textContent = s + 's';
    }, 500);

    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };
    mediaRecorder.start(100);
    document.getElementById('btnStart').disabled = true;
    document.getElementById('btnStop').disabled  = false;
    document.getElementById('waveform').classList.add('show');
    setStatus('recording', '🔴 Recording…', true);
  } catch (err) {
    setStatus('', '❌ Mic denied — check browser permissions');
  }
}

function stopTimerDisplay() {
  clearInterval(recTimerInterval);
  recTimerInterval = null;
  const timerEl = document.getElementById('recTimer');
  timerEl.classList.remove('show');
  timerEl.textContent = '0s';
}

// ── Toggle batch mode on/off ──
function toggleBatchMode() {
  batchMode = !batchMode;
  document.getElementById('btnMulti').classList.toggle('active', batchMode);
  document.getElementById('batchBanner').style.display = batchMode ? 'flex' : 'none';
}

async function stopRec() {
  const elapsed = Date.now() - recStartTime;

  stopTimerDisplay();

  // ── Block if less than 2 seconds recorded ──
  if (elapsed < 2000) {
    mediaRecorder.stop();
    mediaRecorder.stream.getTracks().forEach(t => t.stop());
    document.getElementById('btnStart').disabled = false;
    document.getElementById('btnStop').disabled  = true;
    document.getElementById('waveform').classList.remove('show');
    setStatus('warn', '⚠️ Too short — please speak then stop');
    return;
  }

  mediaRecorder.stop();
  mediaRecorder.stream.getTracks().forEach(t => t.stop());
  document.getElementById('btnStart').disabled = false;
  document.getElementById('btnStop').disabled  = true;
  document.getElementById('waveform').classList.remove('show');
  setStatus('processing', batchMode ? '⏳ Analyzing patients…' : '⏳ Analyzing…');

  mediaRecorder.onstop = async () => {
    const fd = new FormData();
    fd.append('audio', new Blob(audioChunks, { type:'audio/webm' }), 'recording.webm');
    fd.append('form_type', activeForm);
    document.getElementById('overlay').classList.add('show');

    try {
      // ── BATCH MODE ──
      if (batchMode) {
        const res  = await fetch('http://localhost:3000/upload/batch', { method:'POST', body:fd, headers:{'Authorization':'Bearer '+getToken()} });
        const data = await res.json();
        document.getElementById('overlay').classList.remove('show');
        if (data.error) { setStatus('', '❌ ' + data.error); return; }
        showTranscript(data.text);
        if (data.text === 'No speech detected' || !data.patients || data.patients.length === 0) {
          setStatus('done', '✅ No speech detected — try again'); return;
        }
        const n = data.patients.length;
        setStatus('done', '👥 ' + n + ' patient' + (n > 1 ? 's' : '') + ' detected');
        startBatchQueue(data.patients);
        return;
      }

      // ── SINGLE MODE ──
      const res  = await fetch('http://localhost:3000/upload', { method:'POST', body:fd, headers:{'Authorization':'Bearer '+getToken()} });
      const data = await res.json();
      document.getElementById('overlay').classList.remove('show');
      if (data.error) { setStatus('', '❌ ' + data.error); return; }
      showTranscript(data.text);

      // ── No speech guard ──
      if (!data.text || data.text === 'No speech detected' || data.word_count === 0) {
        setStatus('done', '✅ No speech detected — try again');
        return;
      }

      if (data.fields && Object.keys(data.fields).length > 0) {
        if (activeForm === 'ext_delivery') {
          fillExtFields(data.fields);
          setStatus('done', '✅ ' + Object.keys(data.fields).length + ' fields filled (ext. delivery)');
        } else {
          // Detect which form to fill when in 'both' mode
          const hasDeliveryFields = Object.keys(data.fields).some(k =>
            ['d_patient_name','d_file_number','d_blood_group','d_rh','d_room',
             'delivery_time','delivery_date','leakage','gases','temperature',
             'volume','technician','orderly','nurse','received_by',
             'd_fpc_units','d_ffp_units','d_plt_units','blood_unit_numbers','allergy_details'].includes(k)
          );
          const detectedForm = hasDeliveryFields ? 'delivery' : 'transfusion';
          fillFields(data.fields, activeForm === 'both' ? detectedForm : activeForm);
          setStatus('done', '✅ ' + Object.keys(data.fields).length + ' fields filled (' + detectedForm + ')');
        }
      } else {
        setStatus('done', '✅ Done — no fields detected');
      }
    } catch (err) {
      document.getElementById('overlay').classList.remove('show');
      setStatus('', '❌ Server error: ' + err.message);
    }
  };
}

// ════════════════════════════════════════════════════════════════
// BATCH QUEUE LOGIC
// ════════════════════════════════════════════════════════════════
function startBatchQueue(patients) {
  batchQueue  = patients;
  batchCursor = 0;
  document.getElementById('batchQueue').style.display = 'block';
  renderBatchPatient();
}

function renderBatchPatient() {
  const p     = batchQueue[batchCursor];
  const total = batchQueue.length;

  document.getElementById('bqTitle').textContent = 'Patient ' + (batchCursor + 1) + ' of ' + total;

  const badge = document.getElementById('bqFormBadge');
  badge.textContent = p.formType === 'delivery' ? 'Delivery' : 'Transfusion';
  badge.className   = 'bq-form-badge ' + (p.formType === 'delivery' ? 'delivery' : 'transfusion');

  const dotsEl = document.getElementById('bqDots');
  dotsEl.innerHTML = batchQueue.map(function(_, i) {
    const cls = i < batchCursor ? 'done' : i === batchCursor ? 'active' : 'pending';
    return '<div class="bq-dot ' + cls + '" title="Patient ' + (i+1) + '"></div>';
  }).join('');

  document.getElementById('bqTranscript').textContent = '🎤 ' + p.rawText;

  setForm(p.formType);
  clearForm(p.formType);
  fillFields(p.fields, p.formType);

  const saveBtn = document.getElementById('bqSaveNext');
  saveBtn.textContent = batchCursor === total - 1 ? '💾 Save & Finish ✓' : '💾 Save & Next →';
}

function clearForm(arg) {
  let prefix;
  if (arg === 'transfusion') prefix = 't';
  else if (arg === 'delivery') prefix = 'd';
  else prefix = arg;

  if (prefix === 't') { tComponents = defaultTComponents(); renderTCompTable(); tUnitComponents = defaultTUnitComponents(); renderTUnitCompTable(); } // drop any extra component rows / unit entries
  if (prefix === 'd') { dComponents = defaultDComponents(); renderDCompTable(); } // drop any extra component rows
  document.querySelectorAll(`[id^="${prefix}_"]`).forEach(el => {
    if (el.type === 'checkbox' || el.type === 'radio') el.checked = false;
    else el.value = '';
    el.classList.remove('voice-hit');
    el.classList.remove('needs-verify');
  });
  refreshAllSignaturePads(); // clears the drawn strokes to match the now-empty hidden inputs
  if (prefix === 't') { tCount = 0; document.getElementById('t_count').textContent = 0; }
  else                { dCount = 0; document.getElementById('d_count').textContent = 0; }
  updateVerifyCount(prefix);
  // Clear validation errors
  document.querySelectorAll(`[id^="${prefix}_"].field-error`).forEach(el => el.classList.remove('field-error'));
  const banner = document.getElementById(prefix + '_validationBanner');
  if (banner) banner.classList.remove('show');
  // Clear draft
  const formType = prefix === 't' ? 'transfusion' : 'delivery';
  clearDraft(formType);
  // Clear file number hint
  const hint = document.getElementById(prefix + '_fnHint');
  if (hint) hint.className = 'fn-hint';
}

async function batchSaveNext() {
  const p = batchQueue[batchCursor];
  await saveForm(p.formType);
  advanceBatch();
}

function batchSkip() { advanceBatch(); }

function advanceBatch() {
  batchCursor++;
  if (batchCursor >= batchQueue.length) {
    document.getElementById('batchQueue').style.display = 'none';
    batchQueue  = [];
    batchCursor = 0;
    setStatus('done', '✅ All patients saved!');
    loadHistory();
    return;
  }
  renderBatchPatient();
}

// ═══════════════════════════════════════════════════════
// FIELD MAP — voice key → HTML element id
// ═══════════════════════════════════════════════════════
const FIELD_MAP = {
  request_date:             { id:'t_request_date',        form:'transfusion' },
  request_time:             { id:'t_request_time',        form:'transfusion' },
  room:                     { id:'t_room',                form:'transfusion' },
  patient_name:             { id:'t_patient_name',        form:'transfusion' },
  file_number:              { id:'t_file_number',         form:'transfusion' },
  blood_group:              { id:'t_blood_group',         form:'transfusion' },
  rh_factor:                { id:'t_rh',                  form:'transfusion' },
  diagnosis:                { id:'t_diagnosis',           form:'transfusion' },
  fpc_units:                { id:'t_fpc_units',           form:'transfusion' },
  fpc_type:                 { id:'t_fpc_type',            form:'transfusion' },
  ffp_units:                { id:'t_ffp_units',           form:'transfusion' },
  ffp_type:                 { id:'t_ffp_type',            form:'transfusion' },
  plt_units:                { id:'t_plt_units',           form:'transfusion' },
  plt_type:                 { id:'t_plt_type',            form:'transfusion' },
  irr_units:                { id:'t_irr_units',           form:'transfusion' },
  irr_type:                 { id:'t_irr_type',            form:'transfusion' },
  blood_bank_date:          { id:'t_bb_date',             form:'transfusion' },
  blood_bank_time:          { id:'t_bb_time',             form:'transfusion' },
  // blood_unit_1..8 are intentionally absent here — Compatible Blood Units
  // is now a per-component Unit # list (see tUnitComponents /
  // renderTUnitCompTable below), computed at every collection/restore point
  // instead of round-tripping through 8 plain DOM elements.
  previous_transfusion:     { id:'t_prev_yes',            form:'transfusion', type:'radio' },
  prev_transfusion_place:   { id:'t_prev_place',          form:'transfusion' },
  prev_transfusion_reaction:{ id:'t_prev_reaction',       form:'transfusion' },
  physician:                { id:'t_physician',           form:'transfusion' },
  physician_signature:      { id:'t_physician_signature', form:'transfusion' },
  phlebotomist:             { id:'t_phlebotomist',        form:'transfusion' },
  life_saving_t:            { id:'t_life_saving',         form:'transfusion', type:'checkbox' },
  ls_physician_t:           { id:'t_ls_physician',        form:'transfusion' },
  ls_signature_t:           { id:'t_ls_signature',        form:'transfusion' },
  ls_time_t:                { id:'t_ls_time',             form:'transfusion' },
  d_patient_name:           { id:'d_patient_name',        form:'delivery' },
  d_file_number:            { id:'d_file_number',         form:'delivery' },
  d_blood_group:            { id:'d_blood_group',         form:'delivery' },
  d_rh:                     { id:'d_rh',                  form:'delivery' },
  d_room:                   { id:'d_room',                form:'delivery' },
  similar_names:            { id:'d_similar_names',       form:'delivery', type:'checkbox' },
  isolation:                { id:'d_isolation',           form:'delivery', type:'checkbox' },
  risk_fall:                { id:'d_risk_fall',           form:'delivery', type:'checkbox' },
  allergy_label:            { id:'d_allergy_label',       form:'delivery', type:'checkbox' },
  allergy_details:          { id:'d_allergy_details',     form:'delivery' },
  blood_unit_numbers:       { id:'d_blood_unit_numbers',  form:'delivery' },
  d_fpc_units:              { id:'d_fpc_units',           form:'delivery' },
  d_ffp_units:              { id:'d_ffp_units',           form:'delivery' },
  d_plt_units:              { id:'d_plt_units',           form:'delivery' },
  d_irr_units:              { id:'d_irr_units',           form:'delivery' },
  blood_unit_group:         { id:'d_blood_unit_group',    form:'delivery' },
  patient_bg_delivery:      { id:'d_patient_bg_delivery', form:'delivery' },
  technician:               { id:'d_technician',          form:'delivery' },
  orderly:                  { id:'d_orderly',             form:'delivery' },
  nurse:                    { id:'d_nurse',               form:'delivery' },
  delivery_date:            { id:'d_delivery_date',       form:'delivery' },
  delivery_time:            { id:'d_delivery_time',       form:'delivery' },
  leakage:                  { id:'d_leakage',             form:'delivery' },
  gases:                    { id:'d_gases',               form:'delivery' },
  volume:                   { id:'d_volume',              form:'delivery' },
  expiry_date:              { id:'d_expiry_date',         form:'delivery' },
  temperature:              { id:'d_temperature',         form:'delivery' },
  received_by:              { id:'d_received_by',         form:'delivery' },
  nurse_received_by:        { id:'d_nurse_received_by',   form:'delivery' },
  nurse_name:               { id:'d_nurse_name',          form:'delivery' },
  nurse_date:               { id:'d_nurse_date',          form:'delivery' },
  nurse_time:               { id:'d_nurse_time',          form:'delivery' },
  life_saving_d:            { id:'d_life_saving',         form:'delivery', type:'checkbox' },
  ls_physician_d:           { id:'d_ls_physician',        form:'delivery' },
  ls_signature_d:           { id:'d_ls_signature',        form:'delivery' },
  ls_time_d:                { id:'d_ls_time',             form:'delivery' },
};
