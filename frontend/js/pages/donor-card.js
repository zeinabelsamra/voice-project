// Donor card (BB-19F-01) form and dashboard
// 
// Loaded as a classic script (shared global scope) — see index.html for load order.

// ═══════════════════════════════════════════════════════
// DONOR CARD (بطاقة المتبرع) BB-19F-01
// The question list comes from the backend (donorCard.js) so the form,
// the saved review flags and the PDF/DOCX export share one definition.
// ═══════════════════════════════════════════════════════
let dcMeta = null;
let currentDonorId = null;
let dcSearchTimer = null;

const DC_TEXT_FIELDS = [
  'donation_number','blood_group','rh','donor_name','dob','nationality','id_number','donor_number',
  'address','phone','patient_name','relationship',
  'exam_general_appearance','exam_weight','exam_temp','exam_bp_sys','exam_bp_dia','exam_pulse',
  'lab_lot_number','lab_hb','lab_hct','lab_wbc','lab_plt_count','phlebotomy_by','phlebotomy_date',
  'consent_name','collection_datetime','collected_quantity','staff_name',
  'contact1_datetime','contact1_result','contact2_datetime','contact2_result','contact3_datetime','contact3_result',
  'lab_notes','lab_reviewer_name','lab_reviewer_date',
  'deferral_other','deferral_until',
];
const DC_RADIO_FIELDS = ['donation_type','gender','exam_needle_marks','exam_skin_lesions','eligibility'];
const DC_SIG_FIELDS   = ['technician_signature','donor_signature','staff_signature','lab_reviewer_signature'];

function dcEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function dcRadio(name) { const el = document.querySelector(`input[name="dc_${name}"]:checked`); return el ? el.value : ''; }
function dcSetRadio(name, val) {
  document.querySelectorAll(`input[name="dc_${name}"]`).forEach(r => { r.checked = r.value === val; });
}
function dcAnswer(key) { const el = document.querySelector(`input[name="dcq_${key}"]:checked`); return el ? el.value : ''; }

async function initDonorCard() {
  if (!dcMeta) {
    try {
      const res = await apiFetch(`${API}/donor-card/questions`);
      if (!res || !res.ok) throw new Error();
      dcMeta = await res.json();
    } catch {
      document.getElementById('dcQuestionsBody').innerHTML =
        '<tr><td colspan="3" style="text-align:center;color:#c0392b;padding:16px">Could not load the questionnaire — is the server running?</td></tr>';
      return;
    }
    renderDcQuestions();
    document.getElementById('dc_consent_text').innerHTML = dcMeta.consent.map(p => `<p>• ${dcEsc(p)}</p>`).join('');
    document.getElementById('dc_pos_tests').innerHTML = dcMeta.positiveTests.map(t =>
      `<label class="chk"><input type="checkbox" id="dc_${t.key}"> ${dcEsc(t.label)}</label>`).join('');
    document.getElementById('dc_deferral_reasons').innerHTML = (dcMeta.deferralReasons || []).map(r =>
      `<label class="chk"><input type="checkbox" class="dc-reason" value="${r.key}" onchange="dcEligibilityChanged()"> ${dcEsc(r.label)}</label>`).join('');
  }
  dcRefresh();
  loadDonorHistory();
}

function renderDcQuestions() {
  const rows = [];
  dcMeta.sections.forEach((sec, si) => {
    // Every section gets a header row so it can carry its own "كلا" button,
    // even the sections that have no title on the paper form.
    rows.push(`<tr class="dc-q-sec" ${sec.only ? `data-only="${sec.only}"` : ''}><td colspan="3">
      <div class="dc-sec-head"><span>${dcEsc(sec.title || '')}</span>
        <button type="button" class="dc-sec-no" onclick="dcFillNo(${si})" title="Mark the unanswered questions in this section as كلا">كلا للقسم</button></div></td></tr>`);
    sec.questions.forEach(q => {
      const detail = q.detail
        ? `<input class="dc-detail" type="text" id="dcqd_${q.key}" placeholder="في حال الإيجاب، اذكر التفاصيل" maxlength="255">` : '';
      rows.push(`<tr class="dc-q-row${q.sub ? ' dc-sub' : ''}" data-key="${q.key}" data-sec="${si}" ${q.only ? `data-only="${q.only}"` : ''}>
        <td class="dc-q-text">${q.sub ? '- ' : '• '}${dcEsc(q.text)}${detail}</td>
        <td class="dc-ans"><label><input type="radio" name="dcq_${q.key}" value="yes" onchange="dcRefresh()"></label></td>
        <td class="dc-ans"><label><input type="radio" name="dcq_${q.key}" value="no"  onchange="dcRefresh()"></label></td>
      </tr>`);
    });
  });
  document.getElementById('dcQuestionsBody').innerHTML = rows.join('');
}

// Bulk "كلا": fills only the visible questions that have no answer yet
// (all of them, or one section when sec is given), so any نعم already
// ticked is kept.
function dcFillNo(sec) {
  let n = 0;
  document.querySelectorAll('#dcQuestionsBody tr.dc-q-row').forEach(tr => {
    if (tr.classList.contains('dc-hidden')) return;
    if (sec != null && tr.dataset.sec !== String(sec)) return;
    if (dcAnswer(tr.dataset.key)) return;
    const no = tr.querySelector('input[value="no"]');
    if (no) { no.checked = true; n++; }
  });
  dcRefresh();
  showToast('Donor Card', n ? `${n} question${n > 1 ? 's' : ''} set to كلا.` : 'All of these questions are already answered.');
}

function dcClearAnswers() {
  if (!confirm('Clear all نعم / كلا answers on this card?')) return;
  document.querySelectorAll('#dcQuestionsBody input[type="radio"]').forEach(r => { r.checked = false; });
  dcRefresh();
}

function dcApplies(only, gender, type) {
  if (!only) return true;
  if (only === 'platelet') return type === 'platelet';
  return !gender || gender === only;   // gender-specific: shown until a gender is chosen
}

// Mirrors reviewFlags() in donorCard.js: vitals/lab values outside the
// limits printed on the paper form.
function dcVitalFlags(d) {
  const L = dcMeta.limits, n = v => (v === '' || v == null) ? null : parseFloat(v);
  const female = d.gender === 'female', out = {};
  const w = n(d.exam_weight), t = n(d.exam_temp), s = n(d.exam_bp_sys), di = n(d.exam_bp_dia),
        p = n(d.exam_pulse), hb = n(d.lab_hb), hct = n(d.lab_hct);
  if (w  != null && w  < L.weight_min) out.exam_weight = `Weight below ${L.weight_min} kg`;
  if (t  != null && t  > L.temp_max)   out.exam_temp   = `Temperature above ${L.temp_max} °C`;
  if (s  != null && (s <= L.bp_sys_min || s >= L.bp_sys_max)) out.exam_bp_sys = 'Systolic BP out of range';
  if (di != null && (di < L.bp_dia_min || di > L.bp_dia_max)) out.exam_bp_dia = 'Diastolic BP out of range';
  if (p  != null && (p < L.pulse_min || p > L.pulse_max))     out.exam_pulse  = 'Pulse out of range';
  if (hb  != null && hb  < (female ? L.hb_min_female  : L.hb_min_male))  out.lab_hb  = 'Hemoglobin below minimum';
  if (hct != null && hct < (female ? L.hct_min_female : L.hct_min_male)) out.lab_hct = 'Hematocrit below minimum';
  if (d.exam_needle_marks === 'yes') out.exam_needle_marks = 'Needle marks on arms';
  if (d.exam_skin_lesions === 'yes') out.exam_skin_lesions = 'Skin lesions';
  return out;
}

// Re-evaluates visibility (gender / platelet-only questions), highlights
// answers and values that need review, and updates the status banner.
function dcRefresh() {
  if (!dcMeta) return;
  const gender = dcRadio('gender'), type = dcRadio('donation_type');
  document.querySelector('.dc-card').classList.toggle('is-platelet', type === 'platelet');
  const flagIf = {};
  dcMeta.sections.forEach(s => s.questions.forEach(q => { flagIf[q.key] = q.flagIf; }));

  let answered = 0, total = 0, flaggedQ = 0;
  document.querySelectorAll('#dcQuestionsBody tr').forEach(tr => {
    const applies = dcApplies(tr.dataset.only, gender, type);
    tr.classList.toggle('dc-hidden', !applies);
    const key = tr.dataset.key;
    if (!key) return;
    const ans = dcAnswer(key);
    const flagged = applies && flagIf[key] && ans === flagIf[key];
    tr.classList.toggle('dc-flag', !!flagged);
    if (applies) { total++; if (ans) answered++; if (flagged) flaggedQ++; }
  });

  const vf = dcVitalFlags(collectDonorFields());
  document.querySelectorAll('.dc-vital').forEach(el => el.classList.toggle('dc-out', !!vf[el.id.slice(3)]));
  ['exam_needle_marks','exam_skin_lesions'].forEach(k =>
    document.getElementById(`dc_${k}_row`).classList.toggle('dc-out', !!vf[k]));

  const issues = [];
  if (flaggedQ) issues.push(`${flaggedQ} questionnaire answer${flaggedQ > 1 ? 's' : ''}`);
  Object.values(vf).forEach(v => issues.push(v));
  const st = document.getElementById('dc_status');
  st.className = 'dc-status ' + (issues.length ? 'warn' : 'ok');
  st.innerHTML = (issues.length
      ? `⚠ Needs review: ${dcEsc(issues.join(' · '))}`
      : '✓ No answers or values flagged so far')
    + `<span class="dc-progress">${answered} / ${total} questions answered</span>`;
}

function collectDonorFields() {
  const d = {};
  DC_TEXT_FIELDS.forEach(k => { const el = document.getElementById('dc_' + k); d[k] = el ? el.value.trim() : ''; });
  DC_RADIO_FIELDS.forEach(k => { d[k] = dcRadio(k); });
  DC_SIG_FIELDS.forEach(k => { d[k] = document.getElementById('dc_' + k).value; });
  (dcMeta ? dcMeta.positiveTests : []).forEach(t => { const el = document.getElementById('dc_' + t.key); d[t.key] = !!(el && el.checked); });
  d.answers = {}; d.answer_notes = {};
  if (dcMeta) dcMeta.sections.forEach(s => s.questions.forEach(q => {
    const a = dcAnswer(q.key);
    if (a) d.answers[q.key] = a;
    const det = document.getElementById('dcqd_' + q.key);
    if (det && det.value.trim()) d.answer_notes[q.key] = det.value.trim();
  }));
  // Deferral details only mean something when the donor was deferred.
  const deferred = d.eligibility === 'temp_deferred' || d.eligibility === 'perm_deferred';
  d.deferral_reasons = deferred
    ? [...document.querySelectorAll('#dc_deferral_reasons .dc-reason:checked')].map(x => x.value) : [];
  if (!deferred || !d.deferral_reasons.includes('other')) d.deferral_other = '';
  if (d.eligibility !== 'temp_deferred') d.deferral_until = '';
  return d;
}

// Shows/hides the deferral box; the first time a donor is marked deferred
// with no reason ticked, the reasons are pre-ticked from the review flags.
function dcEligibilityChanged(fromRadio) {
  const el = dcRadio('eligibility');
  const deferred = el === 'temp_deferred' || el === 'perm_deferred';
  document.getElementById('dc_deferral_box').style.display = deferred ? '' : 'none';
  document.getElementById('dc_deferral_until_wrap').style.display = el === 'temp_deferred' ? '' : 'none';
  const otherOn = !!document.querySelector('#dc_deferral_reasons .dc-reason[value="other"]:checked');
  document.getElementById('dc_deferral_other_wrap').style.display = otherOn ? '' : 'none';
  if (fromRadio && deferred && !document.querySelector("#dc_deferral_reasons .dc-reason:checked")) dcSuggestReasons(false);
}

// Mirrors the suggestFrom mapping in donorCard.js (DEFERRAL_REASONS).
function dcSuggestReasons(manual) {
  if (!dcMeta || !dcMeta.deferralReasons) return;
  const d = collectDonorFields();
  const gender = d.gender, type = d.donation_type, flagged = new Set();
  dcMeta.sections.forEach(s => s.questions.forEach(q => {
    if (q.flagIf && dcApplies(q.only, gender, type) && d.answers[q.key] === q.flagIf) flagged.add(q.key);
  }));
  const vitalKey = { exam_weight: 'weight', exam_temp: 'temp', exam_bp_sys: 'bp_sys', exam_bp_dia: 'bp_dia',
    exam_pulse: 'pulse', lab_hb: 'hb', lab_hct: 'hct', exam_needle_marks: 'needle_marks', exam_skin_lesions: 'skin_lesions' };
  Object.keys(dcVitalFlags(d)).forEach(k => flagged.add(vitalKey[k]));
  const anyPositive = dcMeta.positiveTests.some(t => d[t.key]);
  let n = 0;
  dcMeta.deferralReasons.forEach(r => {
    const hit = r.suggestFrom.some(k => flagged.has(k)) || (r.key === 'positive_test' && anyPositive);
    const box = document.querySelector(`#dc_deferral_reasons .dc-reason[value="${r.key}"]`);
    if (hit && box && !box.checked) { box.checked = true; n++; }
  });
  document.getElementById('dc_deferral_other_wrap').style.display =
    document.querySelector('#dc_deferral_reasons .dc-reason[value="other"]:checked') ? '' : 'none';
  if (manual) showToast('Donor Card', n ? `${n} reason${n > 1 ? 's' : ''} ticked from the flags.` : 'No new reasons found in the flags.');
}

function fillDonorForm(r) {
  DC_TEXT_FIELDS.forEach(k => { const el = document.getElementById('dc_' + k); if (el) el.value = r[k] || ''; });
  DC_RADIO_FIELDS.forEach(k => dcSetRadio(k, r[k] || ''));
  DC_SIG_FIELDS.forEach(k => { document.getElementById('dc_' + k).value = r[k] || ''; refreshSignaturePad('dc_' + k); });
  dcMeta.positiveTests.forEach(t => { const el = document.getElementById('dc_' + t.key); if (el) el.checked = !!r[t.key]; });
  const answers = r.answers || {}, notes = r.answer_notes || {};
  dcMeta.sections.forEach(s => s.questions.forEach(q => {
    document.querySelectorAll(`input[name="dcq_${q.key}"]`).forEach(x => { x.checked = x.value === answers[q.key]; });
    const det = document.getElementById('dcqd_' + q.key);
    if (det) det.value = notes[q.key] || '';
  }));
  const reasons = new Set(r.deferral_reasons || []);
  document.querySelectorAll('#dc_deferral_reasons .dc-reason').forEach(x => { x.checked = reasons.has(x.value); });
  dcRefresh();
  dcEligibilityChanged();
}

function clearDonorForm() {
  if (!dcMeta) return;
  currentDonorId = null;
  fillDonorForm({});
  document.getElementById('dc_saveBtn').textContent = '💾 Save Card';
  document.getElementById('dc_editInfo').textContent = '';
}

async function saveDonorCard() {
  if (!dcMeta) return;
  const d = collectDonorFields();
  if (!d.donor_name) {
    showToast('Donor Card', 'إسم المتطوع (donor name) is required.');
    document.getElementById('dc_donor_name').focus();
    return;
  }
  const btn = document.getElementById('dc_saveBtn');
  btn.disabled = true;
  try {
    const res = currentDonorId
      ? await apiFetch(`${API}/donor-card/${currentDonorId}`, { method: 'PUT',  headers: { 'Content-Type': 'application/json' }, body: d })
      : await apiFetch(`${API}/donor-card/save`,              { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: d });
    if (!res) return;
    const data = await res.json();
    if (!res.ok) { showToast('Donor Card', data.error || 'Save failed.'); return; }
    showToast('Donor Card', currentDonorId ? 'Card updated.' : 'Card saved.');
    clearDonorForm();
    loadDonorHistory();
  } catch { showToast('Donor Card', 'Server error.'); }
  finally  { btn.disabled = false; }
}

function dcSearchChanged() {
  clearTimeout(dcSearchTimer);
  dcSearchTimer = setTimeout(loadDonorHistory, 300);
}

async function loadDonorHistory() {
  const grid = document.getElementById('dcHistoryGrid');
  if (!grid) return;
  const q = (document.getElementById('dcSearch').value || '').trim();
  grid.innerHTML = '<div class="empty-msg"><div class="empty-icon">⏳</div><div class="empty-text">Loading…</div></div>';
  try {
    const res = await apiFetch(`${API}/donor-card${q ? '?q=' + encodeURIComponent(q) : ''}`);
    if (!res) return;
    const rows = await res.json();
    if (!res.ok) throw new Error();
    if (!rows.length) {
      grid.innerHTML = `<div class="empty-msg"><div class="empty-icon">🩸</div><div class="empty-text">${q ? 'No matching donor cards.' : 'No donor cards yet.'}</div></div>`;
      return;
    }
    const typeLabel = { blood: 'وحدة دم', platelet: 'بلاكيت' };
    grid.innerHTML = rows.map(r => {
      const group = [r.blood_group, r.rh].filter(Boolean).join(' ');
      const badge = r.flagged_count
        ? `<span class="ext-badge dc-badge-flag">⚠ ${r.flagged_count} to review</span>`
        : '<span class="ext-badge dc-badge-ok">✓ No flags</span>';
      return `
        <div class="ext-card">
          <div class="ext-card-head">
            <div>
              <div class="ext-card-name" dir="auto">${dcEsc(r.donor_name || '—')}</div>
              <div class="ext-card-meta">📅 ${dcEsc((r.created_at || '').slice(0, 16))}${r.donation_number ? ' · #' + dcEsc(r.donation_number) : ''}</div>
            </div>
            <div class="ext-card-badges">${badge}</div>
          </div>
          <div class="ext-card-body">
            <div class="ext-info-row"><span class="ext-info-icon">🩸</span><span class="ext-info-label">Type / Group</span>
              <span class="ext-info-val">${dcEsc(typeLabel[r.donation_type] || '—')}${group ? ' · <strong>' + dcEsc(group) + '</strong>' : ''}</span></div>
            <div class="ext-info-row"><span class="ext-info-icon">🧑‍⚕️</span><span class="ext-info-label">For patient</span>
              <span class="ext-info-val" dir="auto">${dcEsc(r.patient_name || '—')}</span></div>
            <div class="ext-info-row"><span class="ext-info-icon">📞</span><span class="ext-info-label">Phone</span>
              <span class="ext-info-val">${dcEsc(r.phone || '—')}</span></div>
          </div>
          <div class="ext-card-actions">
            <button class="ext-act-btn primary" onclick="editDonorCard(${r.donor_card_id})">✏️ Edit</button>
            <button class="ext-act-btn" onclick="exportDonorFromRecord(${r.donor_card_id},'pdf')">📄 PDF</button>
            <button class="ext-act-btn" onclick="exportDonorFromRecord(${r.donor_card_id},'docx')">📝 Word</button>
            <button class="ext-act-btn danger" onclick="deleteDonorCard(${r.donor_card_id})">🗑️ Delete</button>
          </div>
        </div>`;
    }).join('');
  } catch { grid.innerHTML = '<div class="empty-msg"><div class="empty-text">Could not load donor cards.</div></div>'; }
}

async function fetchDonorCard(id) {
  const res = await apiFetch(`${API}/donor-card/${id}`);
  if (!res) return null;
  if (!res.ok) { showToast('Donor Card', 'Could not load this card.'); return null; }
  return res.json();
}

async function editDonorCard(id) {
  const r = await fetchDonorCard(id);
  if (!r) return;
  currentDonorId = id;
  fillDonorForm(r);
  document.getElementById('dc_saveBtn').textContent = '💾 Update Card';
  document.getElementById('dc_editInfo').textContent = `Editing card #${id}` + (r.saved_by ? ` · saved by ${r.saved_by}` : '');
  window.scrollTo({ top: document.getElementById('donorSection').offsetTop - 20, behavior: 'smooth' });
}

async function deleteDonorCard(id) {
  if (!confirm('Delete this donor card? This cannot be undone.')) return;
  const res = await apiFetch(`${API}/donor-card/${id}`, { method: 'DELETE' });
  if (!res) return;
  if (res.ok) {
    showToast('Donor Card', 'Card deleted.');
    if (currentDonorId === id) clearDonorForm();
    loadDonorHistory();
  } else { const d = await res.json(); showToast('Donor Card', d.error || 'Delete failed.'); }
}

async function exportDonorCard(type, data) {
  const d = data || collectDonorFields();
  try {
    const res = await apiFetch(`${API}/donor-card/export/${type}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: d
    });
    if (!res) return;
    if (!res.ok) {
      let msg = 'Export failed.';
      try { msg = (await res.json()).error || msg; } catch {}
      showToast('Donor Card', msg);
      return;
    }
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `donor-card-${(d.donor_name || 'blank').replace(/[\\/:*?"<>|]/g, '')}.${type}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch { showToast('Donor Card', 'Export error.'); }
}

async function exportDonorFromRecord(id, type) {
  const r = await fetchDonorCard(id);
  if (r) exportDonorCard(type, r);
}

// ── Donor Card dashboard ────────────────────────────────────
function dcSetView(view) {
  const dash = view === 'dash';
  document.getElementById('dcDashView').style.display = dash ? '' : 'none';
  document.getElementById('dcFormView').style.display = dash ? 'none' : '';
  document.getElementById('dcViewDashBtn').classList.toggle('active', dash);
  document.getElementById('dcViewFormBtn').classList.toggle('active', !dash);
  if (dash) loadDonorDashboard();
}

function dcdBars(items, cls) {
  if (!items.length) return '<div class="dash-empty">No data yet</div>';
  const max = Math.max(...items.map(i => i.count), 1);
  return items.map(i => `<div class="bg-bar-row">
      <div class="bg-bar-label">${dcEsc(i.label)}</div>
      <div class="bg-bar-track"><div class="bg-bar-fill ${i.cls || cls || ''}" style="width:${Math.round(i.count / max * 100)}%"></div></div>
      <div class="bg-bar-count">${i.count}${i.pct != null ? ` · ${i.pct}%` : ''}</div>
    </div>`).join('');
}

function dcdPct(n, total) { return total ? Math.round(n / total * 100) : 0; }

// For long ranges, roll the daily series up into months so the chart stays readable.
function dcdSeries(daily) {
  if (daily.length <= 90) return daily.map(d => ({ ...d,
    label: new Date(d.date + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) }));
  const byMonth = {};
  daily.forEach(d => {
    const k = d.date.slice(0, 7);
    const m = byMonth[k] || (byMonth[k] = { date: k, blood: 0, platelet: 0, other: 0,
      label: new Date(k + '-01T00:00:00').toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }) });
    m.blood += d.blood; m.platelet += d.platelet; m.other += d.other;
  });
  return Object.values(byMonth);
}

function renderDcdDaily(daily) {
  const el = document.getElementById('dcdDaily');
  const series = dcdSeries(daily);
  const max = Math.max(...series.map(d => d.blood + d.platelet + d.other), 1);
  const every = Math.ceil(series.length / 15);   // at most ~15 x-axis labels
  el.innerHTML = series.map((d, i) => {
    const h = n => Math.round(n / max * 100);
    const tip = `${d.label}: ${d.blood} blood · ${d.platelet} platelet${d.other ? ` · ${d.other} not set` : ''}`;
    return `<div class="daily-col" title="${dcEsc(tip)}">
      <div class="daily-bars">
        ${d.blood    ? `<div class="daily-bar t-bar" style="height:${h(d.blood)}%"></div>` : ''}
        ${d.platelet ? `<div class="daily-bar d-bar" style="height:${h(d.platelet)}%"></div>` : ''}
        ${d.other    ? `<div class="daily-bar o-bar" style="height:${h(d.other)}%"></div>` : ''}
      </div>
      <div class="daily-label">${i % every === 0 ? dcEsc(d.label) : '&nbsp;'}</div>
    </div>`;
  }).join('');
}

const DCD_OUTCOME = {
  accepted:      { label: '✓ Accepted',             color: '#1a7f4b' },
  temp_deferred: { label: '⏸ Temporarily deferred', color: '#d4a017' },
  perm_deferred: { label: '⛔ Permanently deferred', color: '#b42318' },
  pending:       { label: 'Not decided',            color: '#a0aec0' },
};

// Whole blood vs platelets comparison, eligibility outcome, deferral reasons.
function renderDcdDeferrals(s) {
  const set = (id, v) => { document.getElementById(id).textContent = v; };
  const o = s.outcome;
  const deferred = o.temp_deferred + o.perm_deferred;
  const decided  = deferred + o.accepted;
  set('dcdDeferred', deferred);
  set('dcdDeferredPct', decided ? `${dcdPct(deferred, decided)}% of decided` : '');
  set('dcdTempDef', o.temp_deferred);
  set('dcdPermDef', o.perm_deferred);

  // Whole blood vs platelets
  const split = (t) => ['accepted', 'temp_deferred', 'perm_deferred', 'pending']
    .map(k => t[k] ? `<div style="width:${t[k] / t.total * 100}%;background:${DCD_OUTCOME[k].color}" title="${DCD_OUTCOME[k].label}: ${t[k]}"></div>` : '').join('');
  const col = (key, name) => {
    const t = s.outcomeByType[key];
    const def = t.temp_deferred + t.perm_deferred, dec = def + t.accepted;
    return `<div class="dcd-vs-col ${key}">
      <div class="dcd-vs-head"><span class="dcd-vs-name">${name}</span>
        <span><span class="dcd-vs-num">${t.total}</span> <span class="dcd-reason-meta">${dcdPct(t.total, s.total)}% of cards</span></span></div>
      <div class="dcd-split">${t.total ? split(t) : ''}</div>
      <div class="dcd-vs-row"><span>✓ Accepted</span><strong>${t.accepted}</strong></div>
      <div class="dcd-vs-row"><span>⏸ Temporarily deferred</span><strong>${t.temp_deferred}</strong></div>
      <div class="dcd-vs-row"><span>⛔ Permanently deferred</span><strong>${t.perm_deferred}</strong></div>
      <div class="dcd-vs-row"><span>Not decided</span><strong>${t.pending}</strong></div>
      <div class="dcd-vs-row"><span>Deferral rate</span><strong style="color:#b42318">${dec ? dcdPct(def, dec) + '%' : '—'}</strong></div>
    </div>`;
  };
  const unk = s.outcomeByType.unknown.total;
  document.getElementById('dcdVs').innerHTML =
    `<div class="dcd-vs">${col('blood', 'وحدة دم · Whole blood')}${col('platelet', 'بلاكيت · Platelets')}</div>` +
    (unk ? `<div class="dcd-reason-meta" style="margin-top:8px">${unk} card${unk > 1 ? 's have' : ' has'} no donation type set.</div>` : '');

  // Outcome
  document.getElementById('dcdOutcome').innerHTML = s.total
    ? dcdBars(['accepted', 'temp_deferred', 'perm_deferred', 'pending']
        .filter(k => o[k] || k !== 'pending')
        .map(k => ({ label: DCD_OUTCOME[k].label, count: o[k], pct: dcdPct(o[k], s.total),
                     cls: k === 'accepted' ? 'delivery' : k === 'temp_deferred' ? 'gold' : k === 'pending' ? 'grey' : '' })))
    : '<div class="dash-empty">No data yet</div>';

  // Reasons
  let html = s.deferralReasons.length
    ? s.deferralReasons.map(r => `<div class="dcd-q-row">
        <span class="dcd-q-text">${dcEsc(r.label)}
          <div class="dcd-reason-meta">Blood ${r.blood} · Platelet ${r.platelet} · Temp ${r.temp} · Perm ${r.perm}</div></span>
        <span class="dcd-q-count" style="color:#b42318">${r.count}</span></div>`).join('')
    : `<div class="dash-empty">${deferred ? 'No reasons recorded' : 'No deferrals yet'}</div>`;
  if (s.deferredNoReason) html += `<div class="dcd-reason-meta" style="margin-top:8px">⚠ ${s.deferredNoReason} deferred card${s.deferredNoReason > 1 ? 's have' : ' has'} no reason ticked.</div>`;
  if (s.deferralOtherTexts.length) {
    html += '<div class="dcd-sub" style="margin-top:14px">"Other" reasons</div>' +
      s.deferralOtherTexts.map(t => `<div class="dcd-q-row"><span class="dcd-q-text" dir="auto">${dcEsc(t.text)}</span><span class="dcd-q-count" style="color:#b42318">${t.count}</span></div>`).join('');
  }
  document.getElementById('dcdReasons').innerHTML = html;

  // Recent deferrals
  const typeLabel = { blood: 'وحدة دم', platelet: 'بلاكيت' };
  document.getElementById('dcdDeferredBody').innerHTML = s.recentDeferred.length
    ? s.recentDeferred.map(r => `<tr>
        <td dir="auto">${dcEsc(r.donor_name || '—')}</td>
        <td>${dcEsc(r.donation_number || '—')}</td>
        <td>${dcEsc(typeLabel[r.donation_type] || '—')}${r.group ? ' · <strong>' + dcEsc(r.group) + '</strong>' : ''}</td>
        <td style="white-space:nowrap"><span class="ext-badge ${r.eligibility === 'perm_deferred' ? 'dc-badge-flag' : 'dc-badge-defer'}">${r.eligibility === 'perm_deferred' ? 'Permanent' : 'Temporary'}</span>${r.until ? `<div class="dcd-reason-meta">until ${dcEsc(r.until)}</div>` : ''}</td>
        <td>${r.reasons.length ? r.reasons.map(x => `<span class="dcd-chip">${dcEsc(x)}</span>`).join('') : '<span class="dcd-reason-meta">—</span>'}</td>
        <td style="white-space:nowrap">${dcEsc((r.created_at || '').slice(0, 16))}</td>
        <td><button class="ext-act-btn primary" onclick="dcSetView('form');editDonorCard(${r.donor_card_id})">✏️ Open</button></td>
      </tr>`).join('')
    : '<tr><td colspan="7" class="dash-empty">No deferrals recorded</td></tr>';
}

async function loadDonorDashboard() {
  const days = document.getElementById('dcDashDays').value;
  const errEl = document.getElementById('dcDashError');
  errEl.innerHTML = '';
  let s;
  try {
    const res = await apiFetch(`${API}/donor-card/stats?days=${days}`);
    if (!res) return;
    s = await res.json();
    if (!res.ok) throw new Error(s.error || 'Failed');
  } catch (e) {
    errEl.innerHTML = `<div class="dash-empty">Could not load donor card stats${e && e.message ? ' — ' + dcEsc(e.message) : ''}.</div>`;
    return;
  }

  const set = (id, v) => { document.getElementById(id).textContent = v; };
  set('dcdTotal', s.total); set('dcdToday', s.today); set('dcdWeek', s.week);
  set('dcdMonth', s.month);
  const diff = s.month - s.lastMonth;
  set('dcdMonthDelta', s.lastMonth || s.month
    ? `${diff > 0 ? '▲' : diff < 0 ? '▼' : '='} ${Math.abs(diff)} vs last month (${s.lastMonth})`
    : 'No cards last month');
  set('dcdFlagged', s.flaggedCards);
  set('dcdFlaggedPct', s.total ? `${dcdPct(s.flaggedCards, s.total)}% of cards` : '');
  set('dcdTotalFlags', s.totalFlags);
  set('dcdBlood', s.byType.blood);
  set('dcdPlatelet', s.byType.platelet);
  renderDcdDeferrals(s);

  const rangeLabel = document.getElementById('dcDashDays').selectedOptions[0].textContent;
  set('dcdDailyTitle', `${s.days > 90 ? 'Cards per Month' : 'Cards per Day'} — ${rangeLabel}`);
  renderDcdDaily(s.daily);

  document.getElementById('dcdGroups').innerHTML = dcdBars(
    s.byGroup.map(g => ({ label: g.group, count: g.count, pct: dcdPct(g.count, s.total),
                          cls: g.group === 'Unknown' ? 'grey' : '' })));

  const g = s.byGender, c = s.canContact;
  document.getElementById('dcdDonors').innerHTML =
    '<div class="dcd-sub">Gender</div>' + dcdBars([
      { label: 'Male',    count: g.male,    pct: dcdPct(g.male, s.total),    cls: 'delivery' },
      { label: 'Female',  count: g.female,  pct: dcdPct(g.female, s.total) },
      { label: 'Not set', count: g.unknown, pct: dcdPct(g.unknown, s.total), cls: 'grey' },
    ].filter(i => i.count || i.label !== 'Not set')) +
    '<div class="dcd-sub">Agree to be contacted for a patient</div>' + dcdBars([
      { label: 'نعم',       count: c.yes,        pct: dcdPct(c.yes, s.total), cls: 'delivery' },
      { label: 'كلا',       count: c.no,         pct: dcdPct(c.no, s.total) },
      { label: 'Unanswered', count: c.unanswered, pct: dcdPct(c.unanswered, s.total), cls: 'grey' },
    ].filter(i => i.count || i.label !== 'Unanswered'));

  document.getElementById('dcdQFlags').innerHTML = s.questionFlags.length
    ? s.questionFlags.map(q => `<div class="dcd-q-row">
        <span class="dcd-q-key">${dcEsc(q.key.toUpperCase())}</span>
        <span class="dcd-q-text" dir="rtl">${dcEsc(q.text)}</span>
        <span class="dcd-q-count">${q.count}</span></div>`).join('')
    : '<div class="dash-empty">No flagged answers 🎉</div>';

  document.getElementById('dcdVFlags').innerHTML = s.vitalFlags.length
    ? dcdBars(s.vitalFlags.map(v => ({ label: v.label, count: v.count })), 'gold')
    : '<div class="dash-empty">All values within limits</div>';

  const pos = s.positives.filter(p => p.count);
  document.getElementById('dcdPositives').innerHTML = pos.length
    ? dcdBars(pos.map(p => ({ label: p.label, count: p.count, pct: dcdPct(p.count, s.total) })))
    : '<div class="dash-empty">No positive results recorded</div>';

  const typeLabel = { blood: 'وحدة دم', platelet: 'بلاكيت' };
  document.getElementById('dcdRecentBody').innerHTML = s.recentFlagged.length
    ? s.recentFlagged.map(r => `<tr>
        <td dir="auto">${dcEsc(r.donor_name || '—')}</td>
        <td>${dcEsc(r.donation_number || '—')}</td>
        <td>${dcEsc(typeLabel[r.donation_type] || '—')}${r.group ? ' · <strong>' + dcEsc(r.group) + '</strong>' : ''}</td>
        <td>${r.flags.slice(0, 6).map(f => `<span class="dcd-chip">${dcEsc(f)}</span>`).join('')}${r.flags.length > 6 ? ` <span class="dcd-chip">+${r.flags.length - 6}</span>` : ''}</td>
        <td style="white-space:nowrap">${dcEsc((r.created_at || '').slice(0, 16))}</td>
        <td><button class="ext-act-btn primary" onclick="dcSetView('form');editDonorCard(${r.donor_card_id})">✏️ Open</button></td>
      </tr>`).join('')
    : '<tr><td colspan="6" class="dash-empty">No cards need review</td></tr>';
}
