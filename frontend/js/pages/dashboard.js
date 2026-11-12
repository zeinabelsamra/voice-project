// Dashboard — summary, response-time compliance, wastage
// 
// Loaded as a classic script (shared global scope) — see index.html for load order.

async function loadDashboard() {
  try {
    const r2   = await apiFetch(`${API}/dashboard/stats`);
    if (!r2) return;
    const data = await r2.json();
    if (data.error) { return; }

    // Summary cards
    document.getElementById('dToday_t').textContent  = data.today.transfusions  ?? 0;
    document.getElementById('dToday_d').textContent  = data.today.deliveries    ?? 0;
    document.getElementById('dWeek_t').textContent   = data.week.transfusions   ?? 0;
    document.getElementById('dWeek_d').textContent   = data.week.deliveries     ?? 0;
    document.getElementById('dMonth_t').textContent  = data.month.transfusions  ?? 0;
    document.getElementById('dMonth_d').textContent  = data.month.deliveries    ?? 0;
    document.getElementById('dLifeSaving').textContent = data.lifeSavingMonth   ?? 0;
    document.getElementById('dTopGroup').textContent = data.bloodGroups[0]?.blood_group ?? '—';

    // Daily activity chart
    renderDailyChart(data.dailyActivity);

    // Blood group chart
    renderBgChart(data.bloodGroups);

    // Recent table
    renderRecentTable(data.recent);

  } catch {
    document.getElementById('dashSection').innerHTML += '<div class="dash-empty">Could not load dashboard — is the server running?</div>';
  }

  // Response times and wastage (separate calls — don't block main dashboard)
  loadResponseTimes();
  loadWastageDashboard();
}

function renderDailyChart(days) {
  const el = document.getElementById('dailyChart');
  if (!days.length) { el.innerHTML = '<div class="dash-empty">No data yet</div>'; return; }
  const maxVal = Math.max(...days.map(d => (d.transfusions || 0) + (d.deliveries || 0)), 1);
  // Fill missing days (last 7)
  const allDays = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const key = d.toISOString().split('T')[0];
    const found = days.find(r => r.date === key);
    allDays.push({ date: key, transfusions: found?.transfusions || 0, deliveries: found?.deliveries || 0 });
  }
  el.innerHTML = allDays.map(d => {
    const tH = Math.round(((d.transfusions || 0) / maxVal) * 95);
    const dH = Math.round(((d.deliveries   || 0) / maxVal) * 95);
    const label = new Date(d.date + 'T00:00:00').toLocaleDateString('en-GB', { day:'numeric', month:'short' });
    return `<div class="daily-col">
      <div class="daily-bars">
        <div class="daily-bar t-bar" style="height:${tH}%" title="${d.transfusions} transfusions"></div>
        <div class="daily-bar d-bar" style="height:${dH}%" title="${d.deliveries} deliveries"></div>
      </div>
      <div class="daily-label">${label}</div>
    </div>`;
  }).join('');
}

function renderBgChart(groups) {
  const el = document.getElementById('bgChart');
  if (!groups.length) { el.innerHTML = '<div class="dash-empty">No data yet</div>'; return; }
  const max = Math.max(...groups.map(g => g.cnt), 1);
  el.innerHTML = groups.slice(0, 8).map(g => {
    const pct = Math.round((g.cnt / max) * 100);
    return `<div class="bg-bar-row">
      <div class="bg-bar-label">${g.blood_group}</div>
      <div class="bg-bar-track"><div class="bg-bar-fill" style="width:${pct}%"></div></div>
      <div class="bg-bar-count">${g.cnt}</div>
    </div>`;
  }).join('');
}

function renderRecentTable(rows) {
  const tbody = document.getElementById('dashRecentBody');
  if (!rows.length) { tbody.innerHTML = '<tr><td colspan="6" class="dash-empty">No records yet</td></tr>'; return; }
  tbody.innerHTML = rows.map(r => `
    <tr>
      <td><span class="dash-badge ${r.form_type === 'transfusion' ? 't' : 'd'}">${r.form_type === 'transfusion' ? '🩸 Transfusion' : '🚚 Delivery'}</span></td>
      <td>${r.patient_name || '—'}</td>
      <td>${r.blood_group || '—'}${r.rh_factor ? ' ' + r.rh_factor : ''}</td>
      <td>${r.room || '—'}</td>
      <td>${r.staff || '—'}</td>
      <td>${r.created_at ? new Date(r.created_at.replace(' ','T')).toLocaleString('en-GB') : '—'}</td>
    </tr>`).join('');
}

// ═══════════════════════════════════════════════════════
// RESPONSE TIME COMPLIANCE
// ═══════════════════════════════════════════════════════
function fmtMins(m) {
  if (m === null || m === undefined) return '—';
  return m < 60 ? m + ' min' : Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}

function statusBadge(within, caseType) {
  if (within === true)              return '<span class="rt-status pass">✓ Met</span>';
  if (within === false)             return '<span class="rt-status fail">✗ Exceeded</span>';
  if (caseType === 'routine')       return '<span class="rt-status pending">—</span>';
  return '<span class="rt-status pending">Awaiting</span>';
}

let _rtAllRows = [];

async function loadResponseTimes() {
  const wrapEl = document.getElementById('rtTableWrap');
  try {
    const res = await apiFetch(`${API}/response-times`);
    if (!res) return;
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.error) {
      wrapEl.innerHTML = '<div class="rt-empty">Response time data unavailable.</div>';
      return;
    }
    _rtAllRows = rows;
    renderResponseTimes(rows);
  } catch (err) {
    wrapEl.innerHTML = '<div class="rt-empty">Could not load response times.</div>';
  }
}

function applyRtFilter() {
  const from = document.getElementById('rtFrom').value;
  const to   = document.getElementById('rtTo').value;
  const filtered = _rtAllRows.filter(r => {
    const d = r.request_date || '';
    if (from && d < from) return false;
    if (to   && d > to)   return false;
    return true;
  });
  renderResponseTimes(filtered);
}

function clearRtFilter() {
  document.getElementById('rtFrom').value = '';
  document.getElementById('rtTo').value   = '';
  renderResponseTimes(_rtAllRows);
}

function renderResponseTimes(rows) {
  const summaryEl = document.getElementById('rtSummary');
  const wrapEl    = document.getElementById('rtTableWrap');

  const lsCases   = rows.filter(r => r.caseType === 'life_saving');
  const statCases = rows.filter(r => r.caseType === 'urgent');

  function caseMet(r) {
    const hasBB    = r.bb_diff_minutes    !== null;
    const hasNurse = r.nurse_diff_minutes !== null;
    if (!hasBB && !hasNurse) return false;
    if (hasBB    && r.bbWithin    === false) return false;
    if (hasNurse && r.nurseWithin === false) return false;
    return true;
  }

  const lsMet   = lsCases.filter(caseMet).length;
  const statMet = statCases.filter(caseMet).length;
  const lsPct   = lsCases.length  ? Math.round(lsMet  / lsCases.length  * 100) : null;
  const statPct = statCases.length ? Math.round(statMet / statCases.length * 100) : null;
  const pending = rows.filter(r => r.bb_diff_minutes === null && r.caseType !== 'routine').length;

  summaryEl.innerHTML = `
    <div class="rt-stat-box ${lsPct === null ? '' : lsPct === 100 ? 'ok' : 'warn'}">
      <div class="rt-stat-label">Life-Saving (&lt;15 min)</div>
      <div class="rt-stat-num">${lsPct !== null ? lsPct + '%' : '—'}</div>
      <div class="rt-stat-sub">${lsMet} / ${lsCases.length} cases met target</div>
    </div>
    <div class="rt-stat-box ${statPct === null ? '' : statPct === 100 ? 'ok' : 'warn'}">
      <div class="rt-stat-label">Urgent / Stat (&lt;45 min)</div>
      <div class="rt-stat-num">${statPct !== null ? statPct + '%' : '—'}</div>
      <div class="rt-stat-sub">${statMet} / ${statCases.length} cases met target</div>
    </div>
    <div class="rt-stat-box">
      <div class="rt-stat-label">Pending Delivery</div>
      <div class="rt-stat-num">${pending}</div>
      <div class="rt-stat-sub">urgent/life-saving without BB delivery yet</div>
    </div>`;

  if (!rows.length) {
    wrapEl.innerHTML = '<div class="rt-empty">No records match the selected date range.</div>';
    return;
  }

  const display   = rows.filter(r => r.caseType !== 'routine');
  const tableRows = (display.length ? display : rows).map(r => {
    const reqDT   = r.request_date && r.request_time ? `${r.request_date} ${r.request_time}` : '—';
    const bbDT    = r.delivery_date && r.delivery_time ? `${r.delivery_date} ${r.delivery_time}` : '—';
    const nurseDT = r.nurse_unit_date && r.nurse_unit_time ? `${r.nurse_unit_date} ${r.nurse_unit_time}` : '—';
    const target  = r.targetMinutes ? r.targetMinutes + ' min' : '—';
    const badgeCls = r.caseType === 'life_saving' ? 'life-saving' : r.caseType === 'urgent' ? 'urgent' : 'routine';
    const badgeTxt = r.caseType === 'life_saving' ? '🔴 Life-Saving' : r.caseType === 'urgent' ? '⚠️ Urgent' : 'Routine';
    return `<tr>
      <td><strong>${r.patient_name || '—'}</strong><br><span style="font-size:11px;color:var(--text-soft)">${r.file_number || ''}</span></td>
      <td><span class="rt-badge ${badgeCls}">${badgeTxt}</span></td>
      <td>${reqDT}</td>
      <td>
        <div style="font-size:11px;color:var(--text-soft);margin-bottom:1px">BB:</div>${bbDT}
        <div style="font-size:11px;color:var(--text-soft);margin-top:4px;margin-bottom:1px">Nurse:</div>${nurseDT}
      </td>
      <td style="font-weight:700">
        <div style="font-size:11px;color:var(--text-soft);margin-bottom:1px">BB:</div>${fmtMins(r.bb_diff_minutes)}
        <div style="font-size:11px;color:var(--text-soft);margin-top:4px;margin-bottom:1px">Nurse:</div>${fmtMins(r.nurse_diff_minutes)}
      </td>
      <td>${target}</td>
      <td>
        <div>${statusBadge(r.bbWithin, r.caseType)}</div>
        <div style="margin-top:4px">${statusBadge(r.nurseWithin, r.caseType)}</div>
      </td>
    </tr>`;
  }).join('');

  wrapEl.innerHTML = `
    <table class="rt-table">
      <thead><tr>
        <th>Patient</th><th>Case Type</th><th>Request Time</th>
        <th>Delivery / Nurse Receipt</th><th>Elapsed</th><th>Target</th><th>Status</th>
      </tr></thead>
      <tbody>${tableRows}</tbody>
    </table>`;
}

// ═══════════════════════════════════════════════════════
// BLOOD WASTAGE DASHBOARD
// ═══════════════════════════════════════════════════════
let _wastageAllCases = [];

async function loadWastageDashboard() {
  const tableEl = document.getElementById('wastageTableWrap');
  try {
    const res = await apiFetch(`${API}/dashboard/wastage`);
    if (!res) return;
    const data = await res.json();
    if (data.error) { tableEl.innerHTML = '<div class="rt-empty">Wastage data unavailable.</div>'; return; }
    _wastageAllCases = data.cases;
    renderWastageDashboard(data.cases);
  } catch {
    tableEl.innerHTML = '<div class="rt-empty">Could not load wastage data.</div>';
  }
}

function applyWastageFilter() {
  const from = document.getElementById('wastageFrom').value;
  const to   = document.getElementById('wastageTo').value;
  const filtered = _wastageAllCases.filter(c => {
    const d = c.date || '';
    if (from && d < from) return false;
    if (to   && d > to)   return false;
    return true;
  });
  renderWastageDashboard(filtered);
}

function clearWastageFilter() {
  document.getElementById('wastageFrom').value = '';
  document.getElementById('wastageTo').value   = '';
  renderWastageDashboard(_wastageAllCases);
}

function renderWastageDashboard(cases) {
  const summaryEl = document.getElementById('wastageSummary');
  const tableEl   = document.getElementById('wastageTableWrap');

  // Recalculate summary from filtered cases
  let totalOrdered = 0, totalUsed = 0, prcWasted = 0, ffpWasted = 0, pltWasted = 0, irrWasted = 0;
  cases.forEach(c => {
    totalOrdered += c.ordered;
    totalUsed    += c.used;
    if (c.component === 'Packed Cells') prcWasted += c.wasted;
    else if (c.component === 'FFP')     ffpWasted += c.wasted;
    else if (c.component === 'Platelets') pltWasted += c.wasted;
    else if (c.component === 'Irradiated RBC') irrWasted += c.wasted;
  });
  const totalWasted  = prcWasted + ffpWasted + pltWasted + irrWasted;
  const wastageRate  = totalOrdered > 0 ? Math.round((totalWasted / totalOrdered) * 100) : 0;

  summaryEl.innerHTML = `
    <div class="wastage-chips">
      <div class="wastage-chip total">
        <div class="wc-num">${totalWasted}</div>
        <div class="wc-label">Total Units Wasted</div>
      </div>
      <div class="wastage-chip rate">
        <div class="wc-num">${wastageRate}%</div>
        <div class="wc-label">Wastage Rate</div>
      </div>
      <div class="wastage-chip prc">
        <div class="wc-num">${prcWasted}</div>
        <div class="wc-label">Packed Cells Wasted</div>
      </div>
      <div class="wastage-chip ffp">
        <div class="wc-num">${ffpWasted}</div>
        <div class="wc-label">FFP Wasted</div>
      </div>
      <div class="wastage-chip plt">
        <div class="wc-num">${pltWasted}</div>
        <div class="wc-label">Platelets Wasted</div>
      </div>
      <div class="wastage-chip irr">
        <div class="wc-num">${irrWasted}</div>
        <div class="wc-label">Irradiated RBC Wasted</div>
      </div>
    </div>`;

  if (!cases.length) {
    tableEl.innerHTML = '<div class="rt-empty">No wastage records match the selected date range.</div>';
    return;
  }

  tableEl.innerHTML = `
    <table class="rt-table">
      <thead><tr>
        <th>Patient</th><th>File #</th><th>Date</th><th>Component</th>
        <th style="text-align:center">Ordered</th>
        <th style="text-align:center">Used</th>
        <th style="text-align:center">Wasted</th>
      </tr></thead>
      <tbody>
        ${cases.map(c => `<tr>
          <td><strong>${c.patient_name || '—'}</strong></td>
          <td style="color:var(--text-soft);font-size:12px">${c.file_number || '—'}</td>
          <td style="font-size:12px">${c.date || '—'}</td>
          <td>${c.component}</td>
          <td style="text-align:center;font-weight:700">${c.ordered}</td>
          <td style="text-align:center">${c.used}</td>
          <td style="text-align:center">
            <span class="wastage-badge ${c.wasted > 0 ? 'warn' : 'ok'}">
              ${c.wasted > 0 ? '⚠ ' + c.wasted + ' wasted' : '✓ None'}
            </span>
          </td>
        </tr>`).join('')}
      </tbody>
    </table>`;
}
