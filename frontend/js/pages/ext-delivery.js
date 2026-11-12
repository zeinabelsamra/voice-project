// External delivery form
// 
// Loaded as a classic script (shared global scope) — see index.html for load order.

// ═══════════════════════════════════════════════════════
// EXTERNAL DELIVERY FORM
// ═══════════════════════════════════════════════════════
let currentExtId = null;

const EXT_FIXED   = { frbc:'Filtered RBC', ffp:'FFP', plt:'Platelets' };
const EXT_BG_OPTS = ['','A+','A-','B+','B-','AB+','AB-','O+','O-'];

function defaultExtComponents() {
  return [
    { key:'frbc', label:'Filtered RBC', unit_no:'', blood_group:'', expiry_date:'', notes:'' },
    { key:'ffp',  label:'FFP',          unit_no:'', blood_group:'', expiry_date:'', notes:'' },
    { key:'plt',  label:'Platelets',    unit_no:'', blood_group:'', expiry_date:'', notes:'' },
    { key:'oth1', label:'',             unit_no:'', blood_group:'', expiry_date:'', notes:'' },
    { key:'oth2', label:'',             unit_no:'', blood_group:'', expiry_date:'', notes:'' },
  ];
}
let extComponents = defaultExtComponents();

function escHtml(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function syncExtComp(idx, field, value) {
  if (extComponents[idx]) extComponents[idx][field] = value;
}

function addExtCompRow(key) {
  let lastIdx = -1, lastLabel = '';
  extComponents.forEach((c,i) => { if(c.key===key){ lastIdx=i; lastLabel=c.label||''; } });
  if (lastIdx === -1) return;
  extComponents.splice(lastIdx + 1, 0, {
    key, label: EXT_FIXED[key] || lastLabel,
    unit_no:'', blood_group:'', expiry_date:'', notes:''
  });
  renderExtCompTable();
}

function removeExtCompRow(idx) {
  extComponents.splice(idx, 1);
  renderExtCompTable();
}

function renderExtCompTable() {
  const tbody = document.getElementById('extCompBody');
  if (!tbody) return;
  const lastOfKey = {};
  extComponents.forEach((c,i) => { lastOfKey[c.key] = i; });
  const seenKeys = {};
  tbody.innerHTML = extComponents.map((c, idx) => {
    const isFirst = !seenKeys[c.key]; seenKeys[c.key] = true;
    const isLast  = lastOfKey[c.key] === idx;
    const fixed   = EXT_FIXED[c.key];
    const nameCell = fixed
      ? `<td class="ext-comp-label" style="${isFirst?'':'color:var(--text-soft);font-style:italic;font-size:11px'}">${fixed}</td>`
      : `<td><input type="text" style="width:100%;padding:5px 7px;border:1.5px solid var(--border);border-radius:4px;font-size:12px;font-family:inherit" value="${escHtml(c.label)}" oninput="syncExtComp(${idx},'label',this.value)" placeholder="Component name…"/></td>`;
    const bgOpts = EXT_BG_OPTS.map(o=>`<option value="${o}"${o===c.blood_group?' selected':''}>${o||'—'}</option>`).join('');
    const addBtn = isLast  ? `<button type="button" class="comp-add-btn" onclick="addExtCompRow('${c.key}')" title="Add row">+</button>` : '';
    const remBtn = !isFirst ? `<button type="button" class="comp-rem-btn" onclick="removeExtCompRow(${idx})" title="Remove row">−</button>` : '';
    return `<tr>${nameCell}
      <td><input type="text" class="comp-input" value="${escHtml(c.unit_no)}" oninput="syncExtComp(${idx},'unit_no',this.value)" placeholder="Unit #"/></td>
      <td><select class="comp-input" onchange="syncExtComp(${idx},'blood_group',this.value)">${bgOpts}</select></td>
      <td><input type="date" class="comp-input" value="${escHtml(c.expiry_date)}" onchange="syncExtComp(${idx},'expiry_date',this.value)"/></td>
      <td><input type="text" class="comp-input" value="${escHtml(c.notes)}" oninput="syncExtComp(${idx},'notes',this.value)" placeholder="Notes"/></td>
      <td class="comp-btn-cell">${addBtn}${remBtn}</td></tr>`;
  }).join('');
}

function clearExtForm() {
  currentExtId = null;
  document.getElementById('ex_saveBtn').textContent = '💾 Save Record';
  ['ex_patient_name','ex_destination','ex_delivery_date','ex_delivery_hour','ex_technician_name'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  ['ex_test_hiv','ex_test_hbsag','ex_test_hcv','ex_test_hb_core','ex_test_sts','ex_test_iat','ex_test_kell'].forEach(id => {
    const el = document.getElementById(id); if (el) el.checked = false;
  });
  document.querySelectorAll('input[name="ex_integrity"]').forEach(r => r.checked = false);
  extComponents = defaultExtComponents();
  renderExtCompTable();
}

function collectExtFields() {
  const integrityEl = document.querySelector('input[name="ex_integrity"]:checked');
  const g  = id => (document.getElementById(id)?.value || '').trim();
  const gd = id => document.getElementById(id)?.value || null;
  const gc = id => document.getElementById(id)?.checked ? 1 : 0;
  return {
    patient_name:    g('ex_patient_name'),
    destination:     g('ex_destination'),
    delivery_date:   gd('ex_delivery_date'),
    delivery_hour:   g('ex_delivery_hour'),
    technician_name: g('ex_technician_name'),
    test_hiv:     gc('ex_test_hiv'),   test_hbsag:   gc('ex_test_hbsag'),
    test_hcv:     gc('ex_test_hcv'),   test_hb_core: gc('ex_test_hb_core'),
    test_sts:     gc('ex_test_sts'),   test_iat:     gc('ex_test_iat'),
    test_kell:    gc('ex_test_kell'),
    integrity:    integrityEl ? integrityEl.value : null,
    components:   extComponents
  };
}

async function saveExtDelivery() {
  const fields = collectExtFields();
  if (!fields.patient_name) { showToast('Patient name is required.', 'error'); return; }
  const btn = document.getElementById('ex_saveBtn');
  btn.disabled = true;
  try {
    let res;
    if (currentExtId) {
      res = await apiFetch(`${API}/ext-delivery/${currentExtId}`, { method: 'PUT', body: fields });
    } else {
      res = await apiFetch(`${API}/ext-delivery/save`, { method: 'POST', body: fields });
    }
    if (!res) return;
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'Save failed.', 'error'); return; }
    showToast(currentExtId ? 'Record updated.' : 'Record saved.', 'success');
    currentExtId = null;
    btn.textContent = '💾 Save Record';
    clearExtForm();
    loadExtHistory();
  } catch { showToast('Server error.', 'error'); }
  finally  { btn.disabled = false; }
}

async function loadExtHistory() {
  const grid = document.getElementById('extHistoryGrid');
  if (!grid) return;
  grid.innerHTML = '<div class="empty-msg"><div class="empty-icon">⏳</div><div class="empty-text">Loading…</div></div>';
  try {
    const res = await apiFetch(`${API}/ext-delivery`);
    if (!res) return;
    const rows = await res.json();
    if (!rows.length) {
      grid.innerHTML = '<div class="empty-msg"><div class="empty-icon">🚚</div><div class="empty-text">No records yet.</div></div>';
      return;
    }
    const TEST_LABELS = { test_hiv:'HIV', test_hbsag:'HBsAg', test_hcv:'HCV', test_hb_core:'HB Core', test_sts:'STS', test_iat:'IAT', test_kell:'Kell' };
    grid.innerHTML = rows.map(r => {
      const dateStr  = r.delivery_date ? r.delivery_date.slice(0, 10) : null;
      const timeStr  = r.delivery_hour || null;
      const metaLine = [dateStr, timeStr].filter(Boolean).join(' · ') || '—';

      // Integrity badge
      const intBadge = r.integrity === 'yes'
        ? '<span class="ext-badge intact">✓ Intact</span>'
        : r.integrity === 'no'
          ? '<span class="ext-badge not-intact">✗ Not Intact</span>'
          : '';

      // Components — only rows that have at least a unit number or blood group
      const comps = (r.components || []).filter(c => c.unit_no || c.blood_group || c.expiry_date);
      const compHtml = comps.length ? `
        <div class="ext-card-section">
          <div class="ext-section-title">Blood Components</div>
          <table class="ext-comp-table">
            <thead><tr><th>Component</th><th>Unit No.</th><th>Group</th><th>Expiry</th></tr></thead>
            <tbody>${comps.map(c => `<tr>
              <td class="ext-comp-label">${c.label || c.key}</td>
              <td style="font-family:'JetBrains Mono',monospace;font-size:11px">${c.unit_no || '—'}</td>
              <td><strong>${c.blood_group || '—'}</strong></td>
              <td style="color:var(--text-soft)">${c.expiry_date || '—'}</td>
            </tr>`).join('')}</tbody>
          </table>
        </div>` : '';

      // Tests — show confirmed ones as green chips
      const confirmedTests = Object.keys(TEST_LABELS).filter(k => r[k]);
      const testHtml = `
        <div class="ext-card-section">
          <div class="ext-section-title">Serology Tests</div>
          <div class="ext-tests">
            ${Object.entries(TEST_LABELS).map(([k, label]) =>
              `<span class="ext-test-chip ${r[k] ? '' : 'pending'}">${r[k] ? '✓' : '○'} ${label}</span>`
            ).join('')}
          </div>
        </div>`;

      const isAdmin = currentUser?.role === 'admin';
      return `
        <div class="ext-card">
          <div class="ext-card-head">
            <div>
              <div class="ext-card-name">${r.patient_name || '—'}</div>
              <div class="ext-card-meta">📅 ${metaLine}</div>
            </div>
            <div class="ext-card-badges">
              ${intBadge}
            </div>
          </div>
          <div class="ext-card-body">
            <div class="ext-info-row">
              <span class="ext-info-icon">📍</span>
              <span class="ext-info-label">Destination</span>
              <span class="ext-info-val">${r.destination || '—'}</span>
            </div>
            <div class="ext-info-row">
              <span class="ext-info-icon">👤</span>
              <span class="ext-info-label">Technician</span>
              <span class="ext-info-val">${r.technician_name || '—'}</span>
            </div>
            ${compHtml}
            ${testHtml}
          </div>
          <div class="ext-card-actions">
            <button class="ext-act-btn primary" onclick="viewExtRecord(${r.delivery_id})">✏️ Edit</button>
            <button class="ext-act-btn" onclick="exportExtFromRecord(${r.delivery_id},'pdf')">📄 PDF</button>
            <button class="ext-act-btn" onclick="exportExtFromRecord(${r.delivery_id},'docx')">📝 Word</button>
            ${isAdmin ? `<button class="ext-act-btn danger" onclick="deleteExtRecord(${r.delivery_id})">🗑️ Delete</button>` : ''}
          </div>
        </div>`;
    }).join('');
  } catch { grid.innerHTML = '<div class="empty-msg"><div class="empty-text">Could not load history.</div></div>'; }
}

async function viewExtRecord(id) {
  const res = await apiFetch(`${API}/ext-delivery`);
  if (!res) return;
  const rows = await res.json();
  const r = rows.find(x => x.delivery_id === id);
  if (!r) return;
  currentExtId = id;
  const set = (elId, val) => { const el = document.getElementById(elId); if (el) el.value = val || ''; };
  set('ex_patient_name',    r.patient_name);
  set('ex_destination',     r.destination);
  set('ex_delivery_date',   r.delivery_date ? r.delivery_date.slice(0,10) : '');
  set('ex_delivery_hour',   r.delivery_hour);
  set('ex_technician_name', r.technician_name);
  const chk = (elId, val) => { const el = document.getElementById(elId); if (el) el.checked = !!val; };
  chk('ex_test_hiv',    r.test_hiv);  chk('ex_test_hbsag', r.test_hbsag); chk('ex_test_hcv',  r.test_hcv);
  chk('ex_test_hb_core',r.test_hb_core); chk('ex_test_sts', r.test_sts); chk('ex_test_iat',  r.test_iat);
  chk('ex_test_kell',   r.test_kell);
  extComponents = (r.components && r.components.length) ? r.components.map(c => ({ ...c })) : defaultExtComponents();
  renderExtCompTable();
  if (r.integrity) {
    const radio = document.querySelector(`input[name="ex_integrity"][value="${r.integrity}"]`);
    if (radio) radio.checked = true;
  }
  document.getElementById('ex_saveBtn').textContent = '💾 Update Record';
  window.scrollTo({ top: document.getElementById('extDelSection').offsetTop - 20, behavior: 'smooth' });
}

async function deleteExtRecord(id) {
  if (!confirm('Delete this external delivery record?')) return;
  const res = await apiFetch(`${API}/ext-delivery/${id}`, { method: 'DELETE' });
  if (!res) return;
  if (res.ok) { showToast('Record deleted.', 'success'); loadExtHistory(); }
  else { const d = await res.json(); showToast(d.error || 'Delete failed.', 'error'); }
}

async function exportExtDelivery(type) {
  const fields = collectExtFields();
  const endpoint = type === 'pdf' ? '/ext-delivery/export/pdf' : '/ext-delivery/export/docx';
  const mimeType = type === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const ext      = type === 'pdf' ? 'pdf' : 'docx';
  try {
    const res = await apiFetch(`${API}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields)
    });
    if (!res || !res.ok) { showToast('Export failed.', 'error'); return; }
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `ext-delivery-${Date.now()}.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch { showToast('Export error.', 'error'); }
}

async function exportExtFromRecord(id, type) {
  const res = await apiFetch(`${API}/ext-delivery`);
  if (!res) return;
  const rows = await res.json();
  const r = rows.find(x => x.delivery_id === id);
  if (!r) return;
  // Populate form silently then export
  const savedId = currentExtId;
  currentExtId = id;
  // Build fields object directly from record
  const intVal = r.integrity || null;
  const fields = {
    patient_name: r.patient_name, destination: r.destination,
    delivery_date: r.delivery_date ? r.delivery_date.slice(0,10) : null,
    delivery_hour: r.delivery_hour, technician_name: r.technician_name,
    frbc_unit_no: r.frbc_unit_no, frbc_blood_group: r.frbc_blood_group,
    frbc_expiry_date: r.frbc_expiry_date ? r.frbc_expiry_date.slice(0,10) : null, frbc_notes: r.frbc_notes,
    ffp_unit_no: r.ffp_unit_no, ffp_blood_group: r.ffp_blood_group,
    ffp_expiry_date: r.ffp_expiry_date ? r.ffp_expiry_date.slice(0,10) : null, ffp_notes: r.ffp_notes,
    plt_unit_no: r.plt_unit_no, plt_blood_group: r.plt_blood_group,
    plt_expiry_date: r.plt_expiry_date ? r.plt_expiry_date.slice(0,10) : null, plt_notes: r.plt_notes,
    other1_component: r.other1_component, other1_unit_no: r.other1_unit_no,
    other1_blood_group: r.other1_blood_group,
    other1_expiry_date: r.other1_expiry_date ? r.other1_expiry_date.slice(0,10) : null, other1_notes: r.other1_notes,
    other2_component: r.other2_component, other2_unit_no: r.other2_unit_no,
    other2_blood_group: r.other2_blood_group,
    other2_expiry_date: r.other2_expiry_date ? r.other2_expiry_date.slice(0,10) : null, other2_notes: r.other2_notes,
    test_hiv: r.test_hiv, test_hbsag: r.test_hbsag, test_hcv: r.test_hcv,
    test_hb_core: r.test_hb_core, test_sts: r.test_sts, test_iat: r.test_iat, test_kell: r.test_kell,
    integrity: intVal,
    components: r.components || null
  };
  const endpoint = type === 'pdf' ? '/ext-delivery/export/pdf' : '/ext-delivery/export/docx';
  const ext      = type === 'pdf' ? 'pdf' : 'docx';
  currentExtId = savedId;
  try {
    const res2 = await apiFetch(`${API}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields)
    });
    if (!res2 || !res2.ok) { showToast('Export failed.', 'error'); return; }
    const blob = await res2.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `ext-delivery-${r.patient_name || id}.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch { showToast('Export error.', 'error'); }
}
