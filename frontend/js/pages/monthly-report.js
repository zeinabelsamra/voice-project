// Monthly management report
// 
// Loaded as a classic script (shared global scope) — see index.html for load order.

// ═══════════════════════════════════════════════════════
// MONTHLY MANAGEMENT REPORT
// ═══════════════════════════════════════════════════════
let _monthlyData = null;

function initMonthlyReport() {
  const input = document.getElementById('monthlyMonthInput');
  if (!input.value) {
    const now = new Date();
    input.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }
}

async function loadMonthlyReport() {
  const month = document.getElementById('monthlyMonthInput').value;
  if (!month) return;
  const preview = document.getElementById('monthlyPreview');
  const pdfBtn  = document.getElementById('monthlyPdfBtn');
  preview.innerHTML = '<div class="monthly-empty">Loading…</div>';
  pdfBtn.style.display = 'none';
  _monthlyData = null;

  try {
    const res  = await apiFetch(`${API}/report/monthly?month=${encodeURIComponent(month)}`);
    if (!res) return;
    const data = await res.json();
    if (data.error) { preview.innerHTML = `<div class="monthly-empty">Error: ${data.error}</div>`; return; }

    _monthlyData = data;
    pdfBtn.style.display = '';
    renderMonthlyPreview(data);
  } catch (err) {
    preview.innerHTML = `<div class="monthly-empty">Could not load: ${err.message}</div>`;
  }
}

function renderMonthlyPreview(data) {
  const ov = data.overview || {};
  const units = data.units || {};
  const rt = data.response_times || {};
  const lsPct  = rt.ls_count    > 0 ? Math.round((rt.ls_within    / rt.ls_count)    * 100) : null;
  const urgPct = rt.urgent_count > 0 ? Math.round((rt.urgent_within / rt.urgent_count) * 100) : null;

  const bgTotal = (data.blood_groups || []).reduce((s, r) => s + r.total, 0) || 1;
  const bgRows = (data.blood_groups || []).map(r => {
    const pct = Math.round((r.total / bgTotal) * 100);
    return `<tr><td><strong>${r.group}</strong></td><td>${r.prc}</td><td>${r.ffp}</td><td>${r.plt}</td><td><strong>${r.total}</strong></td><td>${pct}%</td></tr>`;
  }).join('');

  const roomRows = (data.top_rooms || []).map((r, i) => {
    const max = (data.top_rooms[0]?.cnt) || 1;
    const pct = Math.round((r.cnt / max) * 100);
    return `<tr>
      <td>${r.room}</td>
      <td><strong>${r.cnt}</strong></td>
      <td><div class="monthly-bar-wrap"><div class="monthly-bar-bg"><div class="monthly-bar-fill" style="width:${pct}%"></div></div></div></td>
    </tr>`;
  }).join('');

  const physRows = (data.top_physicians  || []).map(r => `<tr><td>${e(r.physician)}</td><td><strong>${r.cnt}</strong></td></tr>`).join('');
  const techRows = (data.top_technicians || []).map(r => `<tr><td>${e(r.technician_name)}</td><td><strong>${r.cnt}</strong></td></tr>`).join('');

  document.getElementById('monthlyPreview').innerHTML = `
    <div class="monthly-preview">
      <div class="monthly-kpi-row">
        <div class="monthly-kpi red"><div class="monthly-kpi-val">${ov.transfusions ?? 0}</div><div class="monthly-kpi-lbl">Transfusion Requests</div></div>
        <div class="monthly-kpi blue"><div class="monthly-kpi-val">${ov.deliveries ?? 0}</div><div class="monthly-kpi-lbl">Blood Deliveries</div></div>
        <div class="monthly-kpi orange"><div class="monthly-kpi-val">${ov.life_saving ?? 0}</div><div class="monthly-kpi-lbl">Life-Saving Cases</div></div>
        <div class="monthly-kpi green"><div class="monthly-kpi-val">${(ov.transfusions||0)+(ov.deliveries||0)}</div><div class="monthly-kpi-lbl">Total Records</div></div>
      </div>

      <div class="monthly-units-bar">
        <div class="monthly-unit-cell prc"><div class="monthly-unit-val">${units.prc ?? 0}</div><div class="monthly-unit-lbl">Packed Red Cells (PRC)</div></div>
        <div class="monthly-unit-cell ffp"><div class="monthly-unit-val">${units.ffp ?? 0}</div><div class="monthly-unit-lbl">Fresh Frozen Plasma (FFP)</div></div>
        <div class="monthly-unit-cell plt"><div class="monthly-unit-val">${units.plt ?? 0}</div><div class="monthly-unit-lbl">Platelets (PLT)</div></div>
        <div class="monthly-unit-cell total"><div class="monthly-unit-val">${units.total ?? 0}</div><div class="monthly-unit-lbl">Total Units Issued</div></div>
      </div>

      <div class="monthly-panel">
        <div class="monthly-panel-head">Response Times</div>
        <div class="monthly-rt-grid">
          <div class="monthly-rt-cell">
            <div class="monthly-rt-val">${rt.avg_bb_minutes != null ? rt.avg_bb_minutes + ' min' : 'N/A'}</div>
            <div class="monthly-rt-lbl">Avg Blood Bank Dispatch Time</div>
          </div>
          <div class="monthly-rt-cell">
            <div class="monthly-rt-val">${rt.avg_nurse_minutes != null ? rt.avg_nurse_minutes + ' min' : 'N/A'}</div>
            <div class="monthly-rt-lbl">Avg Nurse Receipt Time</div>
          </div>
          <div class="monthly-rt-cell">
            <div class="monthly-rt-val" style="color:${lsPct != null ? (lsPct >= 80 ? '#1A7F4B' : '#C0392B') : '#888'}">${lsPct != null ? lsPct + '%' : 'N/A'}</div>
            <div class="monthly-rt-lbl">Life-Saving ≤15 min (${rt.ls_within}/${rt.ls_count} cases)</div>
          </div>
          <div class="monthly-rt-cell">
            <div class="monthly-rt-val" style="color:${urgPct != null ? (urgPct >= 80 ? '#1A7F4B' : '#D35400') : '#888'}">${urgPct != null ? urgPct + '%' : 'N/A'}</div>
            <div class="monthly-rt-lbl">Urgent ≤45 min (${rt.urgent_within}/${rt.urgent_count} cases)</div>
          </div>
        </div>
      </div>

      <div class="monthly-two-col">
        <div class="monthly-panel">
          <div class="monthly-panel-head">Blood Group Distribution</div>
          <div class="monthly-panel-body">
            <table class="monthly-table">
              <thead><tr><th>Blood Group</th><th>PRC</th><th>FFP</th><th>PLT</th><th>Total</th><th>%</th></tr></thead>
              <tbody>${bgRows || '<tr><td colspan="2" style="text-align:center;color:#aaa;padding:16px">No data</td></tr>'}</tbody>
            </table>
          </div>
        </div>
        <div class="monthly-panel">
          <div class="monthly-panel-head">Top Wards / Rooms</div>
          <div class="monthly-panel-body">
            <table class="monthly-table">
              <thead><tr><th>Room</th><th>Count</th><th></th></tr></thead>
              <tbody>${roomRows || '<tr><td colspan="3" style="text-align:center;color:#aaa;padding:16px">No data</td></tr>'}</tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="monthly-two-col">
        <div class="monthly-panel">
          <div class="monthly-panel-head">Top Physicians</div>
          <div class="monthly-panel-body">
            <table class="monthly-table">
              <thead><tr><th>Name</th><th>Cases</th></tr></thead>
              <tbody>${physRows || '<tr><td colspan="2" style="text-align:center;color:#aaa;padding:16px">No data</td></tr>'}</tbody>
            </table>
          </div>
        </div>
        <div class="monthly-panel">
          <div class="monthly-panel-head">Top Technicians</div>
          <div class="monthly-panel-body">
            <table class="monthly-table">
              <thead><tr><th>Name</th><th>Cases</th></tr></thead>
              <tbody>${techRows || '<tr><td colspan="2" style="text-align:center;color:#aaa;padding:16px">No data</td></tr>'}</tbody>
            </table>
          </div>
        </div>
      </div>
    </div>`;
}

async function downloadMonthlyPdf() {
  if (!_monthlyData) return;
  try {
    const res = await apiFetch(`${API}/report/monthly/pdf`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(_monthlyData),
    });
    if (!res) return;
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `monthly-report-${_monthlyData.period?.month || 'report'}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert('PDF generation failed: ' + err.message);
  }
}
