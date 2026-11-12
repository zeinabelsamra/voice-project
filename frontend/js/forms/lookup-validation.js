// Forms — file-number lookup, expiry, compatibility, validation, patient history
// 
// Loaded as a classic script (shared global scope) — see index.html for load order.

// ═══════════════════════════════════════════════════════
// PATIENT FILE NUMBER LOOKUP
// ═══════════════════════════════════════════════════════
async function lookupFileNumber(formType) {
  const prefix    = formType === 'transfusion' ? 't' : 'd';
  const fnEl      = document.getElementById(prefix + '_file_number');
  const hintEl    = document.getElementById(prefix + '_fnHint');
  const btnEl     = document.getElementById(prefix + '_fnLookupBtn');
  const nameEl    = document.getElementById(prefix === 't' ? 't_patient_name' : 'd_patient_name');
  const bgEl      = document.getElementById(prefix === 't' ? 't_blood_group'  : 'd_blood_group');
  const rhEl      = document.getElementById(prefix === 't' ? 't_rh'           : 'd_rh');

  const fileNumber = fnEl.value.trim();
  if (!fileNumber) { hintEl.className = 'fn-hint'; return; }

  // Don't lookup while editing an existing record
  if (currentEditRecord && currentEditRecord.form_type === formType) return;

  btnEl.classList.add('loading');
  hintEl.className = 'fn-hint';

  try {
    const res    = await apiFetch(`${API}/patient/lookup?file_number=${encodeURIComponent(fileNumber)}`);
    if (!res) return;
    const result = await res.json();

    if (!result.found) {
      hintEl.textContent  = 'New patient — no previous records found.';
      hintEl.className    = 'fn-hint info show';
      return;
    }

    const existingName  = result.patient_name || '';
    const currentName   = nameEl.value.trim();

    // File number already belongs to a DIFFERENT patient — block
    if (currentName && currentName.toLowerCase() !== existingName.toLowerCase()) {
      hintEl.innerHTML = `⛔ File number already assigned to <strong>${e(existingName)}</strong>. Check the file number.`;
      hintEl.className = 'fn-hint error show';
      fnEl.classList.add('field-error');
      return;
    }

    // Same patient or name not yet filled — auto-fill
    fnEl.classList.remove('field-error');
    const filled = [];

    if (bgEl && !bgEl.value && result.blood_group) { bgEl.value = result.blood_group; filled.push('Blood Group'); }
    if (rhEl && !rhEl.value && result.rh_factor)   { rhEl.value = result.rh_factor;   filled.push('RH Factor'); }
    if (nameEl && !nameEl.value && existingName)   { nameEl.value = existingName;     filled.push('Patient Name'); }

    // For transfusion: also fill diagnosis
    if (formType === 'transfusion' && result.diagnosis) {
      const diagEl = document.getElementById('t_diagnosis');
      if (diagEl && !diagEl.value) { diagEl.value = result.diagnosis; filled.push('Diagnosis'); }
    }

    if (filled.length) {
      hintEl.textContent = '✓ Filled from previous record: ' + filled.join(', ');
      hintEl.className   = 'fn-hint success show';
    } else {
      hintEl.textContent = '✓ Returning patient — ' + existingName;
      hintEl.className   = 'fn-hint success show';
    }

    setTimeout(() => { hintEl.className = 'fn-hint'; }, 5000);

  } catch {
    hintEl.textContent = 'Could not check file number — is the server running?';
    hintEl.className   = 'fn-hint error show';
  } finally {
    btnEl.classList.remove('loading');
  }
}

// ═══════════════════════════════════════════════════════
// EXPIRY DATE CHECK
// ═══════════════════════════════════════════════════════
function checkExpiryDate(value) {
  const el   = document.getElementById('d_expiry_date');
  const hint = document.getElementById('expiryHint');
  el.classList.remove('expiry-expired', 'expiry-warn');
  hint.className = 'expiry-hint';

  if (!value) return;

  const expiry   = new Date(value + 'T00:00:00');
  const today    = new Date(); today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
  const diffDays = Math.round((expiry - today) / 86400000);

  if (expiry < today) {
    el.classList.add('expiry-expired');
    hint.textContent = `Expired ${Math.abs(diffDays)} day${Math.abs(diffDays) !== 1 ? 's' : ''} ago — delivery will be blocked`;
    hint.classList.add('show', 'error');
  } else if (diffDays === 0) {
    el.classList.add('expiry-warn');
    hint.textContent = 'Expires today — confirmation required';
    hint.classList.add('show', 'warn');
  } else if (diffDays === 1) {
    el.classList.add('expiry-warn');
    hint.textContent = 'Expires tomorrow — confirmation required';
    hint.classList.add('show', 'warn');
  } else if (diffDays <= 3) {
    el.classList.add('expiry-warn');
    hint.textContent = `Expires in ${diffDays} days`;
    hint.classList.add('show', 'warn');
  } else {
    hint.textContent = `Valid — expires in ${diffDays} days`;
    hint.classList.add('show', 'ok');
  }
}

// ═══════════════════════════════════════════════════════
// BLOOD GROUP COMPATIBILITY
// ═══════════════════════════════════════════════════════
const BLOOD_COMPATIBILITY = {
  'A+':  ['A+', 'A-', 'O+', 'O-'],
  'A-':  ['A-', 'O-'],
  'B+':  ['B+', 'B-', 'O+', 'O-'],
  'B-':  ['B-', 'O-'],
  'AB+': ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'],
  'AB-': ['A-', 'B-', 'AB-', 'O-'],
  'O+':  ['O+', 'O-'],
  'O-':  ['O-'],
};

function isCompatible(patientGroup, unitGroup) {
  const compatible = BLOOD_COMPATIBILITY[patientGroup];
  if (!compatible) return true; // unknown group — don't block
  return compatible.includes(unitGroup);
}

function showCompatWarning(patientGroup, unitGroup) {
  return new Promise(resolve => {
    document.getElementById('compatPatientGroup').textContent = patientGroup;
    document.getElementById('compatUnitGroup').textContent    = unitGroup;
    document.getElementById('compatOverlay').classList.add('show');
    document.getElementById('compatBtnCancel').onclick = () => {
      document.getElementById('compatOverlay').classList.remove('show');
      resolve(false);
    };
    document.getElementById('compatBtnOverride').onclick = () => {
      if (!confirm('Are you sure you want to override the compatibility check? This could be life-threatening.')) return;
      document.getElementById('compatOverlay').classList.remove('show');
      resolve(true);
    };
  });
}

// ═══════════════════════════════════════════════════════
// VALIDATION
// ═══════════════════════════════════════════════════════
const REQUIRED_FIELDS = {
  transfusion: [
    { id: 't_patient_name',  label: 'Patient Name' },
    { id: 't_file_number',   label: 'File Number' },
    { id: 't_blood_group',   label: 'Blood Group' },
    { id: 't_rh',            label: 'RH Factor' },
    { id: 't_diagnosis',     label: 'Diagnosis' },
    { id: 't_physician',     label: 'Physician' },
  ],
  delivery: [
    { id: 'd_patient_name',         label: 'Patient Name' },
    { id: 'd_file_number',          label: 'File Number' },
    { id: 'd_blood_group',          label: 'Blood Group' },
    { id: 'd_rh',                   label: 'RH Factor' },
    { id: 'd_room',                 label: 'Room / Ward' },
    { id: 'd_nurse',                label: "Nurse's Name" },
    { id: 'd_blood_unit_numbers',   label: 'Blood Unit Numbers' },
    { id: 'd_technician',           label: 'Technician' },
  ]
};

function validateForm(formType) {
  // Clear any previous error state
  document.querySelectorAll('.fi.field-error').forEach(el => el.classList.remove('field-error'));
  const prefix  = formType === 'transfusion' ? 't' : 'd';
  const banner  = document.getElementById(prefix + '_validationBanner');

  const missing = [];
  for (const field of REQUIRED_FIELDS[formType]) {
    const el = document.getElementById(field.id);
    if (!el) continue;
    if (!el.value.trim()) {
      el.classList.add('field-error');
      missing.push(field.label);
    }
  }

  if (missing.length) {
    banner.textContent = '⚠ Required fields missing: ' + missing.join(', ');
    banner.classList.add('show');
    // Scroll to first invalid field
    const first = document.querySelector('.fi.field-error');
    if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return false;
  }

  banner.classList.remove('show');
  return true;
}

// Clear error highlight as soon as user fixes the field
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.fi').forEach(el => {
    el.addEventListener('input',  () => el.classList.remove('field-error'));
    el.addEventListener('change', () => el.classList.remove('field-error'));
  });
  // Clear "needs verification" only on an actual edit (not just tabbing past
  // it) — a blur-only trigger would let Tab-ing through the form silently
  // dismiss every flag without anyone reading them.
  document.querySelectorAll('.fi').forEach(el => {
    if (!HIGH_RISK_VOICE_LABELS[el.id]) return;
    el.addEventListener('input', () => {
      if (!el.classList.contains('needs-verify')) return;
      el.classList.remove('needs-verify');
      updateVerifyCount(el.id.startsWith('t_') ? 't' : 'd');
    });
  });
});

// ═══════════════════════════════════════════════════════
// PATIENT FILE NUMBER LOOKUP
// ═══════════════════════════════════════════════════════
async function lookupFileNumber(formType) {
  const prefix    = formType === 'transfusion' ? 't' : 'd';
  const fnEl      = document.getElementById(prefix + '_file_number');
  const btn       = document.getElementById(prefix + '_fnLookupBtn');
  const hint      = document.getElementById(prefix + '_fnHint');
  const nameEl    = document.getElementById(prefix + '_patient_name');
  const bgEl      = document.getElementById(prefix + '_blood_group');
  const rhEl      = document.getElementById(prefix + '_rh');
  const diagEl    = formType === 'transfusion' ? document.getElementById('t_diagnosis') : null;

  const fileNum = fnEl?.value?.trim();

  // Reset hint
  hint.className = 'fn-hint';
  hint.textContent = '';

  if (!fileNum) return;

  btn.classList.add('loading');

  try {
    const res  = await apiFetch(`${API}/patient/lookup?file_number=${encodeURIComponent(fileNum)}`);
    if (!res) return;
    const data = await res.json();

    if (!data.found) {
      hint.textContent = 'No previous records — new patient';
      hint.classList.add('show', 'info');
      return;
    }

    const existingName = data.patient_name || '';
    const currentName  = nameEl?.value?.trim() || '';

    // File number already belongs to a DIFFERENT patient — block
    if (currentName && existingName &&
        currentName.toLowerCase() !== existingName.toLowerCase()) {
      hint.textContent = `⚠ This file number belongs to "${existingName}" — cannot assign to a different patient`;
      hint.classList.add('show', 'error');
      fnEl.classList.add('field-error');
      return;
    }

    // Auto-fill patient fields
    const filled = [];
    if (nameEl && !nameEl.value && existingName) {
      nameEl.value = existingName;
      nameEl.classList.add('voice-hit');
      setTimeout(() => nameEl.classList.remove('voice-hit'), 1000);
      filled.push('name');
    }
    if (bgEl && !bgEl.value && data.blood_group) {
      bgEl.value = data.blood_group;
      bgEl.classList.add('voice-hit');
      setTimeout(() => bgEl.classList.remove('voice-hit'), 1000);
      filled.push('blood group');
    }
    if (rhEl && !rhEl.value && data.rh_factor) {
      rhEl.value = data.rh_factor;
      rhEl.classList.add('voice-hit');
      setTimeout(() => rhEl.classList.remove('voice-hit'), 1000);
      filled.push('RH');
    }
    if (diagEl && !diagEl.value && data.diagnosis) {
      diagEl.value = data.diagnosis;
      diagEl.classList.add('voice-hit');
      setTimeout(() => diagEl.classList.remove('voice-hit'), 1000);
      filled.push('diagnosis');
    }

    const fillMsg = filled.length
      ? `✓ Returning patient — filled: ${filled.join(', ')}`
      : `✓ Returning patient: ${e(existingName)}`;
    hint.innerHTML = `${fillMsg} <button class="ph-mini-btn" onclick="openPatientHistory('${e(fileNum)}')">📋 History</button>`;
    hint.classList.add('show', 'success');

  } catch {
    hint.textContent = 'Could not reach server';
    hint.classList.add('show', 'info');
  } finally {
    btn.classList.remove('loading');
  }
}

// ═══════════════════════════════════════════════════════
// PATIENT HISTORY MODAL
// ═══════════════════════════════════════════════════════
function openPatientHistory(fileNumber) {
  const overlay = document.getElementById('phOverlay');
  overlay.classList.add('open');
  if (fileNumber) {
    document.getElementById('phSearchInput').value = fileNumber;
    loadPatientHistory(fileNumber);
  }
}

function closePatientHistory() {
  document.getElementById('phOverlay').classList.remove('open');
}

function searchPatientHistory() {
  const fn = document.getElementById('phSearchInput').value.trim();
  if (fn) loadPatientHistory(fn);
}

async function loadPatientHistory(fileNumber) {
  const body = document.getElementById('phBody');
  body.innerHTML = '<div class="ph-empty">Loading…</div>';

  try {
    const res  = await apiFetch(`${API}/patient/history?file_number=${encodeURIComponent(fileNumber)}`);
    if (!res) return;
    const data = await res.json();

    if (!data.found) {
      body.innerHTML = '<div class="ph-empty">No records found for this file number</div>';
      document.getElementById('phPatientName').textContent = 'Patient History';
      document.getElementById('phFileNo').textContent = fileNumber;
      document.getElementById('phBG').textContent = '—';
      return;
    }

    const { patient, summary, transfusions, deliveries } = data;
    document.getElementById('phPatientName').textContent = patient.name || 'Unknown Patient';
    document.getElementById('phFileNo').textContent = patient.file_number;
    document.getElementById('phBG').textContent =
      `${patient.blood_group || '?'} ${patient.rh_factor === 'Positive' ? '+' : patient.rh_factor === 'Negative' ? '−' : (patient.rh_factor || '')}`;

    const reactionHtml = summary.has_reactions ? `
      <div class="ph-reaction-alert">
        <div class="ph-alert-icon">⚠️</div>
        <div class="ph-alert-text">
          <strong>Previous Transfusion Reactions Recorded</strong>
          ${summary.reactions.map(r => `${r.date}: ${r.note}`).join('<br>')}
        </div>
      </div>` : '';

    // Build timeline: merge transfusions and deliveries sorted by date desc
    const timelineItems = [
      ...transfusions.map(r => ({ ...r, _type: 'transfusion' })),
      ...deliveries.map(r => ({ ...r, _type: 'delivery' })),
    ].sort((a, b) => (b.date + b.time) > (a.date + a.time) ? 1 : -1);

    const timelineHtml = timelineItems.map(r => {
      if (r._type === 'transfusion') {
        const comps = [];
        if (r.fpc_units) comps.push(`<span class="ph-comp-tag prc">PRC ×${r.fpc_units}</span>`);
        if (r.ffp_units) comps.push(`<span class="ph-comp-tag ffp">FFP ×${r.ffp_units}</span>`);
        if (r.plt_units) comps.push(`<span class="ph-comp-tag plt">PLT ×${r.plt_units}</span>`);
        const lsTag = r.life_saving ? '<span class="ph-ls-tag">LIFE-SAVING</span>' : '';
        return `
          <div class="ph-item${r.life_saving ? ' life-saving' : ''}">
            <div class="ph-item-type">
              <span class="ph-item-badge transfusion">Transfusion</span>
              <div class="ph-item-date">${r.date}</div>
            </div>
            <div class="ph-item-info">
              <div class="ph-item-comps">${comps.join('') || '<span class="ph-item-meta">No components</span>'}${lsTag}</div>
              <div class="ph-item-meta">Room: ${e(r.room) || '—'} · Dr. ${e(r.physician) || '—'}</div>
              ${r.prev_transfusion_reaction ? `<div class="ph-item-meta" style="color:#922B21">⚠ ${e(r.prev_transfusion_reaction)}</div>` : ''}
            </div>
            <div class="ph-item-time">${r.time || ''}</div>
          </div>`;
      } else {
        const lsTag = r.life_saving ? '<span class="ph-ls-tag">LIFE-SAVING</span>' : '';
        return `
          <div class="ph-item${r.life_saving ? ' life-saving' : ''}">
            <div class="ph-item-type">
              <span class="ph-item-badge delivery">Delivery</span>
              <div class="ph-item-date">${r.date}</div>
            </div>
            <div class="ph-item-info">
              <div class="ph-item-comps"><span class="ph-comp-tag">${e(deliveryComponentSummary(r)) || '—'}</span>${lsTag}</div>
              <div class="ph-item-meta">Room: ${e(r.room) || '—'} · Tech: ${e(r.technician_name) || '—'}</div>
              ${r.blood_unit_group ? `<div class="ph-item-meta">Unit group: ${e(r.blood_unit_group)}</div>` : ''}
            </div>
            <div class="ph-item-time">${r.time || ''}</div>
          </div>`;
      }
    }).join('');

    body.innerHTML = `
      <div class="ph-stats">
        <div class="ph-stat red">
          <div class="ph-stat-val">${summary.total_transfusions}</div>
          <div class="ph-stat-lbl">Transfusions</div>
        </div>
        <div class="ph-stat blue">
          <div class="ph-stat-val">${summary.total_deliveries}</div>
          <div class="ph-stat-lbl">Deliveries</div>
        </div>
        <div class="ph-stat orange">
          <div class="ph-stat-val">${summary.total_units}</div>
          <div class="ph-stat-lbl">Total Units</div>
        </div>
        <div class="ph-stat green">
          <div class="ph-stat-val">${summary.total_prc}/${summary.total_ffp}/${summary.total_plt}</div>
          <div class="ph-stat-lbl">PRC / FFP / PLT</div>
        </div>
      </div>
      ${reactionHtml}
      <div>
        <div class="ph-section-title">Full History (${timelineItems.length} records)</div>
        <div class="ph-timeline">${timelineHtml || '<div class="ph-empty">No records</div>'}</div>
      </div>`;

  } catch (err) {
    body.innerHTML = `<div class="ph-empty">Error loading history: ${err.message}</div>`;
  }
}
