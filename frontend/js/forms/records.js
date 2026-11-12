// Forms — record history, load into form, view/edit mode, UI helpers
// 
// Loaded as a classic script (shared global scope) — see index.html for load order.

// ═══════════════════════════════════════════════════════
// HISTORY
// ═══════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════
// HISTORY — with search & filter
// ═══════════════════════════════════════════════════════
let historyRecords = [];
let viewModeActive  = { t: false, d: false };
let editModeActive  = { t: false, d: false };
let currentEditRecord = null; // { id, form_type } when editing an existing record
let searchFilter   = 'all';
let searchTimer    = null;

async function loadHistory() {
  await doSearch();
}

function onSearchInput() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(doSearch, 300); // debounce 300ms
}

function setFilter(type) {
  searchFilter = type;
  document.getElementById('filterAll').classList.toggle('active', type === 'all');
  document.getElementById('filterTransfusion').classList.toggle('active', type === 'transfusion');
  document.getElementById('filterDelivery').classList.toggle('active', type === 'delivery');
  doSearch();
}

async function doSearch() {
  const q    = document.getElementById('searchInput').value.trim();
  const date = document.getElementById('searchDate').value;
  const grid = document.getElementById('historyGrid');
  const stats = document.getElementById('searchStats');

  // Show loading
  grid.innerHTML = '<div class="empty-msg"><div class="empty-text">Searching…</div></div>';

  try {
    const params = new URLSearchParams({ q, type: searchFilter, date });
    const url = `${API}/history/search?${params}`;

    const res  = await apiFetch(url);
    if (!res) return;
    const rows = await res.json();

    if (!Array.isArray(rows) || !rows.length) {
      historyRecords = [];
      stats.innerHTML = '';
      grid.innerHTML = `
        <div class="no-results">
          <div class="no-results-icon">🔍</div>
          <div class="no-results-text">${q ? `No records found for "<strong>${q}</strong>"` : 'No records yet.'}</div>
        </div>`;
      return;
    }

    historyRecords = rows;
    const tCount = rows.filter(r => r.form_type === 'transfusion').length;
    const dCount = rows.filter(r => r.form_type === 'delivery').length;
    stats.innerHTML = `<strong>${rows.length}</strong> record${rows.length !== 1 ? 's' : ''} &nbsp;·&nbsp; ${tCount} transfusion${tCount !== 1 ? 's' : ''}, ${dCount} deliver${dCount !== 1 ? 'ies' : 'y'}`;

    grid.innerHTML = rows.map((r, idx) => {
      // Highlight matching text
      const hl = (str) => {
        const safe = e(str);
        if (!q || !safe) return safe;
        const re = new RegExp(`(${e(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
        return safe.replace(re, '<mark class="highlight">$1</mark>');
      };

      return `
        <div class="hcard" id="hc-${r.id}-${r.form_type}" onclick="loadRecordIntoForm(${idx})" title="Click to load into form">
          <div class="hcard-top">
            <span class="hcard-type ${r.form_type}">${r.form_type === 'transfusion' ? '🩸 Transfusion' : '🚚 Delivery'}</span>
            <span class="hcard-time">${new Date(r.created_at.replace(' ', 'T')).toLocaleString('en-GB')}</span>
          </div>
          ${r.patient_name ? `<div class="hcard-row">👤 <strong>${hl(r.patient_name)}</strong></div>` : ''}
          ${r.file_number  ? `<div class="hcard-row">📋 File: ${hl(r.file_number)}</div>` : ''}
          ${r.diagnosis    ? `<div class="hcard-row">🏥 ${hl(r.diagnosis)}</div>` : ''}
          ${r.blood_group  ? `<div class="hcard-row">🩸 ${r.blood_group}${r.rh_factor ? ' ' + r.rh_factor : ''}</div>` : ''}
          ${r.room         ? `<div class="hcard-row">🚪 Room ${r.room}</div>` : ''}
          ${r.saved_by     ? `<div class="hcard-row" style="font-size:11px;color:#888;margin-top:4px">👤 Saved by: ${r.saved_by}</div>` : ''}
          ${r.signed_by_user_id ? `<div class="hcard-row" style="font-size:11px;color:#8a6d00;margin-top:2px">🔒 Signed by ${hl(r.signed_by_name) || 'someone'} — locked</div>` : ''}
          ${currentUser?.role === 'admin' && (!r.signed_by_user_id || r.signed_by_user_id === currentUser.userId) ? `<button class="btn-del delete-btn" onclick="event.stopPropagation();deleteRecord(${r.id},'${r.form_type}')">🗑 Delete</button>` : ''}
        </div>`;
    }).join('');

  } catch {
    grid.innerHTML = '<div class="empty-msg"><div class="empty-icon">⚠️</div><div class="empty-text">Could not load — is the server running?</div></div>';
  }
}

// ═══════════════════════════════════════════════════════
// LOAD RECORD INTO FORM
// ═══════════════════════════════════════════════════════
function loadRecordIntoForm(idx) {
  const r = historyRecords[idx];
  if (!r) return;
  const formType = r.form_type;
  const prefix = formType === 'transfusion' ? 't' : 'd';
  document.querySelectorAll('.hcard').forEach(c => c.classList.remove('selected'));
  const card = document.getElementById('hc-' + r.id + '-' + r.form_type);
  if (card) card.classList.add('selected');
  setForm(formType);
  clearForm(prefix);

  if (formType === 'transfusion') {
    // Rebuild any extra Blood Components rows BEFORE fillFromRecord, so it
    // fills the freshly-rendered first-row inputs (t_fpc_units, t_irr_units,
    // ...) rather than ones a later render would wipe out.
    applyTComponentsFromJson(r.components_json);
    applyTUnitComponentsFromRecord(r);
    fillFromRecord('t', {
      request_date: r.request_date ? r.request_date.split('T')[0] : '',
      request_time: r.request_time || '',
      room: r.room || '',
      patient_name: r.patient_name || '',
      file_number: r.file_number || '',
      blood_group: r.blood_group || '',
      rh: r.rh_factor || '',
      diagnosis: r.diagnosis || '',
      fpc_units: r.fpc_units || '',
      fpc_type: r.fpc_type || '',
      ffp_units: r.ffp_units || '',
      ffp_type: r.ffp_type || '',
      plt_units: r.plt_units || '',
      plt_type: r.plt_type || '',
      irr_units: r.irr_units || '',
      irr_type: r.irr_type || '',
      bb_date: r.blood_bank_date ? r.blood_bank_date.split('T')[0] : '',
      bb_time: r.blood_bank_time || '',
      physician: r.physician || '',
      physician_signature: r.physician_signature || '',
      phlebotomist: r.phlebotomist || '',
    });
    if (r.previous_transfusion) document.getElementById('t_prev_yes').checked = true;
    else document.getElementById('t_prev_no').checked = true;
    if (r.prev_transfusion_place)    setVal('t_prev_place',    r.prev_transfusion_place);
    if (r.prev_transfusion_reaction) setVal('t_prev_reaction', r.prev_transfusion_reaction);
    if (r.life_saving)               document.getElementById('t_life_saving').checked = true;
    if (r.life_saving_physician)     setVal('t_ls_physician',  r.life_saving_physician);
    if (r.life_saving_signature)     setVal('t_ls_signature',  r.life_saving_signature);
    if (r.life_saving_time)          setVal('t_ls_time',       r.life_saving_time);
  } else {
    // Rebuild any extra Components Issued rows BEFORE fillFromRecord, so it
    // fills the freshly-rendered first-row inputs (d_fpc_units, ...) rather
    // than ones a later render would wipe out.
    applyDComponentsFromJson(r.components_json);
    fillFromRecord('d', {
      patient_name: r.patient_name || '',
      file_number: r.file_number || '',
      blood_group: r.blood_group || '',
      rh: r.rh_factor || '',
      room: r.room || '',
      allergy_details: r.allergy_details || '',
      blood_unit_numbers: r.blood_unit_numbers || '',
      fpc_units: r.fpc_units || '',
      ffp_units: r.ffp_units || '',
      plt_units: r.plt_units || '',
      irr_units: r.irr_units || '',
      blood_unit_group: r.blood_unit_group || '',
      patient_bg_delivery: r.patient_blood_group_delivery || '',
      technician: r.technician || '',
      orderly: r.orderly || '',
      nurse: r.nurse || '',
      delivery_date: r.delivery_date ? r.delivery_date.split('T')[0] : '',
      delivery_time: r.delivery_time || '',
      leakage: r.leakage || '',
      gases: r.gases || '',
      volume: r.volume || '',
      expiry_date: r.expiry_date ? r.expiry_date.split('T')[0] : '',
      temperature: r.temperature || '',
      received_by: r.received_by || '',
      nurse_received_by: r.nurse_unit_received_by || '',
      nurse_name:        r.nurse_unit_name || '',
      nurse_date:        r.nurse_unit_date ? r.nurse_unit_date.split('T')[0] : '',
      nurse_time:        r.nurse_unit_time || '',
    });
    if (r.life_saving)           document.getElementById('d_life_saving').checked = true;
    if (r.life_saving_physician) setVal('d_ls_physician', r.life_saving_physician);
    if (r.life_saving_signature) setVal('d_ls_signature', r.life_saving_signature);
    if (r.life_saving_time)      setVal('d_ls_time',      r.life_saving_time);
  }
  refreshAllSignaturePads(); // paint the loaded record's signatures onto their canvases

  currentEditRecord = {
    id: r.id, form_type: r.form_type,
    signed_by_user_id: r.signed_by_user_id || null,
    signed_by_name:    r.signed_by_name || null,
  };
  enterViewMode(prefix, r.patient_name || 'Unknown');
  document.getElementById(formType === 'transfusion' ? 'cardTransfusion' : 'cardDelivery')
    .scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function setVal(id, val) {
  const el = document.getElementById(id);
  if (el && val) el.value = String(val);
}

function fillFromRecord(prefix, data) {
  for (const [key, val] of Object.entries(data)) {
    const el = document.getElementById(prefix + '_' + key);
    if (el && val) {
      el.value = String(val);
      el.classList.remove('voice-hit');
      void el.offsetWidth;
      el.classList.add('voice-hit');
      setTimeout(() => el.classList.remove('voice-hit'), 1200);
    }
  }
}

// ═══════════════════════════════════════════════════════
// VIEW / EDIT MODE
// ═══════════════════════════════════════════════════════
// True once a record carries a signature belonging to someone other than
// the logged-in user — the server enforces this for real (even against an
// admin); this just keeps the UI from offering an Edit that would 403.
function isRecordLockedForCurrentUser() {
  return !!(currentEditRecord?.signed_by_user_id && currentEditRecord.signed_by_user_id !== currentUser?.userId);
}

function enterViewMode(prefix, patientName) {
  const card = document.getElementById(prefix === 't' ? 'cardTransfusion' : 'cardDelivery');
  card.classList.add('view-mode');
  viewModeActive[prefix] = true;
  editModeActive[prefix] = false;
  document.getElementById(prefix + '_editBar').classList.add('show');
  document.getElementById(prefix + '_editName').textContent = patientName;
  const editBtn  = document.getElementById(prefix + '_editBtn');
  const editHint = document.getElementById(prefix + '_editHint');
  const locked   = isRecordLockedForCurrentUser();
  editBtn.textContent = '✏️ Edit';
  editBtn.classList.remove('editing');
  editBtn.style.display = locked ? 'none' : '';
  if (editHint) {
    editHint.innerHTML = locked
      ? `🔒 Signed by <b>${currentEditRecord.signed_by_name || 'another user'}</b> — only they can edit`
      : 'Click <b>Edit</b> to modify';
  }
  document.getElementById(prefix + '_saveBtn').disabled = true;
  document.getElementById(prefix + '_saveBtn').style.opacity = '0.4';
}

function toggleEditMode(prefix) {
  if (isRecordLockedForCurrentUser()) {
    alert(`🔒 This record was signed by ${currentEditRecord.signed_by_name || 'another user'} — only they can edit it.`);
    return;
  }
  const card    = document.getElementById(prefix === 't' ? 'cardTransfusion' : 'cardDelivery');
  const editBtn = document.getElementById(prefix + '_editBtn');
  const saveBtn = document.getElementById(prefix + '_saveBtn');
  if (!editModeActive[prefix]) {
    card.classList.remove('view-mode');
    editModeActive[prefix] = true;
    editBtn.textContent = '🔒 Lock';
    editBtn.classList.add('editing');
    saveBtn.disabled = false;
    saveBtn.style.opacity = '1';
    saveBtn.textContent = '💾 Update Record';
    saveBtn.classList.add('updating');
  } else {
    card.classList.add('view-mode');
    editModeActive[prefix] = false;
    editBtn.textContent = '✏️ Edit';
    editBtn.classList.remove('editing');
    saveBtn.disabled = true;
    saveBtn.style.opacity = '0.4';
    saveBtn.textContent = '💾 Update Record';
  }
}

function exitViewMode(prefix) {
  const card = document.getElementById(prefix === 't' ? 'cardTransfusion' : 'cardDelivery');
  card.classList.remove('view-mode');
  viewModeActive[prefix] = false;
  editModeActive[prefix] = false;
  document.getElementById(prefix + '_editBar').classList.remove('show');
  const saveBtn = document.getElementById(prefix + '_saveBtn');
  saveBtn.disabled = false;
  saveBtn.style.opacity = '1';
  saveBtn.textContent = '💾 Save Record';
  saveBtn.classList.remove('updating');
  currentEditRecord = null;
  clearForm(prefix);
  document.querySelectorAll('.hcard').forEach(c => c.classList.remove('selected'));
}

async function deleteRecord(id, formType) {
  if (!confirm('Delete this record?')) return;
  try {
    const res    = await apiFetch(`${API}/history/${id}?form_type=${formType}`, { method: 'DELETE' });
    const result = res && await res.json();
    if (!result || !result.success) {
      alert('❌ ' + (result?.error || 'Delete failed'));
      return;
    }
  } catch {
    alert('❌ Cannot reach server');
    return;
  }
  document.getElementById(`hc-${id}-${formType}`)?.remove();
  // Update stats
  historyRecords = historyRecords.filter(r => !(r.id === id && r.form_type === formType));
  const stats = document.getElementById('searchStats');
  if (historyRecords.length === 0) {
    document.getElementById('historyGrid').innerHTML = '<div class="no-results"><div class="no-results-icon">📋</div><div class="no-results-text">No records.</div></div>';
    stats.innerHTML = '';
  }
}

// ═══════════════════════════════════════════════════════
// UI HELPERS
// ═══════════════════════════════════════════════════════
function setStatus(type, text, dot = false) {
  const el = document.getElementById('voiceStatus');
  el.className = 'voice-status ' + type;
  el.innerHTML = `<div class="vs-dot${dot ? ' pulse' : ''}"></div><span>${text}</span>`;
}

function showTranscript(text) {
  if (!text) return;
  document.getElementById('transcriptText').textContent = text;
  const strip = document.getElementById('transcriptStrip');
  strip.classList.add('show');
  setTimeout(() => strip.classList.remove('show'), 9000);
}

function showToast(field, value) {
  const stack = document.getElementById('flashStack');
  const toast = document.createElement('div');
  toast.className = 'flash-toast';
  toast.innerHTML = `<div class="ft-field">${field}</div><div class="ft-value">${value}</div>`;
  stack.appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}
