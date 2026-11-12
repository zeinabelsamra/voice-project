// Forms — component tables and signature pads
// Top-level state (tComponents, dComponents…) is initialised here.
// Loaded as a classic script (shared global scope) — see index.html for load order.

// ═══════════════════════════════════════════════════════
// BLOOD COMPONENTS (transfusion) — same "+ add another row" concept as the
// External Delivery components table (see extComponents/renderExtCompTable
// below), applied to Filtered Packed Cells / F.F.P / Platelets / Irradiated
// RBC. Each type's FIRST row keeps the original fixed ids (t_fpc_units,
// t_fpc_type, t_fpc_check, ...) so voice-fill and FIELD_MAP keep working
// completely unchanged; rows added via "+" have no id and are carried in
// components_json instead (see collectExtraTComponents / saveForm).
// "Others" is a separate, always-single, static row — untouched by this.
// ═══════════════════════════════════════════════════════
const T_COMP_FIXED     = { fpc:'Filtered Packed Cells', ffp:'F.F.P', plt:'Platelets', irr:'Irradiated RBC' };
const T_COMP_TYPE_OPTS = ['', 'Pre-Op 24hrs', 'Routine', 'Stat', 'Emergent (<15 min)'];

function defaultTComponents() {
  return Object.keys(T_COMP_FIXED).map(key => ({ key, units:'', type:'', checked:false }));
}
let tComponents = defaultTComponents();

function syncTComp(idx, field, value) {
  if (tComponents[idx]) tComponents[idx][field] = value;
}

function addTCompRow(key) {
  let lastIdx = -1;
  tComponents.forEach((c, i) => { if (c.key === key) lastIdx = i; });
  if (lastIdx === -1) return;
  tComponents.splice(lastIdx + 1, 0, { key, units:'', type:'', checked:false });
  renderTCompTable();
}

function removeTCompRow(idx) {
  tComponents.splice(idx, 1);
  renderTCompTable();
}

function renderTCompTable() {
  const tbody = document.getElementById('tCompBody');
  if (!tbody) return;
  const seenKeys = {};
  tbody.innerHTML = tComponents.map((c, idx) => {
    const isFirst = !seenKeys[c.key]; seenKeys[c.key] = true;
    const label   = T_COMP_FIXED[c.key] || '';
    // Only the first row of each key keeps the fixed id — see header note above.
    const unitsAttr = isFirst ? ` id="t_${c.key}_units"` : '';
    const typeAttr  = isFirst ? ` id="t_${c.key}_type"`  : '';
    const checkAttr = isFirst ? ` id="t_${c.key}_check"` : '';
    const nameCell  = `<td class="comp-name"${isFirst ? '' : ' style="color:var(--text-soft);font-style:italic;font-size:11px"'}>${label}</td>`;
    const typeOpts  = T_COMP_TYPE_OPTS.map(o => `<option value="${escHtml(o)}"${o === c.type ? ' selected' : ''}>${escHtml(o) || '—'}</option>`).join('');
    const remBtn    = !isFirst ? `<button type="button" class="comp-rem-btn" onclick="removeTCompRow(${idx})" title="Remove row">−</button>` : '';
    return `<tr>
      ${nameCell}
      <td><input type="number" min="0"${unitsAttr} value="${escHtml(c.units)}" oninput="syncTComp(${idx},'units',this.value)" placeholder="0"/></td>
      <td><select${typeAttr} onchange="syncTComp(${idx},'type',this.value)">${typeOpts}</select></td>
      <td><input type="checkbox"${checkAttr} ${c.checked ? 'checked' : ''} style="width:14px;height:14px;accent-color:var(--blood)" onchange="syncTComp(${idx},'checked',this.checked)"/></td>
      <td class="comp-btn-cell">${remBtn}</td>
    </tr>`;
  }).join('');
}

// Extra (index > 1) rows per key — the first row of each key is already
// captured by the legacy fpc_units/fpc_type-style FIELD_MAP fields, so only
// what's beyond that needs to travel separately as components_json.
function collectExtraTComponents() {
  const seen  = new Set();
  const extra = [];
  tComponents.forEach(c => {
    if (!seen.has(c.key)) { seen.add(c.key); return; }
    extra.push({ key: c.key, units: c.units || '', type: c.type || '', checked: !!c.checked });
  });
  return extra;
}

// Rebuilds the full tComponents array (one row per key, plus any saved
// extras spliced back into place) from a components_json string/array —
// used when loading a saved record or restoring a draft.
function rebuildTComponentsWithExtras(extras) {
  const base = defaultTComponents();
  (Array.isArray(extras) ? extras : []).forEach(extra => {
    if (!extra || !T_COMP_FIXED[extra.key]) return;
    let lastIdx = -1;
    base.forEach((c, i) => { if (c.key === extra.key) lastIdx = i; });
    if (lastIdx === -1) return;
    base.splice(lastIdx + 1, 0, { key: extra.key, units: extra.units || '', type: extra.type || '', checked: !!extra.checked });
  });
  return base;
}

function applyTComponentsFromJson(jsonStr) {
  let extras = [];
  try { extras = jsonStr ? JSON.parse(jsonStr) : []; } catch { extras = []; }
  tComponents = rebuildTComponentsWithExtras(extras);
  renderTCompTable();
}

document.addEventListener('DOMContentLoaded', () => renderTCompTable());

// ═══════════════════════════════════════════════════════
// COMPATIBLE BLOOD UNITS (transfusion) — one row per issued unit, grouped
// by component (Filtered Packed Cells / F.F.P / Platelets / Irradiated
// RBC — same labels as T_COMP_FIXED above) and identified by its Unit #,
// plus a free-text "Other" component (mirrors the Others row on the Blood
// Components Requested table). "+" adds another Unit # row for that same
// component. Travels as blood_unit_entries_json — the old flat
// blood_unit_1..8 columns are no longer written to from this UI.
// ═══════════════════════════════════════════════════════
function defaultTUnitComponents() {
  const base = Object.keys(T_COMP_FIXED).map(key => ({ key, unit_no:'' }));
  base.push({ key:'other', name:'', unit_no:'' });
  return base;
}
let tUnitComponents = defaultTUnitComponents();

function syncTUnitComp(idx, field, value) {
  if (tUnitComponents[idx]) tUnitComponents[idx][field] = value;
}

function addTUnitCompRow(key) {
  let lastIdx = -1;
  tUnitComponents.forEach((c, i) => { if (c.key === key) lastIdx = i; });
  if (lastIdx === -1) return;
  tUnitComponents.splice(lastIdx + 1, 0, { key, unit_no:'' });
  renderTUnitCompTable();
}

function removeTUnitCompRow(idx) {
  tUnitComponents.splice(idx, 1);
  renderTUnitCompTable();
}

function renderTUnitCompTable() {
  const tbody = document.getElementById('tUnitCompBody');
  if (!tbody) return;
  const lastOfKey = {};
  tUnitComponents.forEach((c, i) => { lastOfKey[c.key] = i; });
  const seenKeys = {};
  // Name typed into the first "Other" row — shared by any extra Other rows.
  const otherName = (tUnitComponents.find(c => c.key === 'other') || {}).name || '';
  tbody.innerHTML = tUnitComponents.map((c, idx) => {
    const isFirst = !seenKeys[c.key]; seenKeys[c.key] = true;
    const isLast  = lastOfKey[c.key] === idx;
    const isOther = c.key === 'other';
    const label   = isOther ? otherName : (T_COMP_FIXED[c.key] || '');
    const nameCell = isOther && isFirst
      ? `<td><input type="text" value="${escHtml(c.name || '')}" oninput="syncTUnitComp(${idx},'name',this.value)" placeholder="Other component…"/></td>`
      : `<td class="comp-name"${isFirst ? '' : ' style="color:var(--text-soft);font-style:italic;font-size:11px"'}>${escHtml(label) || (isOther ? 'Other' : '')}</td>`;
    const addBtn   = isLast   ? `<button type="button" class="comp-add-btn" onclick="addTUnitCompRow('${c.key}')" title="Add another ${escHtml(label) || 'Other'} unit">+</button>` : '';
    const remBtn   = !isFirst ? `<button type="button" class="comp-rem-btn" onclick="removeTUnitCompRow(${idx})" title="Remove unit">−</button>` : '';
    return `<tr>
      ${nameCell}
      <td><input type="text" value="${escHtml(c.unit_no)}" oninput="syncTUnitComp(${idx},'unit_no',this.value)" placeholder="Unit #"/></td>
      <td class="comp-btn-cell">${addBtn}${remBtn}</td>
    </tr>`;
  }).join('');
}

// Every filled-in Unit # entry across all components — sent as
// blood_unit_entries_json. The Other row's name (if any) rides along with
// each of its entries so it survives a reload.
function collectTUnitCompEntries() {
  const otherName = ((tUnitComponents.find(c => c.key === 'other') || {}).name || '').trim();
  return tUnitComponents
    .filter(c => c.unit_no && String(c.unit_no).trim())
    .map(c => c.key === 'other'
      ? { key:'other', name: otherName, unit_no: String(c.unit_no).trim() }
      : { key: c.key, unit_no: String(c.unit_no).trim() });
}

function rebuildTUnitCompFromEntries(entries) {
  const list = (Array.isArray(entries) ? entries : []).filter(e => e && (T_COMP_FIXED[e.key] || e.key === 'other'));
  const base = [];
  Object.keys(T_COMP_FIXED).forEach(key => {
    const rows = list.filter(e => e.key === key);
    if (rows.length) rows.forEach(e => base.push({ key, unit_no: e.unit_no || '' }));
    else base.push({ key, unit_no: '' });
  });
  const otherRows = list.filter(e => e.key === 'other');
  if (otherRows.length) {
    otherRows.forEach((e, i) => base.push({ key:'other', unit_no: e.unit_no || '', name: i === 0 ? (e.name || '') : '' }));
  } else {
    base.push({ key:'other', unit_no:'', name:'' });
  }
  return base;
}

// Restores from a saved blood_unit_entries_json string alone (drafts).
function applyTUnitComponentsFromJson(jsonStr) {
  let entries = [];
  try { entries = jsonStr ? JSON.parse(jsonStr) : []; } catch { entries = []; }
  tUnitComponents = entries.length ? rebuildTUnitCompFromEntries(entries) : defaultTUnitComponents();
  renderTUnitCompTable();
}

// Restores from a full saved record. Records saved before this per-
// component listing existed only have the old flat blood_unit_1..8 values
// with no component association — show them ungrouped under Filtered
// Packed Cells so the data isn't lost, ready to be re-filed by hand.
function applyTUnitComponentsFromRecord(r) {
  let entries = [];
  try { entries = r && r.blood_unit_entries_json ? JSON.parse(r.blood_unit_entries_json) : []; } catch { entries = []; }
  entries = (Array.isArray(entries) ? entries : []).filter(e => e && (T_COMP_FIXED[e.key] || e.key === 'other'));
  if (!entries.length && r) {
    const legacy = [1,2,3,4,5,6,7,8].map(n => r[`blood_unit_${n}`]).filter(v => v && String(v).trim());
    entries = legacy.map(v => ({ key: 'fpc', unit_no: v }));
  }
  tUnitComponents = entries.length ? rebuildTUnitCompFromEntries(entries) : defaultTUnitComponents();
  renderTUnitCompTable();
}

document.addEventListener('DOMContentLoaded', () => renderTUnitCompTable());

// ═══════════════════════════════════════════════════════
// COMPONENTS ISSUED (delivery) — same "+ add another row" concept as the
// transfusion table above, but simpler: just a component name and Nº
// Units, no urgency/checkbox (this section just records what was actually
// issued). Each type's first row keeps a fixed id (d_fpc_units, ...) so it
// flows through FIELD_MAP/collectFormData like any other delivery field;
// rows added via "+" have no id and travel as d_components_json instead.
// ═══════════════════════════════════════════════════════
const D_COMP_FIXED = { fpc:'Filtered RBC', ffp:'FFP', plt:'Platelets', irr:'Irradiated RBC' };

// Short "2 Filtered RBC, 1 FFP" summary of a saved delivery record's
// Components Issued, replacing the old free-text "Type of Blood" display
// (that field was removed — components are now structured units).
function deliveryComponentSummary(r) {
  if (!r) return '';
  const parts = [];
  ['fpc', 'ffp', 'plt', 'irr'].forEach(key => {
    const n = parseInt(r[`${key}_units`]) || 0;
    if (n > 0) parts.push(`${n} ${D_COMP_FIXED[key]}`);
  });
  if (r.components_json) {
    try {
      JSON.parse(r.components_json).forEach(c => {
        const n = parseInt(c.units) || 0;
        if (n > 0) parts.push(`${n} ${D_COMP_FIXED[c.key] || c.key}`);
      });
    } catch { /* ignore bad JSON */ }
  }
  return parts.join(', ');
}

function defaultDComponents() {
  return Object.keys(D_COMP_FIXED).map(key => ({ key, units:'' }));
}
let dComponents = defaultDComponents();

function syncDComp(idx, field, value) {
  if (dComponents[idx]) dComponents[idx][field] = value;
}

function addDCompRow(key) {
  let lastIdx = -1;
  dComponents.forEach((c, i) => { if (c.key === key) lastIdx = i; });
  if (lastIdx === -1) return;
  dComponents.splice(lastIdx + 1, 0, { key, units:'' });
  renderDCompTable();
}

function removeDCompRow(idx) {
  dComponents.splice(idx, 1);
  renderDCompTable();
}

function renderDCompTable() {
  const tbody = document.getElementById('dCompBody');
  if (!tbody) return;
  const lastOfKey = {};
  dComponents.forEach((c, i) => { lastOfKey[c.key] = i; });
  const seenKeys = {};
  tbody.innerHTML = dComponents.map((c, idx) => {
    const isFirst = !seenKeys[c.key]; seenKeys[c.key] = true;
    const isLast  = lastOfKey[c.key] === idx;
    const label   = D_COMP_FIXED[c.key] || '';
    const unitsAttr = isFirst ? ` id="d_${c.key}_units"` : '';
    const nameCell  = `<td class="comp-name"${isFirst ? '' : ' style="color:var(--text-soft);font-style:italic;font-size:11px"'}>${label}</td>`;
    const addBtn    = isLast   ? `<button type="button" class="comp-add-btn" onclick="addDCompRow('${c.key}')" title="Add another ${escHtml(label)} row">+</button>` : '';
    const remBtn    = !isFirst ? `<button type="button" class="comp-rem-btn" onclick="removeDCompRow(${idx})" title="Remove row">−</button>` : '';
    return `<tr>
      ${nameCell}
      <td><input type="number" min="0"${unitsAttr} value="${escHtml(c.units)}" oninput="syncDComp(${idx},'units',this.value)" placeholder="0"/></td>
      <td class="comp-btn-cell">${addBtn}${remBtn}</td>
    </tr>`;
  }).join('');
}

// Extra (beyond each type's first) rows — the first row of each key is
// already captured by its own d_fpc_units-style FIELD_MAP field.
function collectExtraDComponents() {
  const seen  = new Set();
  const extra = [];
  dComponents.forEach(c => {
    if (!seen.has(c.key)) { seen.add(c.key); return; }
    extra.push({ key: c.key, units: c.units || '' });
  });
  return extra;
}

function rebuildDComponentsWithExtras(extras) {
  const base = defaultDComponents();
  (Array.isArray(extras) ? extras : []).forEach(extra => {
    if (!extra || !D_COMP_FIXED[extra.key]) return;
    let lastIdx = -1;
    base.forEach((c, i) => { if (c.key === extra.key) lastIdx = i; });
    if (lastIdx === -1) return;
    base.splice(lastIdx + 1, 0, { key: extra.key, units: extra.units || '' });
  });
  return base;
}

function applyDComponentsFromJson(jsonStr) {
  let extras = [];
  try { extras = jsonStr ? JSON.parse(jsonStr) : []; } catch { extras = []; }
  dComponents = rebuildDComponentsWithExtras(extras);
  renderDCompTable();
}

document.addEventListener('DOMContentLoaded', () => renderDCompTable());

// ═══════════════════════════════════════════════════════
// SIGNATURE PADS — draw-to-sign canvases next to each physician field.
// The canvas is purely visual; the drawing is captured as a PNG data URL
// into a same-id hidden <input>, so it flows through collectFormData/
// saveForm/FIELD_MAP exactly like any other text field.
// ═══════════════════════════════════════════════════════
const SIGNATURE_FIELD_IDS = ['t_physician_signature', 't_ls_signature', 'd_ls_signature',
  'dc_technician_signature', 'dc_donor_signature', 'dc_staff_signature', 'dc_lab_reviewer_signature'];

function setupSignaturePad(id) {
  const canvas = document.getElementById(id + '_pad');
  const input  = document.getElementById(id);
  if (!canvas || !input) return;

  const ctx = canvas.getContext('2d');
  ctx.lineWidth   = 1.8;
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';
  ctx.strokeStyle = '#1a1a1a';

  const wrap = canvas.closest('.sig-pad-wrap');
  let drawing = false;
  let last = null;

  function pos(e) {
    const rect = canvas.getBoundingClientRect();
    const p = e.touches ? e.touches[0] : e;
    // Canvas's internal pixel size (attrs) can differ from its CSS-rendered
    // size, so map client coords into canvas-pixel space.
    return {
      x: (p.clientX - rect.left) * (canvas.width  / rect.width),
      y: (p.clientY - rect.top)  * (canvas.height / rect.height),
    };
  }
  function start(e) { e.preventDefault(); drawing = true; last = pos(e); }
  function move(e) {
    if (!drawing) return;
    e.preventDefault();
    const p = pos(e);
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last = p;
    if (wrap) wrap.classList.add('has-content');
  }
  function end() {
    if (!drawing) return;
    drawing = false;
    input.value = canvas.toDataURL('image/png');
  }

  canvas.addEventListener('mousedown', start);
  canvas.addEventListener('mousemove', move);
  window.addEventListener('mouseup', end);
  canvas.addEventListener('touchstart', start, { passive: false });
  canvas.addEventListener('touchmove',  move,  { passive: false });
  canvas.addEventListener('touchend', end);

  refreshSignaturePad(id);
}

function initSignaturePads() { SIGNATURE_FIELD_IDS.forEach(setupSignaturePad); }

function clearSignaturePad(id) {
  const canvas = document.getElementById(id + '_pad');
  const input  = document.getElementById(id);
  if (!canvas || !input) return;
  canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  input.value = '';
  const wrap = canvas.closest('.sig-pad-wrap');
  if (wrap) wrap.classList.remove('has-content');
}

// Redraws a pad's canvas from whatever PNG data URL its hidden input
// currently holds — used after the input is set programmatically (loading
// a saved record, restoring a draft) since setting .value doesn't paint it.
function refreshSignaturePad(id) {
  const canvas = document.getElementById(id + '_pad');
  const input  = document.getElementById(id);
  if (!canvas || !input) return;
  const ctx  = canvas.getContext('2d');
  const wrap = canvas.closest('.sig-pad-wrap');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (input.value) {
    const img = new Image();
    img.onload = () => ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    img.src = input.value;
    if (wrap) wrap.classList.add('has-content');
  } else if (wrap) {
    wrap.classList.remove('has-content');
  }
}

function refreshAllSignaturePads() { SIGNATURE_FIELD_IDS.forEach(refreshSignaturePad); }

document.addEventListener('DOMContentLoaded', initSignaturePads);
