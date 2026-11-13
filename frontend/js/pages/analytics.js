// Advanced analytics and expiry calendar
// 
// Loaded as a classic script (shared global scope) — see index.html for load order.

// ═══════════════════════════════════════════════════════
// ADVANCED ANALYTICS (e-Delphyn) — KPIs, trends, donor
// behaviour, fulfilment/turnaround, expiry risk, demand
// heatmap, anomaly detection.
// ═══════════════════════════════════════════════════════
function clearAnalyticsFilter() {
  document.getElementById('anFrom').value = '';
  document.getElementById('anTo').value = '';
  loadAnalytics();
}

function noDataMsg(el, text) {
  if (!el) return;
  const ctx = el.getContext('2d');
  ctx.clearRect(0, 0, el.width, el.height);
  ctx.fillStyle = '#8896A7'; ctx.font = '13px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText(text || 'No data for this period', el.width / 2, 90);
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

async function loadAnalytics() {
  const from = document.getElementById('anFrom').value;
  const to   = document.getElementById('anTo').value;
  const rangeParams = new URLSearchParams();
  if (from) rangeParams.set('from', from);
  if (to)   rangeParams.set('to', to);
  // Shares the same "within N days" window as the Expiry Risk panel further
  // down, so the "Units Expiring Soon" KPI card and that panel always agree.
  const kpiParams = new URLSearchParams(rangeParams);
  kpiParams.set('expiryDays', document.getElementById('anExpiryDays')?.value || 14);

  const [kpiRes, trendRes, typesRes, retentionRes, fulfilmentRes, returnRes, turnaroundRes, heatmapRes, anomalyRes, deptYearRes] =
    await Promise.all([
      apiFetch(`${API}/api/analytics/kpi-summary?${kpiParams}`),
      apiFetch(`${API}/api/analytics/monthly-trend`),
      apiFetch(`${API}/api/analytics/donation-types?${rangeParams}`),
      apiFetch(`${API}/api/analytics/donor-retention`),
      apiFetch(`${API}/api/analytics/fulfilment?${rangeParams}`),
      apiFetch(`${API}/api/analytics/return-rate?${rangeParams}`),
      apiFetch(`${API}/api/analytics/turnaround?${rangeParams}`),
      apiFetch(`${API}/api/analytics/demand-heatmap`),
      apiFetch(`${API}/api/analytics/anomaly`),
      // Department × month table: aggregated on the server, and with no range
      // picked it covers the last 12 months (server default) instead of 30 days.
      apiFetch(`${API}/api/analytics/fulfilment-by-department?${rangeParams}`),
    ]);

  if (kpiRes)         renderAnKpiCards(await kpiRes.json());
  if (trendRes)        renderAnTrendChart(await trendRes.json());
  if (typesRes)         renderAnDonationTypeChart(await typesRes.json());
  if (retentionRes)     renderAnRetentionChart(await retentionRes.json());
  initFulfilmentThreshold();
  if (fulfilmentRes)    renderAnFulfilmentChart(await fulfilmentRes.json());
  setText('anFulfilmentHeatmapRange', (from || to) ? '(selected range)' : '(last 12 months)');
  if (deptYearRes) {
    const deptRows = await deptYearRes.json();
    renderAnFulfilmentHeatmap(Array.isArray(deptRows) ? deptRows : []);
  }
  if (returnRes)        renderAnReturnChart(await returnRes.json());
  if (turnaroundRes)    renderAnTurnaroundChart(await turnaroundRes.json());
  if (heatmapRes)       renderAnHeatmap(await heatmapRes.json());
  if (anomalyRes)       renderAnAnomalyChart(await anomalyRes.json());

  loadExpiryRisk();
  loadDonorRecall();
  initExpiryCalendarControls();
  loadAnExpiryCalendarMonth();
}

// Card order/config for the KPI row. `direction` says which way is "good"
// for that metric — it's what turns a raw +/- change into a green/red
// verdict (e.g. Return Rate going up is bad, Fulfilment Rate going up is
// good; Units Requested is just demand, not judged either way).
const KPI_CARDS = [
  { key: 'TotalDonations', label: 'Total Donations',     cls: '',      direction: 'good',    isRate: false, spark: d => d.Donations },
  { key: 'UniqueDonors',   label: 'Unique Donors',        cls: '',      direction: 'good',    isRate: false, spark: d => d.UniqueDonors },
  { key: 'UnitsRequested', label: 'Units Requested',      cls: '',      direction: 'neutral', isRate: false, spark: d => d.UnitsRequested },
  { key: 'UnitsIssued',    label: 'Units Issued',         cls: 'prc',   direction: 'good',    isRate: false, spark: d => d.UnitsIssued },
  { key: 'FulfilmentRate', label: 'Fulfilment Rate',      cls: 'total', direction: 'good',    isRate: true,  spark: d => d.UnitsRequested > 0 ? (d.UnitsIssued / d.UnitsRequested) * 100 : 0 },
  { key: 'ReturnRate',     label: 'Return Rate',          cls: 'ffp',   direction: 'bad',     isRate: true,  spark: d => d.UnitsIssued > 0 ? (d.UnitsReturned / d.UnitsIssued) * 100 : 0 },
  { key: 'WastageRate',    label: 'Wastage Rate',         cls: 'plt',   direction: 'bad',     isRate: true,  spark: d => (d.UnitsIssued + d.WastedUnits) > 0 ? (d.WastedUnits / (d.UnitsIssued + d.WastedUnits)) * 100 : 0 },
  { key: 'ExpiringSoon',   label: 'Units Expiring Soon',  cls: 'exp',   direction: 'bad',     isRate: false, spark: d => d.ExpiringSoon },
];

// Adds the three derived rate fields onto a raw totals object (current or
// previous), so KPI_CARDS can read FulfilmentRate/ReturnRate/WastageRate off
// either one the same way it reads the raw counts.
function withKpiRates(totals) {
  const t = totals || {};
  const fulfilment = t.UnitsRequested > 0 ? (t.UnitsIssued / t.UnitsRequested) * 100 : 0;
  const returnRate = t.UnitsIssued > 0 ? (t.UnitsReturned / t.UnitsIssued) * 100 : 0;
  const wastage     = (t.UnitsIssued + t.WastedUnits) > 0 ? (t.WastedUnits / (t.UnitsIssued + t.WastedUnits)) * 100 : 0;
  return { ...t, FulfilmentRate: fulfilment, ReturnRate: returnRate, WastageRate: wastage };
}

// Rate cards (already 0-100) compare in percentage points; count cards
// compare in relative percent change. previous===0 with current>0 has no
// defined percent change, so that's called out as "New" instead of +Infinity%.
function kpiDelta(current, previous, isRate) {
  if (isRate) {
    const diff = current - previous;
    const sign = diff > 0.5 ? 1 : diff < -0.5 ? -1 : 0;
    return { text: `${diff > 0 ? '+' : ''}${Math.round(diff)}pp`, sign };
  }
  if (previous === 0) {
    return current === 0 ? { text: '±0%', sign: 0 } : { text: 'New', sign: 1 };
  }
  const pct  = ((current - previous) / previous) * 100;
  const sign = pct > 0.5 ? 1 : pct < -0.5 ? -1 : 0;
  return { text: `${pct > 0 ? '+' : ''}${Math.round(pct)}%`, sign };
}

// Minimal dependency-free sparkline — an SVG polyline scaled to its own
// viewBox so it stretches to fill whatever box the CSS gives it.
function sparklineSvg(values, color) {
  if (!values.length) return '';
  const w = 100, h = 28, pad = 2;
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const range = (max - min) || 1;
  const stepX = values.length > 1 ? (w - pad * 2) / (values.length - 1) : 0;
  const points = values.map((v, i) => {
    const x = pad + i * stepX;
    const y = pad + (h - pad * 2) * (1 - (v - min) / range);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

function renderAnKpiCards(data) {
  const el = document.getElementById('anKpiCards');
  if (!el) return;
  if (!data || data.error || !data.current) { el.innerHTML = '<div class="rt-empty">Unable to load KPI summary.</div>'; return; }
  const current  = withKpiRates(data.current);
  const previous = withKpiRates(data.previous);
  const daily    = Array.isArray(data.daily) ? data.daily : [];

  el.innerHTML = KPI_CARDS.map(card => {
    const curVal  = current[card.key]  ?? 0;
    const prevVal = previous[card.key] ?? 0;
    const { text: deltaText, sign } = kpiDelta(curVal, prevVal, card.isRate);
    const semantics = card.direction === 'neutral' || sign === 0 ? 'flat'
      : ((card.direction === 'good') === (sign > 0)) ? 'good' : 'bad';
    const arrow      = sign > 0 ? '▲' : sign < 0 ? '▼' : '–';
    const sparkColor = semantics === 'good' ? '#1A7F4B' : semantics === 'bad' ? '#C0392B' : '#8896A7';
    const sparkValues = daily.map(d => card.spark(d) ?? 0);
    const fmt = v => card.isRate ? `${Math.round(v)}%` : Math.round(v).toLocaleString();
    return `
      <div class="consump-card ${card.cls}">
        <div class="consump-card-label">${card.label}</div>
        <div class="consump-card-num">${fmt(curVal)}</div>
        <div class="consump-card-meta">
          <span class="consump-card-prev">was ${fmt(prevVal)}</span>
          <span class="consump-card-delta ${semantics}">${arrow} ${deltaText}</span>
        </div>
        <div class="consump-card-spark">${sparklineSvg(sparkValues, sparkColor)}</div>
      </div>`;
  }).join('');
}

function renderAnTrendChart(rows) {
  if (_anTrendChart) { _anTrendChart.destroy(); _anTrendChart = null; }
  const el = document.getElementById('anTrendChart');
  if (!el) return;
  if (!Array.isArray(rows) || !rows.length) { noDataMsg(el); return; }
  const labels = rows.map(r => String(r.MonthStart).slice(0, 7));

  // Orders with an implausible quantity (typing mistakes) are left out of
  // "Units Requested" by the backend — say so, so totals aren't a mystery.
  const note = document.getElementById('anTrendNote');
  if (note) {
    const skipped = rows.reduce((n, r) => n + (Number(r.ExcludedOrders) || 0), 0);
    note.hidden = skipped === 0;
    note.textContent = skipped
      ? `· ${skipped} order${skipped === 1 ? '' : 's'} with an unrealistic quantity (likely a typing mistake) left out of Units Requested`
      : '';
  }

  _anTrendChart = new Chart(el, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Donations',       data: rows.map(r => r.Donations),      borderColor: 'rgba(26,82,118,0.9)',  backgroundColor: 'rgba(26,82,118,0.15)',  tension: .3 },
        { label: 'Units Requested', data: rows.map(r => r.RequestedUnits), borderColor: 'rgba(183,134,11,0.9)', backgroundColor: 'rgba(183,134,11,0.15)', tension: .3 },
        { label: 'Units Issued',    data: rows.map(r => r.IssuedUnits),    borderColor: 'rgba(192,57,43,0.9)',  backgroundColor: 'rgba(192,57,43,0.15)',  tension: .3 },
        { label: 'Wasted Units',    data: rows.map(r => r.WastedUnits),    borderColor: 'rgba(120,120,120,0.9)', backgroundColor: 'rgba(120,120,120,0.1)', tension: .3, borderDash: [4, 3] },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { font: { size: 10 }, boxWidth: 12 } } },
      scales: { y: { beginAtZero: true, ticks: { precision: 0, font: { size: 10 } } }, x: { ticks: { font: { size: 9 } } } }
    }
  });
}

function renderAnDonationTypeChart(rows) {
  if (_anDonationTypeChart) { _anDonationTypeChart.destroy(); _anDonationTypeChart = null; }
  const el = document.getElementById('anDonationTypeChart');
  if (!el) return;
  if (!Array.isArray(rows) || !rows.length) { noDataMsg(el); return; }
  _anDonationTypeChart = new Chart(el, {
    type: 'bar',
    data: {
      labels: rows.map(r => r.DonationType),
      datasets: [{ label: 'Donations', data: rows.map(r => r.DonationCount), backgroundColor: 'rgba(192,57,43,0.85)' }]
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { x: { beginAtZero: true, ticks: { precision: 0, font: { size: 10 } } }, y: { ticks: { font: { size: 11 } } } }
    }
  });
}

function renderAnRetentionChart(rows) {
  if (_anRetentionChart) { _anRetentionChart.destroy(); _anRetentionChart = null; }
  const el = document.getElementById('anRetentionChart');
  const pctEl = document.getElementById('anRetentionPct');
  if (!el) return;
  if (!Array.isArray(rows) || !rows.length) { noDataMsg(el); if (pctEl) pctEl.textContent = ''; return; }
  const totalReturning = rows.reduce((s, r) => s + (r.ReturningDonations || 0), 0);
  const totalActive    = rows.reduce((s, r) => s + (r.ActiveDonors || 0), 0);
  if (pctEl) pctEl.textContent = totalActive > 0 ? `— ${Math.round(totalReturning / totalActive * 100)}% retention` : '';
  _anRetentionChart = new Chart(el, {
    type: 'bar',
    data: {
      labels: rows.map(r => String(r.MonthStart).slice(0, 7)),
      datasets: [
        { label: 'New Donors',       data: rows.map(r => r.NewDonors),          backgroundColor: 'rgba(26,82,118,0.85)', stack: 's' },
        { label: 'Returning Donors', data: rows.map(r => r.ReturningDonations), backgroundColor: 'rgba(30,132,73,0.85)', stack: 's' },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { font: { size: 10 }, boxWidth: 12 } } },
      scales: { x: { stacked: true, ticks: { font: { size: 9 } } }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0, font: { size: 10 } } } }
    }
  });
}

const FULFILMENT_STATUS_ORDER  = ['Fully fulfilled', 'Partially fulfilled', 'Not fulfilled', 'Issued above request'];
const FULFILMENT_STATUS_COLORS = {
  'Fully fulfilled': 'rgba(30,132,73,0.85)',
  'Partially fulfilled': 'rgba(183,134,11,0.85)',
  'Not fulfilled': 'rgba(192,57,43,0.85)',
  'Issued above request': 'rgba(26,82,118,0.85)',
};
let _anFulfilmentRows = [];

function renderAnFulfilmentChart(rows) {
  if (_anFulfilmentChart) { _anFulfilmentChart.destroy(); _anFulfilmentChart = null; }
  const el = document.getElementById('anFulfilmentChart');
  _anFulfilmentRows = Array.isArray(rows) ? rows : [];
  renderFulfilmentAlert(_anFulfilmentRows);
  if (!el) return;
  if (!_anFulfilmentRows.length) { noDataMsg(el); return; }
  // Stacked by month instead of one aggregate doughnut, so a trend across
  // the selected period is visible, not just a single-period snapshot.
  const buckets = {};
  _anFulfilmentRows.forEach(r => {
    const month = String(r.RequestDate || '').slice(0, 7);
    if (!month) return;
    if (!buckets[month]) buckets[month] = {};
    buckets[month][r.FulfilmentStatus] = (buckets[month][r.FulfilmentStatus] || 0) + 1;
  });
  const months = Object.keys(buckets).sort();
  const datasets = FULFILMENT_STATUS_ORDER.map(status => ({
    label: status,
    data: months.map(m => buckets[m][status] || 0),
    backgroundColor: FULFILMENT_STATUS_COLORS[status],
    stack: 's',
  }));
  _anFulfilmentChart = new Chart(el, {
    type: 'bar',
    data: { labels: months, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { font: { size: 10 }, boxWidth: 12 } } },
      scales: {
        x: { stacked: true, ticks: { font: { size: 10 } } },
        y: { stacked: true, beginAtZero: true, ticks: { precision: 0, font: { size: 10 } } },
      },
    },
  });
}

// Department × month fulfilment-rate heatmap. Colored red/amber/green by
// rate (not by volume, unlike the demand heatmap above) since the point
// here is spotting *which department, which month* is underserved.
function renderAnFulfilmentHeatmap(rows) {
  const el = document.getElementById('anFulfilmentHeatmap');
  if (!el) return;
  const withDept = rows.filter(r => r.Department && r.RequestDate);
  if (!withDept.length) { el.innerHTML = '<div class="rt-empty">No department data for this period.</div>'; return; }

  const cellMap = {};
  const months = new Set(), depts = new Set();
  withDept.forEach(r => {
    const month = String(r.RequestDate).slice(0, 7);
    months.add(month); depts.add(r.Department);
    const key = `${r.Department}|${month}`;
    if (!cellMap[key]) cellMap[key] = { requested: 0, issued: 0 };
    cellMap[key].requested += r.RequestedUnits || 0;
    cellMap[key].issued    += r.IssuedUnits || 0;
  });
  const monthList = [...months].sort();
  const deptList  = [...depts].sort();

  const bucketRgb = rate => rate >= 90 ? '30,132,73' : rate >= 50 ? '183,134,11' : '192,57,43';

  let html = '<table><thead><tr><th></th>' + monthList.map(m => `<th>${m}</th>`).join('') + '</tr></thead><tbody>';
  deptList.forEach(dept => {
    html += `<tr><th class="row-label">${dept}</th>`;
    monthList.forEach(m => {
      const cell = cellMap[`${dept}|${m}`];
      if (!cell || !cell.requested) { html += '<td class="empty">·</td>'; return; }
      const rate  = Math.round(100 * cell.issued / cell.requested);
      const alpha = (0.4 + Math.min(rate, 100) / 100 * 0.6).toFixed(2);
      html += `<td style="background:rgba(${bucketRgb(rate)},${alpha})" title="${dept} — ${m}: ${rate}% fulfilled (${cell.issued}/${cell.requested} units)">${rate}%</td>`;
    });
    html += '</tr>';
  });
  html += '</tbody></table>';
  el.innerHTML = html;
}

const FULFILMENT_THRESHOLD_KEY = 'sbb_fulfilment_alert_threshold';

function getFulfilmentThreshold() {
  const saved = parseFloat(localStorage.getItem(FULFILMENT_THRESHOLD_KEY));
  return Number.isFinite(saved) ? saved : 80;
}

function initFulfilmentThreshold() {
  const input = document.getElementById('anFulfilmentThreshold');
  if (input) input.value = getFulfilmentThreshold();
}

function onFulfilmentThresholdChange() {
  const val = parseFloat(document.getElementById('anFulfilmentThreshold').value);
  localStorage.setItem(FULFILMENT_THRESHOLD_KEY, Number.isFinite(val) ? val : 80);
  renderFulfilmentAlert(_anFulfilmentRows);
}

// Operational alert: overall fulfilment for the selected period vs the
// admin's own configurable threshold (persisted per-browser, not shared —
// see the Settings-vs-inline-control discussion this was chosen over).
function renderFulfilmentAlert(rows) {
  const el = document.getElementById('anFulfilmentAlert');
  if (!el) return;
  if (!rows.length) { el.style.display = 'none'; return; }
  const totalRequested = rows.reduce((s, r) => s + (r.RequestedUnits || 0), 0);
  const totalIssued    = rows.reduce((s, r) => s + (r.IssuedUnits || 0), 0);
  const rate = totalRequested > 0 ? (totalIssued / totalRequested) * 100 : 0;
  const threshold = getFulfilmentThreshold();
  if (rate >= threshold) { el.style.display = 'none'; return; }
  const severity = rate < threshold - 15 ? 'critical' : 'warning';
  el.style.display = '';
  el.innerHTML = `
    <div class="excel-alert ${severity}">
      <div class="excel-alert-icon">⚠️</div>
      <div class="excel-alert-body">
        <div class="excel-alert-title">Fulfilment Below Threshold <span class="excel-alert-badge">${severity}</span></div>
        <div class="excel-alert-msg">Overall fulfilment for this period is ${rate.toFixed(1)}%, below your ${threshold}% alert threshold (${totalIssued} of ${totalRequested} units issued).</div>
      </div>
    </div>`;
}

function renderAnReturnChart(rows) {
  if (_anReturnChart) { _anReturnChart.destroy(); _anReturnChart = null; }
  const el = document.getElementById('anReturnChart');
  if (!el) return;
  if (!Array.isArray(rows) || !rows.length) { noDataMsg(el); return; }
  _anReturnChart = new Chart(el, {
    type: 'bar',
    data: { labels: rows.map(r => r.ComponentType || 'Unknown'), datasets: [{ label: 'Return Rate %', data: rows.map(r => r.ReturnRate), backgroundColor: 'rgba(183,134,11,0.85)' }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, max: 100, ticks: { font: { size: 10 } } }, x: { ticks: { font: { size: 10 } } } }
    }
  });
}

function renderAnTurnaroundChart(rows) {
  if (_anTurnaroundChart) { _anTurnaroundChart.destroy(); _anTurnaroundChart = null; }
  const el = document.getElementById('anTurnaroundChart');
  if (!el) return;
  if (!Array.isArray(rows) || !rows.length) { noDataMsg(el); return; }
  const deptMap = {};
  rows.forEach(r => {
    const dept = r.Department || 'Unknown';
    if (!deptMap[dept]) deptMap[dept] = { routine: null, emergency: null };
    if (r.IsEmergency) deptMap[dept].emergency = r.AverageTurnaroundMinutes;
    else deptMap[dept].routine = r.AverageTurnaroundMinutes;
  });
  const depts = Object.keys(deptMap);
  _anTurnaroundChart = new Chart(el, {
    type: 'bar',
    data: {
      labels: depts,
      datasets: [
        { label: 'Routine',   data: depts.map(d => deptMap[d].routine),   backgroundColor: 'rgba(26,82,118,0.85)' },
        { label: 'Emergency', data: depts.map(d => deptMap[d].emergency), backgroundColor: 'rgba(192,57,43,0.85)' },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { font: { size: 10 }, boxWidth: 12 } } },
      scales: { y: { beginAtZero: true, ticks: { font: { size: 10 } } }, x: { ticks: { font: { size: 9 }, maxRotation: 45 } } }
    }
  });
}

function renderAnHeatmap(rows) {
  const el = document.getElementById('anHeatmap');
  if (!el) return;
  if (!Array.isArray(rows) || !rows.length) { el.innerHTML = '<div class="rt-empty">No data for this period.</div>'; return; }
  const max = Math.max(1, ...rows.map(r => r.RequestCount));
  const cellMap = {};
  const weekdayNames = {};
  rows.forEach(r => { cellMap[`${r.WeekdayNumber}-${r.RequestHour}`] = r; weekdayNames[r.WeekdayNumber] = r.WeekdayName; });
  const weekdays = Object.keys(weekdayNames).map(Number).sort((a, b) => a - b);
  const hours = Array.from({ length: 24 }, (_, i) => i);

  let html = '<table><thead><tr><th></th>' + hours.map(h => `<th>${h}</th>`).join('') + '</tr></thead><tbody>';
  weekdays.forEach(wd => {
    html += `<tr><th class="row-label">${weekdayNames[wd]}</th>`;
    hours.forEach(h => {
      const cell = cellMap[`${wd}-${h}`];
      if (!cell || !cell.RequestCount) { html += '<td class="empty">·</td>'; return; }
      const alpha = 0.15 + (cell.RequestCount / max) * 0.85;
      html += `<td style="background:rgba(192,57,43,${alpha.toFixed(2)})" title="${weekdayNames[wd]} ${h}:00 — ${cell.RequestCount} requests, ${cell.UnitsRequested} units, ${cell.EmergencyRequests} emergency">${cell.RequestCount}</td>`;
    });
    html += '</tr>';
  });
  html += '</tbody></table>';
  el.innerHTML = html;
}

let _anAnomalyRows = [];

function isDemandAnomaly(row) {
  return !!row.DemandStatus && row.DemandStatus !== 'Normal';
}

function renderAnAnomalyChart(rows) {
  if (_anAnomalyChart) { _anAnomalyChart.destroy(); _anAnomalyChart = null; }
  const el = document.getElementById('anAnomalyChart');
  const detailEl = document.getElementById('anAnomalyDetail');
  if (detailEl) detailEl.style.display = 'none';
  _anAnomalyRows = Array.isArray(rows) ? rows : [];
  if (!el) return;
  if (!_anAnomalyRows.length) { noDataMsg(el); return; }
  const labels = _anAnomalyRows.map(r => String(r.DemandDate).slice(0, 10));
  const upper = _anAnomalyRows.map(r => r.Previous30DayAverage != null && r.Previous30DayStdDev != null ? r.Previous30DayAverage + 2 * r.Previous30DayStdDev : null);
  const lower = _anAnomalyRows.map(r => r.Previous30DayAverage != null && r.Previous30DayStdDev != null ? Math.max(0, r.Previous30DayAverage - 2 * r.Previous30DayStdDev) : null);
  const pointColors = _anAnomalyRows.map(r => isDemandAnomaly(r) ? 'rgba(192,57,43,1)' : 'rgba(26,82,118,0.9)');
  const pointRadii  = _anAnomalyRows.map(r => isDemandAnomaly(r) ? 5 : 1.5);
  // Alert points get a much bigger invisible hit target than their drawn
  // radius, so they're easy to click precisely — normal days keep a tight
  // hit target so a stray click on the line doesn't pop up a detail card.
  const hitRadii = _anAnomalyRows.map(r => isDemandAnomaly(r) ? 12 : 3);
  _anAnomalyChart = new Chart(el, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Units Requested', data: _anAnomalyRows.map(r => r.UnitsRequested), borderColor: 'rgba(26,82,118,0.9)', backgroundColor: 'transparent', tension: .2, pointBackgroundColor: pointColors, pointRadius: pointRadii, pointHoverRadius: pointRadii.map(r => r + 2), pointHitRadius: hitRadii },
        { label: '30-day Average',  data: _anAnomalyRows.map(r => r.Previous30DayAverage), borderColor: 'rgba(120,120,120,0.7)', backgroundColor: 'transparent', tension: .2, pointRadius: 0, borderDash: [4, 3] },
        { label: 'Upper Threshold', data: upper, borderColor: 'rgba(192,57,43,0.4)', backgroundColor: 'transparent', pointRadius: 0, borderDash: [2, 3] },
        { label: 'Lower Threshold', data: lower, borderColor: 'rgba(192,57,43,0.4)', backgroundColor: 'transparent', pointRadius: 0, borderDash: [2, 3] },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      // Clickable alert points: only the "Units Requested" series (dataset 0)
      // carries per-point hit radii, so this only fires near an actual dot —
      // clicking empty chart space or the dashed threshold lines does nothing.
      onClick: (evt, _els, chart) => {
        const hit = chart.getElementsAtEventForMode(evt, 'nearest', { intersect: true }, true)
          .find(p => p.datasetIndex === 0);
        if (hit) showAnomalyDetail(hit.index);
      },
      onHover: (evt, _els, chart) => {
        const hit = chart.getElementsAtEventForMode(evt, 'nearest', { intersect: true }, true)
          .find(p => p.datasetIndex === 0);
        evt.native.target.style.cursor = hit ? 'pointer' : 'default';
      },
      plugins: { legend: { position: 'bottom', labels: { font: { size: 10 }, boxWidth: 12 } } },
      scales: { y: { beginAtZero: true, ticks: { font: { size: 10 } } }, x: { ticks: { font: { size: 8 }, maxTicksLimit: 20 } } }
    }
  });
}

function showAnomalyDetail(index) {
  const row = _anAnomalyRows[index];
  const el  = document.getElementById('anAnomalyDetail');
  if (!row || !el) return;
  const anomaly = isDemandAnomaly(row);
  const date = String(row.DemandDate).slice(0, 10);
  const avg  = row.Previous30DayAverage != null ? Number(row.Previous30DayAverage).toFixed(1) : '—';
  const sd   = row.Previous30DayStdDev  != null ? Number(row.Previous30DayStdDev).toFixed(1)  : '—';
  const z    = row.DemandZScore         != null ? Number(row.DemandZScore).toFixed(2)         : '—';
  el.style.display = '';
  el.className = 'an-anomaly-detail' + (anomaly ? ' alert' : '');
  el.innerHTML = `
    <div class="an-anomaly-detail-head">${anomaly ? '⚠️' : 'ℹ️'} ${date} — ${row.DemandStatus || 'Normal'}</div>
    <div class="an-anomaly-detail-body">
      <span>Units requested: <strong>${row.UnitsRequested}</strong></span>
      <span>30-day average: <strong>${avg}</strong></span>
      <span>30-day std dev: <strong>${sd}</strong></span>
      <span>Z-score: <strong>${z}</strong></span>
    </div>`;
}

async function loadExpiryRisk() {
  const days = document.getElementById('anExpiryDays').value || 14;
  const r = await apiFetch(`${API}/api/analytics/expiry-risk?expiryDays=${encodeURIComponent(days)}`);
  if (!r) return;
  const rows = await r.json();
  _anExpiryRows = Array.isArray(rows) ? rows : [];
  _anPages.expiry = 1;
  renderAnExpiryComponentChart(_anExpiryRows);
  renderAnExpiryGroupChart(_anExpiryRows);
  renderAnExpiryTable();
}

// Counts rows per key (component/blood group) split by risk tier, e.g.
// { 'RBC': { Critical: 3, 'High risk': 5 }, ... } — the shared input both
// stacked-bar charts below turn into per-tier datasets.
function riskBuckets(rows, keyFn) {
  const buckets = {};
  rows.forEach(row => {
    const key = keyFn(row) || 'Unknown';
    if (!buckets[key]) buckets[key] = {};
    buckets[key][row.ExpiryRisk] = (buckets[key][row.ExpiryRisk] || 0) + 1;
  });
  return buckets;
}

function riskDatasets(buckets, labels) {
  return EXPIRY_RISK_ORDER.map(tier => ({
    label: tier,
    data: labels.map(l => buckets[l]?.[tier] || 0),
    backgroundColor: EXPIRY_RISK_COLORS[tier],
    stack: 's',
  }));
}

function renderAnExpiryComponentChart(rows) {
  if (_anExpiryComponentChart) { _anExpiryComponentChart.destroy(); _anExpiryComponentChart = null; }
  const el = document.getElementById('anExpiryComponentChart');
  if (!el) return;
  if (!rows.length) { noDataMsg(el); return; }
  const buckets = riskBuckets(rows, r => r.ComponentType || r.Component);
  // Busiest component first — the one needing the most attention leads.
  const labels = Object.keys(buckets).sort((a, b) =>
    Object.values(buckets[b]).reduce((s, n) => s + n, 0) - Object.values(buckets[a]).reduce((s, n) => s + n, 0));
  _anExpiryComponentChart = new Chart(el, {
    type: 'bar',
    data: { labels, datasets: riskDatasets(buckets, labels) },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { font: { size: 10 }, boxWidth: 12 } } },
      scales: {
        x: { stacked: true, ticks: { font: { size: 10 } } },
        y: { stacked: true, beginAtZero: true, ticks: { precision: 0, font: { size: 10 } } },
      },
    },
  });
}

function renderAnExpiryGroupChart(rows) {
  if (_anExpiryGroupChart) { _anExpiryGroupChart.destroy(); _anExpiryGroupChart = null; }
  const el = document.getElementById('anExpiryGroupChart');
  if (!el) return;
  if (!rows.length) { noDataMsg(el); return; }
  const buckets = riskBuckets(rows, r => r.BloodGroup);
  const BG_ORDER = ['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+'];
  const known = BG_ORDER.filter(g => buckets[g]);
  const rest  = Object.keys(buckets).filter(g => !BG_ORDER.includes(g)).sort();
  const labels = [...known, ...rest];
  _anExpiryGroupChart = new Chart(el, {
    type: 'bar',
    data: { labels, datasets: riskDatasets(buckets, labels) },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { font: { size: 10 }, boxWidth: 12 } } },
      scales: {
        x: { stacked: true, ticks: { font: { size: 10 } } },
        y: { stacked: true, beginAtZero: true, ticks: { precision: 0, font: { size: 10 } } },
      },
    },
  });
}

// ═══════════════════════════════════════════════════════
// EXPIRY CALENDAR — normal month-grid view. Independent of the "Within N
// days" filter above: the admin picks a year + month (or steps with ◀/▶/
// Today) and only that month's rows are fetched from
// /api/analytics/expiry-risk/month — so a hospital's full backlog (tens of
// thousands of rows) never has to load at once just to browse a calendar.
// ═══════════════════════════════════════════════════════
let _anCalYear = null, _anCalMonth = null; // month is 1-12
let _anCalRows = [];
let _anCalSelectedDay = null;
let _anCalControlsInit = false;

function anCalTodayStr() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}

function initExpiryCalendarControls() {
  if (_anCalControlsInit) return;
  _anCalControlsInit = true;
  const now = new Date();
  _anCalYear  = now.getFullYear();
  _anCalMonth = now.getMonth() + 1;

  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const monthSel = document.getElementById('anCalMonth');
  monthSel.innerHTML = monthNames.map((m, i) => `<option value="${i + 1}">${m}</option>`).join('');
  monthSel.value = _anCalMonth;

  const yearSel  = document.getElementById('anCalYear');
  const startY   = now.getFullYear() - 5, endY = now.getFullYear() + 1;
  yearSel.innerHTML = Array.from({ length: endY - startY + 1 }, (_, i) => startY + i)
    .map(y => `<option value="${y}">${y}</option>`).join('');
  yearSel.value = _anCalYear;
}

function anCalShiftMonth(delta) {
  _anCalMonth += delta;
  if (_anCalMonth > 12) { _anCalMonth = 1;  _anCalYear++; }
  if (_anCalMonth < 1)  { _anCalMonth = 12; _anCalYear--; }
  document.getElementById('anCalMonth').value = _anCalMonth;
  document.getElementById('anCalYear').value  = _anCalYear;
  loadAnExpiryCalendarMonth();
}

function anCalToday() {
  const now = new Date();
  _anCalYear  = now.getFullYear();
  _anCalMonth = now.getMonth() + 1;
  document.getElementById('anCalMonth').value = _anCalMonth;
  document.getElementById('anCalYear').value  = _anCalYear;
  loadAnExpiryCalendarMonth();
}

async function loadAnExpiryCalendarMonth() {
  _anCalYear  = parseInt(document.getElementById('anCalYear').value)  || _anCalYear;
  _anCalMonth = parseInt(document.getElementById('anCalMonth').value) || _anCalMonth;
  const el = document.getElementById('anExpiryCalendar');
  if (el) el.innerHTML = '<div class="rt-empty">Loading…</div>';
  document.getElementById('anExpiryDayDetail').style.display = 'none';
  _anCalSelectedDay = null;

  const r = await apiFetch(`${API}/api/analytics/expiry-risk/month?year=${_anCalYear}&month=${_anCalMonth}`);
  if (!r) return;
  const rows = await r.json();
  _anCalRows = Array.isArray(rows) ? rows : [];
  renderAnExpiryCalendarGrid();
}

function renderAnExpiryCalendarGrid() {
  const el = document.getElementById('anExpiryCalendar');
  if (!el) return;

  // Worst (most severe) tier per day — every unit on the same date actually
  // shares one tier already (it's a pure function of the date), this just
  // guards against any edge-case mismatch.
  const byDay = {};
  _anCalRows.forEach(row => {
    const d = String(row.ExpiryDate || '').slice(0, 10);
    if (!d) return;
    if (!byDay[d]) byDay[d] = { count: 0, worstRisk: row.ExpiryRisk };
    byDay[d].count++;
    if (EXPIRY_RISK_RANK[row.ExpiryRisk] < EXPIRY_RISK_RANK[byDay[d].worstRisk]) byDay[d].worstRisk = row.ExpiryRisk;
  });

  const firstOfMonth = new Date(Date.UTC(_anCalYear, _anCalMonth - 1, 1));
  const daysInMonth   = new Date(Date.UTC(_anCalYear, _anCalMonth, 0)).getUTCDate();
  const startWeekday  = firstOfMonth.getUTCDay(); // 0 = Sunday

  const cells = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let day = 1; day <= daysInMonth; day++) cells.push(day);
  while (cells.length % 7 !== 0) cells.push(null);

  const todayStr = anCalTodayStr();
  const dowHeader = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d => `<div class="an-cal-dow">${d}</div>`).join('');

  const cellsHtml = cells.map(day => {
    if (!day) return `<div class="an-cal-cell empty"></div>`;
    const dateStr = `${_anCalYear}-${String(_anCalMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const info      = byDay[dateStr];
    const classes   = ['an-cal-cell'];
    if (dateStr === todayStr) classes.push('today');
    if (dateStr === _anCalSelectedDay) classes.push('selected');
    if (info) classes.push('has-data');
    const style = info ? ` style="background:${EXPIRY_RISK_COLORS[info.worstRisk] || '#999'};color:${EXPIRY_RISK_TEXT[info.worstRisk] || '#fff'}"` : '';
    const title = info ? ` title="${info.worstRisk} — ${info.count} unit${info.count !== 1 ? 's' : ''} expiring ${dateStr}"` : '';
    return `
      <div class="${classes.join(' ')}"${style}${title} onclick="selectAnExpiryDay('${dateStr}')">
        <div class="acc-daynum">${day}</div>
        ${info ? `<div class="acc-count">${info.count}</div>` : ''}
      </div>`;
  }).join('');

  el.innerHTML = `<div class="an-cal-grid">${dowHeader}${cellsHtml}</div>`;
}

function selectAnExpiryDay(dateStr) {
  _anCalSelectedDay = dateStr;
  _anPages.day = 1;
  renderAnExpiryCalendarGrid();
  renderAnExpiryDayDetail(dateStr);
}

function renderAnExpiryDayDetail(dateStr) {
  const rows = _anCalRows.filter(r => String(r.ExpiryDate || '').slice(0, 10) === dateStr);
  const el = document.getElementById('anExpiryDayDetail');
  el.style.display = '';
  if (!rows.length) {
    el.innerHTML = `<div class="rt-empty">No units expiring on ${dateStr}.</div>`;
    return;
  }
  const { slice, footer } = anPaginate('day', rows, 'Units');
  el.innerHTML = `
    <div class="consump-panel-title">Units expiring on ${dateStr} (${rows.length})</div>
    <table class="consump-table">
      <thead><tr><th>Unit</th><th>Component</th><th>Blood Group</th><th>Risk</th></tr></thead>
      <tbody>${slice.map(u => `
        <tr>
          <td><strong>${u.UnitNumber ?? ''}</strong></td>
          <td>${u.ComponentType || u.Component || '—'}</td>
          <td>${u.BloodGroup || '—'}</td>
          <td>${riskBadge(u.ExpiryRisk)}</td>
        </tr>`).join('')}
      </tbody>
    </table>${footer}`;
}

// ── Shared pager for the analytics tables (same look as the Categories table) ──
const AN_PAGE_SIZE = 10;
const _anPages = { expiry: 1, recall: 1, day: 1 };

// Clamps the stored page for `key` and returns { slice, footer } for rows.
function anPaginate(key, rows, noun) {
  const totalPages = Math.max(1, Math.ceil(rows.length / AN_PAGE_SIZE));
  const page = Math.min(Math.max(1, _anPages[key]), totalPages);
  _anPages[key] = page;
  const start = (page - 1) * AN_PAGE_SIZE;
  const slice = rows.slice(start, start + AN_PAGE_SIZE);
  const info  = `<span class="excel-page-info">${noun} ${start + 1}–${start + slice.length} of ${rows.length.toLocaleString()}</span>`;
  if (totalPages <= 1) return { slice, footer: `<div class="excel-pagination">${info}</div>` };
  const btn = (p, label, disabled) =>
    `<button class="excel-page-btn" onclick="anGoPage('${key}',${p})" ${disabled ? 'disabled' : ''}>${label}</button>`;
  const footer = `<div class="excel-pagination">
      ${btn(1, '«', page === 1)}${btn(page - 1, '‹', page === 1)}
      <span class="excel-page-info">Page ${page} of ${totalPages}</span>
      ${btn(page + 1, '›', page === totalPages)}${btn(totalPages, '»', page === totalPages)}
      ${info}
    </div>`;
  return { slice, footer };
}

function anGoPage(key, page) {
  _anPages[key] = page;
  if (key === 'expiry') renderAnExpiryTable();
  else if (key === 'recall') renderAnRecallTable();
  else if (key === 'day' && _anCalSelectedDay) renderAnExpiryDayDetail(_anCalSelectedDay);
}

function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function riskBadge(risk) {
  const color = EXPIRY_RISK_COLORS[risk] || '#999';
  return `<span class="an-badge risk-badge" style="background:${hexToRgba(color, 0.14)}"><span class="risk-dot" style="background:${color}"></span>${risk || '—'}</span>`;
}

const EXPIRY_RISK_RANK = { 'Expired': 0, 'Critical': 1, 'High risk': 2, 'Expiring soon': 3 };

function sortAnExpiryRows(rows, key, dir) {
  const mul = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    let av, bv;
    switch (key) {
      case 'unit':      av = a.UnitNumber ?? '';                         bv = b.UnitNumber ?? '';                         break;
      case 'component': av = a.ComponentType || a.Component || '';       bv = b.ComponentType || b.Component || '';       break;
      case 'group':      av = a.BloodGroup || '';                         bv = b.BloodGroup || '';                         break;
      case 'expiry':     av = a.ExpiryDate || '';                         bv = b.ExpiryDate || '';                         break;
      case 'risk':       av = EXPIRY_RISK_RANK[a.ExpiryRisk] ?? 9;        bv = EXPIRY_RISK_RANK[b.ExpiryRisk] ?? 9;        break;
      default:           av = a.DaysToExpiry;                             bv = b.DaysToExpiry;
    }
    if (typeof av === 'string') { av = av.toLowerCase(); bv = String(bv).toLowerCase(); }
    if (av < bv) return -1 * mul;
    if (av > bv) return  1 * mul;
    return 0;
  });
}

function setAnExpirySort(key) {
  _anExpirySort = _anExpirySort.key === key
    ? { key, dir: _anExpirySort.dir === 'asc' ? 'desc' : 'asc' }
    : { key, dir: 'asc' };
  _anPages.expiry = 1;
  renderAnExpiryTable();
}

function renderAnExpiryTable() {
  const el = document.getElementById('anExpiryTable');
  if (!el) return;
  if (!_anExpiryRows.length) { el.innerHTML = '<div class="rt-empty">No units expiring within this window.</div>'; return; }
  const sorted = sortAnExpiryRows(_anExpiryRows, _anExpirySort.key, _anExpirySort.dir);
  const { slice, footer } = anPaginate('expiry', sorted, 'Units');
  const arrow  = key => _anExpirySort.key === key ? (_anExpirySort.dir === 'asc' ? ' ▲' : ' ▼') : '';
  const th     = (key, label) => `<th class="an-sortable" onclick="setAnExpirySort('${key}')">${label}${arrow(key)}</th>`;
  el.innerHTML = `
    <table class="consump-table">
      <thead><tr>
        ${th('unit', 'Unit')}${th('component', 'Component')}${th('group', 'Blood Group')}${th('expiry', 'Expiry Date')}${th('days', 'Days Left')}${th('risk', 'Risk')}
      </tr></thead>
      <tbody>${slice.map(u => `
        <tr>
          <td><strong>${u.UnitNumber ?? ''}</strong></td>
          <td>${u.ComponentType || u.Component || '—'}</td>
          <td>${u.BloodGroup || '—'}</td>
          <td>${String(u.ExpiryDate || '').slice(0, 10)}</td>
          <td>${u.DaysToExpiry}</td>
          <td>${riskBadge(u.ExpiryRisk)}</td>
        </tr>`).join('')}
      </tbody>
    </table>${footer}`;
}

let _anRecallGroupChart = null;
let _anRecallRows = [];
let _anRecallSort = { key: 'days', dir: 'desc' };

async function loadDonorRecall() {
  const days = document.getElementById('anInactiveDays').value || 180;
  const r = await apiFetch(`${API}/api/analytics/donor-recall?inactiveDays=${encodeURIComponent(days)}`);
  if (!r) return;
  const rows = await r.json();
  _anRecallRows = Array.isArray(rows) ? rows : [];
  _anPages.recall = 1;
  renderAnRecallGroupChart(_anRecallRows);
  renderAnRecallTable();
}

function renderAnRecallGroupChart(rows) {
  if (_anRecallGroupChart) { _anRecallGroupChart.destroy(); _anRecallGroupChart = null; }
  const el = document.getElementById('anRecallGroupChart');
  if (!el) return;
  if (!rows.length) { noDataMsg(el); return; }
  const BG_ORDER = ['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+'];
  const counts = {};
  rows.forEach(d => { const g = d.BloodGroup || 'Unknown'; counts[g] = (counts[g] || 0) + 1; });
  const known = BG_ORDER.filter(g => counts[g]);
  const rest  = Object.keys(counts).filter(g => !BG_ORDER.includes(g)).sort();
  const labels = [...known, ...rest];
  _anRecallGroupChart = new Chart(el, {
    type: 'bar',
    data: { labels, datasets: [{ label: 'Inactive Donors', data: labels.map(g => counts[g]), backgroundColor: 'rgba(26,82,118,0.85)' }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, ticks: { precision: 0, font: { size: 10 } } }, x: { ticks: { font: { size: 10 } } } }
    }
  });
}

function yesNoBadge(val, yesLabel, noLabel) {
  return val
    ? `<span class="an-badge risk-badge" style="background:${hexToRgba('#1A7F4B', 0.14)}"><span class="risk-dot" style="background:#1A7F4B"></span>${yesLabel}</span>`
    : `<span class="an-badge risk-badge" style="background:${hexToRgba('#8896A7', 0.14)}"><span class="risk-dot" style="background:#8896A7"></span>${noLabel}</span>`;
}

function sortAnRecallRows(rows, key, dir) {
  const mul = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    let av, bv;
    switch (key) {
      case 'name':      av = a.DonorName || '';               bv = b.DonorName || '';               break;
      case 'group':     av = a.BloodGroup || '';               bv = b.BloodGroup || '';               break;
      case 'freq':      av = a.DonationFrequencyDays ?? 1e9;   bv = b.DonationFrequencyDays ?? 1e9;   break;
      case 'phone':     av = a.PhoneAvailable ? 1 : 0;         bv = b.PhoneAvailable ? 1 : 0;         break;
      case 'sms':       av = a.SmsConsent ? 1 : 0;             bv = b.SmsConsent ? 1 : 0;             break;
      case 'email':     av = a.EmailConsent ? 1 : 0;           bv = b.EmailConsent ? 1 : 0;           break;
      default:          av = a.DaysSinceDonation;              bv = b.DaysSinceDonation;
    }
    if (typeof av === 'string') { av = av.toLowerCase(); bv = String(bv).toLowerCase(); }
    if (av < bv) return -1 * mul;
    if (av > bv) return  1 * mul;
    return 0;
  });
}

function setAnRecallSort(key) {
  _anRecallSort = _anRecallSort.key === key
    ? { key, dir: _anRecallSort.dir === 'asc' ? 'desc' : 'asc' }
    : { key, dir: 'asc' };
  _anPages.recall = 1;
  renderAnRecallTable();
}

function renderAnRecallTable() {
  const el = document.getElementById('anRecallTable');
  if (!el) return;
  if (!_anRecallRows.length) { el.innerHTML = '<div class="rt-empty">No inactive donors found for this threshold.</div>'; return; }
  const sorted = sortAnRecallRows(_anRecallRows, _anRecallSort.key, _anRecallSort.dir);
  const { slice, footer } = anPaginate('recall', sorted, 'Donors');
  const arrow  = key => _anRecallSort.key === key ? (_anRecallSort.dir === 'asc' ? ' ▲' : ' ▼') : '';
  const th     = (key, label) => `<th class="an-sortable" onclick="setAnRecallSort('${key}')">${label}${arrow(key)}</th>`;
  el.innerHTML = `
    <table class="consump-table">
      <thead><tr>
        ${th('name', 'Donor')}${th('group', 'Blood Group')}${th('days', 'Days Inactive')}${th('freq', 'Donation Frequency')}${th('phone', 'Phone Availability')}${th('sms', 'SMS Consent')}${th('email', 'Email Consent')}
      </tr></thead>
      <tbody>${slice.map(d => `
        <tr>
          <td><strong>${d.DonorName || '—'}</strong><br><span style="color:var(--text-soft);font-size:10.5px;">#${d.DonorNumber ?? ''}</span></td>
          <td>${d.BloodGroup || '—'}</td>
          <td>${d.DaysSinceDonation}</td>
          <td>${d.DonationFrequencyDays != null ? `every ${d.DonationFrequencyDays}d` : '—'}</td>
          <td>${yesNoBadge(d.PhoneAvailable, 'Available', 'Missing')}</td>
          <td>${yesNoBadge(d.SmsConsent, 'Consented', 'No consent')}</td>
          <td>${yesNoBadge(d.EmailConsent, 'Consented', 'No consent')}</td>
        </tr>`).join('')}
      </tbody>
    </table>${footer}`;
}
