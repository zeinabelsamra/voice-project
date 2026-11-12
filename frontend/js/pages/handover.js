// Shift handover report
// 
// Loaded as a classic script (shared global scope) — see index.html for load order.

// ════════════════════════════════════════════════════════════════
// SHIFT HANDOVER REPORT
// ════════════════════════════════════════════════════════════════
let _hoData = null;
let _hoShift = 'morning';

function initHandover() {
  const el = document.getElementById('hoDate');
  if (!el.value) {
    // Use local date, not UTC, to avoid midnight timezone shifting
    const now = new Date();
    const y   = now.getFullYear();
    const m   = String(now.getMonth() + 1).padStart(2, '0');
    const d   = String(now.getDate()).padStart(2, '0');
    el.value  = `${y}-${m}-${d}`;
  }
}

function setShift(shift) {
  _hoShift = shift;
  ['morning','afternoon','night'].forEach(s => {
    const el = document.getElementById('shift' + s.charAt(0).toUpperCase() + s.slice(1));
    if (el) el.classList.toggle('active', s === shift);
  });
}

async function loadHandover() {
  const date = document.getElementById('hoDate').value;
  if (!date) { alert('Please select a date.'); return; }

  const r = await apiFetch(`${API}/handover?date=${date}&shift=${_hoShift}`);
  if (!r) return;
  const data = await r.json();
  if (data.error) { alert('Error: ' + data.error); return; }

  _hoData = data;
  const s  = data.summary;
  const hasData = (s.transfusions + s.deliveries) > 0;

  document.getElementById('hoPreview').style.display = hasData  ? '' : 'none';
  document.getElementById('hoEmpty').style.display   = !hasData ? '' : 'none';
  document.getElementById('hoPdfBtn').style.display  = hasData  ? '' : 'none';

  if (!hasData) return;

  document.getElementById('hoTrans').textContent = s.transfusions;
  document.getElementById('hoDel').textContent   = s.deliveries;
  document.getElementById('hoLS').textContent    = s.life_saving;
  document.getElementById('hoUnits').textContent = s.total_units;
  document.getElementById('hoPrc').textContent   = s.total_prc;
  document.getElementById('hoFfp').textContent   = s.total_ffp;
  document.getElementById('hoPlt').textContent   = s.total_plt;

  const SHIFT_TIMES = { morning: '07:00–15:00', afternoon: '15:00–23:00', night: '23:00–07:00' };
  document.getElementById('hoTransHead').textContent =
    `🩸 Transfusion Requests (${s.transfusions})  ·  ${SHIFT_TIMES[_hoShift] || ''}`;
  document.getElementById('hoDelHead').textContent =
    `🚚 Blood Deliveries (${s.deliveries})  ·  ${SHIFT_TIMES[_hoShift] || ''}`;

  // Transfusion table
  document.getElementById('hoTransTable').innerHTML = data.transfusions.length ? `
    <table class="ho-table">
      <thead><tr><th>#</th><th>Patient</th><th>File No.</th><th>Blood Group</th><th>Room</th><th>Components</th><th>Physician</th><th>Time</th></tr></thead>
      <tbody>${data.transfusions.map((r, i) => {
        const comps = [
          r.fpc_units ? `<span class="ho-comp-pill">${r.fpc_units} PRC</span>` : '',
          r.ffp_units ? `<span class="ho-comp-pill">${r.ffp_units} FFP</span>` : '',
          r.plt_units ? `<span class="ho-comp-pill">${r.plt_units} PLT</span>` : '',
        ].filter(Boolean).join(' ');
        const ls = r.life_saving ? '<span class="ho-ls-badge">⚠ LIFE-SAVING</span>' : '';
        const rh = r.rh_factor ? (r.rh_factor.startsWith('Pos') ? '+' : '-') : '';
        return `<tr style="${r.life_saving ? 'background:#fff5f5' : ''}">
          <td>${i+1}</td>
          <td><strong>${e(r.patient_name) || '—'}</strong>${ls}</td>
          <td>${e(r.file_number) || '—'}</td>
          <td>${e((r.blood_group||'') + rh) || '—'}</td>
          <td>${e(r.room) || '—'}</td>
          <td>${comps || '—'}</td>
          <td>${e(r.physician) || '—'}</td>
          <td>${e(r.time_saved) || '—'}</td>
        </tr>`;
      }).join('')}</tbody>
    </table>` : '<div class="ho-empty">No transfusion requests this shift.</div>';

  // Delivery table
  document.getElementById('hoDelTable').innerHTML = data.deliveries.length ? `
    <table class="ho-table">
      <thead><tr><th>#</th><th>Patient</th><th>File No.</th><th>Blood Group</th><th>Room</th><th>Type Delivered</th><th>Technician</th><th>Time</th></tr></thead>
      <tbody>${data.deliveries.map((r, i) => {
        const ls = r.life_saving ? '<span class="ho-ls-badge">⚠ LIFE-SAVING</span>' : '';
        const rh = r.patient_rh ? (r.patient_rh.startsWith('Pos') ? '+' : '-') : '';
        return `<tr style="${r.life_saving ? 'background:#fff5f5' : ''}">
          <td>${i+1}</td>
          <td><strong>${e(r.patient_name) || '—'}</strong>${ls}</td>
          <td>${e(r.file_number) || '—'}</td>
          <td>${e((r.patient_blood_group||'') + rh) || '—'}</td>
          <td>${e(r.room) || '—'}</td>
          <td>${e(deliveryComponentSummary(r)) || '—'}</td>
          <td>${e(r.technician_name) || '—'}</td>
          <td>${e(r.time_saved) || '—'}</td>
        </tr>`;
      }).join('')}</tbody>
    </table>` : '<div class="ho-empty">No blood deliveries this shift.</div>';
}

async function downloadHandoverPdf() {
  if (!_hoData) return;
  const btn = document.getElementById('hoPdfBtn');
  btn.textContent = '⏳ Generating…'; btn.disabled = true;
  try {
    const r = await apiFetch(`${API}/handover/pdf`, { method: 'POST', body: _hoData });
    if (!r) return;
    const blob = await r.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `handover-${_hoData.date}-${_hoData.shift}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  } finally {
    btn.textContent = '📄 Download PDF'; btn.disabled = false;
  }
}
