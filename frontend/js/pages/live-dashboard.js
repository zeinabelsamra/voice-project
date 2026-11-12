// Live dashboard (eDelphyn categories)
// 
// Loaded as a classic script (shared global scope) — see index.html for load order.

// ═══════════════════════════════════════════════════════
// EXCEL FILES DASHBOARD — category-based
// ═══════════════════════════════════════════════════════
let excelActiveCategory = null;
let excelCurrentPage    = 1;
let excelChartInstances = [];
let excelSearchTimer    = null;
let excelActiveShortcut = null;

const CAT_CONFIG = {
  transfusion:     { icon: '🩸', label: 'Units Issued for Transfusion' },
  requests:        { icon: '📋', label: 'Patient Requests' },
  donors:          { icon: '🫀', label: 'Registered Donors' },
  wasted:          { icon: '⚠️', label: 'Wasted / Withdrawn Units' },
  sent_to_centres: { icon: '🚑', label: 'Sent to Other Centres' },
  external_units:  { icon: '📥', label: 'External Units from Other Centres' },
  generic:         { icon: '📊', label: 'Other Files' }
};

// Called by showPage('excel')
async function loadExcelFiles() { await loadExcelCategories(); }

async function loadExcelCategories() {
  try {
    const [catRes, alertRes] = await Promise.all([
      apiFetch(`${API}/api/dashboard/categories`),
      apiFetch(`${API}/api/dashboard/alerts`)
    ]);
    if (!catRes) return;
    const data = await catRes.json();
    // A failed query (eDelphyn unreachable, timed out, etc.) comes back as
    // {error: "..."} with a non-2xx status — render that as a visible error
    // state instead of letting it fall through as a fake empty category.
    if (!catRes.ok || data.error) {
      renderCategoryError(data.error || `Request failed (${catRes.status})`);
      return;
    }
    const topDepts      = data._topDepts          || [];
    const monthlyComp   = data._monthlyComparison || [];
    const cats          = Object.fromEntries(Object.entries(data).filter(([k]) => !k.startsWith('_')));
    renderCategoryGrid(cats);
    renderTopDepts(topDepts);
    renderMonthlyComparison(monthlyComp);
    if (alertRes) {
      const alertData = await alertRes.json();
      renderSmartAlerts(alertData.alerts || []);
    }
  } catch (e) { console.error('loadExcelCategories', e); renderCategoryError(e.message || 'Network error'); }
}

function renderCategoryError(message) {
  document.getElementById('excelAlertsSection').style.display   = 'none';
  document.getElementById('excelOverviewStrip').style.display   = 'none';
  document.getElementById('excelEfficiencyWrap').style.display  = 'none';
  document.getElementById('excelMonthlyCompWrap').style.display = 'none';
  document.getElementById('excelTopDeptsWrap').style.display    = 'none';
  document.getElementById('excelCatGrid').innerHTML = `
    <div class="excel-no-files" style="grid-column:1/-1;border-color:#e53e3e;background:#fff5f5;">
      <div style="font-size:22px;margin-bottom:6px;">⚠️ Couldn't reach eDelphyn</div>
      <div style="font-size:13px;color:var(--text-soft);margin-bottom:12px;">${message}</div>
      <button class="excel-filter-apply" onclick="loadExcelCategories()">🔄 Retry</button>
    </div>`;
}

const _dismissedAlerts = new Set(JSON.parse(sessionStorage.getItem('bb_dismissed_alerts') || '[]'));

function renderSmartAlerts(alerts) {
  const section = document.getElementById('excelAlertsSection');
  if (!section) return;

  const active = alerts.filter(a => !_dismissedAlerts.has(a.id));

  if (active.length === 0) {
    // Show green "all clear" only if there were actually no alerts at all
    if (alerts.length === 0) {
      section.style.display = '';
      section.innerHTML = `<div class="excel-no-alerts">✅ No active alerts — everything looks healthy for this month.</div>`;
    } else {
      section.style.display = 'none';
    }
    return;
  }

  const iconMap = {
    trash:    '🗑️',
    flask:    '🧪',
    chart:    '📈',
    return:   '↩️',
    blood:    '🩸',
    clock:    '⏰',
    calendar: '📅'
  };

  const CAT_LABELS = {
    transfusion: 'Transfusion', wasted: 'Wasted Units', donors: 'Donors',
    external_units: 'External Units', sent_to_centres: 'Sent to Centres',
    requests: 'Requests', generic: 'Other'
  };

  section.style.display = '';
  section.innerHTML = `
    <div class="excel-alerts-header">
      <div class="excel-alerts-title">⚡ Smart Alerts — ${active.length} active</div>
      <button class="excel-alerts-dismiss-all" onclick="dismissAllAlerts()">Dismiss all</button>
    </div>
    <div class="excel-alerts-wrap">
      ${active.map(a => `
        <div class="excel-alert ${a.severity}" id="alert_${a.id}">
          <div class="excel-alert-icon">${iconMap[a.icon] || '⚠️'}</div>
          <div class="excel-alert-body">
            <div class="excel-alert-title">
              ${a.title}
              <span class="excel-alert-badge">${a.severity}</span>
            </div>
            <div class="excel-alert-msg">${a.message}</div>
            <div class="excel-alert-footer">
              ${a.category ? `<button class="excel-alert-link" onclick="selectCategory('${a.category}')">View ${CAT_LABELS[a.category] || a.category} →</button>` : ''}
              ${a.page === 'stock' ? `<button class="excel-alert-link" onclick="showPage('stock')">Open Blood Stock →</button>` : ''}
            </div>
          </div>
          <button class="excel-alert-dismiss" title="Dismiss" onclick="dismissAlert('${a.id}')">✕</button>
        </div>`).join('')}
    </div>`;
}

function dismissAlert(id) {
  _dismissedAlerts.add(id);
  sessionStorage.setItem('bb_dismissed_alerts', JSON.stringify([..._dismissedAlerts]));
  const el = document.getElementById(`alert_${id}`);
  if (el) { el.style.opacity = '0'; el.style.transform = 'translateY(-4px)'; el.style.transition = 'all .2s ease'; setTimeout(() => loadExcelCategories(), 220); }
}

function dismissAllAlerts() {
  document.querySelectorAll('.excel-alert').forEach(el => {
    const id = el.id.replace('alert_', '');
    if (id) _dismissedAlerts.add(id);
  });
  sessionStorage.setItem('bb_dismissed_alerts', JSON.stringify([..._dismissedAlerts]));
  loadExcelCategories();
}

function renderCategoryGrid(cats) {
  const grid = document.getElementById('excelCatGrid');
  const keys = Object.keys(cats).filter(k => !k.startsWith('_'));
  if (keys.length === 0) {
    grid.innerHTML = `<div class="excel-no-files" style="grid-column:1/-1">No data available for this range.</div>`;
    document.getElementById('excelOverviewStrip').style.display = 'none';
    return;
  }
  grid.innerHTML = keys.map(type => {
    const cfg  = CAT_CONFIG[type] || CAT_CONFIG.generic;
    const rows = cats[type].rowCount || 0;
    return `<div class="excel-cat-card" onclick="selectCategory('${type}')">
      <div class="excel-cat-icon">${cfg.icon}</div>
      <div class="excel-cat-name">${cfg.label}</div>
      <div class="excel-cat-meta">
        <span class="excel-cat-count">🔴 Live</span>
        <span>·</span>
        <span>${rows.toLocaleString()} rows</span>
      </div>
    </div>`;
  }).join('');
  renderOverviewStrip(cats);
  renderEfficiencyScore(cats);
}

function renderEfficiencyScore(cats) {
  const wrap = document.getElementById('excelEfficiencyWrap');
  if (!wrap) return;

  const total  = t => cats[t]?.rowCount  || 0;
  const thisMo = t => cats[t]?.thisMonth || 0;
  const lastMo = t => cats[t]?.lastMonth || 0;

  const supply  = total('donors') + total('external_units');
  const used    = total('transfusion') + total('sent_to_centres');
  const wasted  = total('wasted');

  if (supply === 0) { wrap.style.display = 'none'; return; }

  const eff       = Math.min(100, (used / supply) * 100);
  const wasteRate = Math.min(100, (wasted / supply) * 100);
  const issueRate = Math.min(100, (total('transfusion') / supply) * 100);
  const sentRate  = Math.min(100, (total('sent_to_centres') / supply) * 100);
  const unaccounted = Math.max(0, supply - used - wasted);

  const supplyMo  = thisMo('donors') + thisMo('external_units');
  const usedMo    = thisMo('transfusion') + thisMo('sent_to_centres');
  const effMo     = supplyMo > 0 ? Math.min(100, (usedMo / supplyMo) * 100) : null;
  const supplyLm  = lastMo('donors') + lastMo('external_units');
  const usedLm    = lastMo('transfusion') + lastMo('sent_to_centres');
  const effLm     = supplyLm > 0 ? Math.min(100, (usedLm / supplyLm) * 100) : null;

  const effColor  = eff >= 85 ? '#38a169' : eff >= 65 ? '#dd6b20' : '#e53e3e';
  const grade     = eff >= 85 ? 'Excellent' : eff >= 70 ? 'Good' : eff >= 55 ? 'Fair' : 'Needs Improvement';

  let trendHTML = '';
  if (effMo !== null && effLm !== null) {
    const delta = (effMo - effLm);
    const trendColor = delta >= 0 ? '#38a169' : '#e53e3e';
    trendHTML = `<div style="font-size:11px;margin-top:4px;color:${trendColor};font-weight:700">${delta >= 0 ? '+' : ''}${delta.toFixed(1)}pp vs last month</div>`;
  }

  wrap.style.display = '';
  wrap.innerHTML = `
    <div style="background:#fff;border:1.5px solid var(--border);border-radius:12px;padding:20px 24px;">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text-soft);margin-bottom:16px;">Inventory Efficiency Score</div>
      <div style="display:flex;gap:28px;align-items:center;flex-wrap:wrap;">

        <!-- Gauge ring -->
        <div style="position:relative;width:96px;height:96px;flex-shrink:0;">
          <div style="width:96px;height:96px;border-radius:50%;background:conic-gradient(${effColor} ${eff.toFixed(1)}%, #e2e8f0 0);display:flex;align-items:center;justify-content:center;">
            <div style="width:70px;height:70px;border-radius:50%;background:#fff;display:flex;align-items:center;justify-content:center;flex-direction:column;">
              <span style="font-size:1.2rem;font-weight:800;color:${effColor};line-height:1">${eff.toFixed(0)}%</span>
            </div>
          </div>
        </div>

        <!-- Grade + trend -->
        <div style="flex-shrink:0;min-width:130px;">
          <div style="font-size:1.15rem;font-weight:800;color:${effColor}">${grade}</div>
          <div style="font-size:11.5px;color:var(--text-soft);margin-top:2px;">Overall efficiency</div>
          ${effMo !== null ? `<div style="font-size:12px;margin-top:6px;">This month: <strong style="color:${effColor}">${effMo.toFixed(0)}%</strong></div>` : ''}
          ${trendHTML}
        </div>

        <!-- Supply / Used / Wasted numbers -->
        <div style="flex:1;min-width:240px;display:grid;grid-template-columns:1fr 1fr;gap:10px 24px;">
          <div>
            <div style="font-size:9.5px;font-weight:700;text-transform:uppercase;color:var(--text-soft);">Total Supply</div>
            <div style="font-size:1.1rem;font-weight:800;color:#1a202c">${supply.toLocaleString()}</div>
            <div style="font-size:10px;color:#a0aec0">Donors: ${total('donors').toLocaleString()} · External: ${total('external_units').toLocaleString()}</div>
          </div>
          <div>
            <div style="font-size:9.5px;font-weight:700;text-transform:uppercase;color:var(--text-soft);">Productively Used</div>
            <div style="font-size:1.1rem;font-weight:800;color:#38a169">${used.toLocaleString()}</div>
            <div style="font-size:10px;color:#a0aec0">Issued: ${total('transfusion').toLocaleString()} · Sent: ${total('sent_to_centres').toLocaleString()}</div>
          </div>
          <div>
            <div style="font-size:9.5px;font-weight:700;text-transform:uppercase;color:var(--text-soft);">Wasted</div>
            <div style="font-size:1.1rem;font-weight:800;color:#e53e3e">${wasted.toLocaleString()}</div>
            <div style="font-size:10px;color:#a0aec0">${wasteRate.toFixed(1)}% of supply</div>
          </div>
          <div>
            <div style="font-size:9.5px;font-weight:700;text-transform:uppercase;color:var(--text-soft);">Unaccounted</div>
            <div style="font-size:1.1rem;font-weight:800;color:#718096">${unaccounted.toLocaleString()}</div>
            <div style="font-size:10px;color:#a0aec0">In storage or unmatched</div>
          </div>
        </div>

        <!-- Stacked breakdown bar -->
        <div style="flex:1;min-width:200px;">
          <div style="font-size:9.5px;font-weight:700;text-transform:uppercase;color:var(--text-soft);margin-bottom:7px;">Unit Breakdown</div>
          <div style="height:16px;border-radius:8px;overflow:hidden;display:flex;background:#e2e8f0;">
            <div title="Issued" style="width:${issueRate.toFixed(1)}%;background:#e53e3e;transition:width .6s ease;"></div>
            <div title="Sent to Centres" style="width:${sentRate.toFixed(1)}%;background:#4a9eff;transition:width .6s ease;"></div>
            <div title="Wasted" style="width:${wasteRate.toFixed(1)}%;background:#dd6b20;transition:width .6s ease;"></div>
          </div>
          <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:7px;font-size:10.5px;color:#4a5568;">
            <span><span style="color:#e53e3e;font-weight:800;">■</span> Issued ${issueRate.toFixed(0)}%</span>
            <span><span style="color:#4a9eff;font-weight:800;">■</span> Sent Out ${sentRate.toFixed(0)}%</span>
            <span><span style="color:#dd6b20;font-weight:800;">■</span> Wasted ${wasteRate.toFixed(0)}%</span>
            <span><span style="color:#cbd5e0;font-weight:800;">■</span> Other ${Math.max(0, 100 - issueRate - sentRate - wasteRate).toFixed(0)}%</span>
          </div>
        </div>

      </div>
    </div>`;
}

function renderOverviewStrip(cats) {
  const strip = document.getElementById('excelOverviewStrip');
  if (!strip) return;

  const total  = t => cats[t]?.rowCount  || 0;
  const thisMo = t => cats[t]?.thisMonth || 0;
  const lastMo = t => cats[t]?.lastMonth || 0;

  const issued   = total('transfusion');
  const wasted   = total('wasted');
  const donors   = total('donors');
  const extUnits = total('external_units');
  const sentOut  = total('sent_to_centres');
  const requests = total('requests');
  const allTotal = issued + wasted + donors + extUnits + sentOut + requests;
  const wastageRate = issued > 0 ? ((wasted / issued) * 100).toFixed(1) : null;

  const delta = (cur, prev, invertColor) => {
    if (!prev) return '';
    const pct  = Math.abs(((cur - prev) / prev) * 100).toFixed(0);
    const up   = cur >= prev;
    const good = invertColor ? !up : up;
    const arrow = up ? '↑' : '↓';
    const clr  = good ? '#38a169' : '#e53e3e';
    return `<span style="font-size:0.68rem;font-weight:700;color:${clr}">${arrow}${pct}% vs last mo</span>`;
  };

  const cards = [
    { icon: '📊', num: allTotal.toLocaleString(), label: 'Total Records',     sub: `${Object.keys(cats).filter(k=>!k.startsWith('_')).length} categories`, color: '#4a9eff', delta: '' },
    issued    ? { icon: '🩸', num: issued.toLocaleString(),   label: 'Units Issued',      sub: 'eDelphyn',           color: '#e53e3e', delta: delta(thisMo('transfusion'),  lastMo('transfusion'),  false) } : null,
    wasted    ? { icon: '🗑️', num: wasted.toLocaleString(),   label: 'Units Wasted',      sub: wastageRate ? `${wastageRate}% of issued` : 'eDelphyn', color: '#dd6b20', delta: delta(thisMo('wasted'),       lastMo('wasted'),       true)  } : null,
    donors    ? { icon: '👤', num: donors.toLocaleString(),   label: 'Donors Registered', sub: 'eDelphyn',                color: '#38a169', delta: delta(thisMo('donors'),       lastMo('donors'),       false) } : null,
    extUnits  ? { icon: '📥', num: extUnits.toLocaleString(), label: 'External Units',    sub: 'eDelphyn',        color: '#805ad5', delta: delta(thisMo('external_units'),lastMo('external_units'),false) } : null,
    sentOut   ? { icon: '📤', num: sentOut.toLocaleString(),  label: 'Sent to Centres',   sub: 'eDelphyn',       color: '#2b6cb0', delta: delta(thisMo('sent_to_centres'),lastMo('sent_to_centres'),false) } : null,
    requests  ? { icon: '📋', num: requests.toLocaleString(), label: 'Requests',           sub: 'eDelphyn',              color: '#d69e2e', delta: delta(thisMo('requests'),     lastMo('requests'),     false) } : null,
  ].filter(Boolean);

  strip.style.display = '';
  strip.innerHTML = `<div class="excel-overview-strip">${cards.map(c => `
    <div class="excel-ov-card" style="border-top-color:${c.color}">
      <div class="excel-ov-icon">${c.icon}</div>
      <div class="excel-ov-num" style="color:${c.color}">${c.num}</div>
      <div class="excel-ov-label">${c.label}</div>
      <div class="excel-ov-sub">${c.sub}</div>
      ${c.delta ? `<div style="margin-top:4px">${c.delta}</div>` : ''}
    </div>`).join('')}
  </div>`;
}

let excelMonthlyCompChart = null;
function renderMonthlyComparison(data) {
  const wrap = document.getElementById('excelMonthlyCompWrap');
  if (!wrap) return;
  if (!data || !data.length) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  if (excelMonthlyCompChart) { excelMonthlyCompChart.destroy(); excelMonthlyCompChart = null; }
  const ctx = document.getElementById('excelMonthlyCompChart').getContext('2d');
  excelMonthlyCompChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: data.map(d => d.label),
      datasets: [
        { label: 'Requests',      data: data.map(d => d.requests),     backgroundColor: '#4a9eff', borderRadius: 3 },
        { label: 'Units Issued',  data: data.map(d => d.transfusion),  backgroundColor: '#e53e3e', borderRadius: 3 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'top', labels: { font: { size: 11 } } } },
      scales: {
        x: { ticks: { font: { size: 9 }, maxRotation: 60, maxTicksLimit: 20 } },
        y: { beginAtZero: true, ticks: { precision: 0, font: { size: 10 } } }
      }
    }
  });
}

let excelTopDeptsChart = null;
function renderTopDepts(topDepts) {
  const wrap = document.getElementById('excelTopDeptsWrap');
  if (!wrap) return;
  if (!topDepts || !topDepts.length) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  if (excelTopDeptsChart) { excelTopDeptsChart.destroy(); excelTopDeptsChart = null; }
  // height: 36px per bar, min 120px, max 360px
  const h = Math.min(360, Math.max(120, topDepts.length * 36));
  const chartWrap = document.getElementById('excelTopDeptsChartWrap');
  chartWrap.style.height = h + 'px';
  const ctx = document.getElementById('excelTopDeptsChart').getContext('2d');
  excelTopDeptsChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: topDepts.map(d => d.label),
      datasets: [{
        data: topDepts.map(d => d.count),
        backgroundColor: topDepts.map((_, i) => `hsl(${210 + i * 15}, 70%, 55%)`),
        borderRadius: 4
      }]
    },
    options: {
      indexAxis: 'y',
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ` ${ctx.parsed.x.toLocaleString()} units` } } },
      scales: {
        x: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: '#f0f0f0' } },
        y: { ticks: { font: { size: 12 }, color: '#374151' } }
      },
      responsive: true,
      maintainAspectRatio: false
    }
  });
}

async function selectCategory(type) {
  excelActiveCategory = type;
  excelCurrentPage    = 1;
  document.getElementById('excelCatView').style.display  = 'none';
  document.getElementById('excelDashView').style.display = '';
  document.getElementById('excelBackBtn').style.display  = '';
  document.getElementById('excelChartsPdfBtn').style.display  = '';
  document.getElementById('excelChartsDocxBtn').style.display = '';
  const cfg = CAT_CONFIG[type] || CAT_CONFIG.generic;
  document.getElementById('excelViewTitle').textContent  = `${cfg.icon} ${cfg.label}`;
  document.getElementById('excelDateFrom').value = '';
  document.getElementById('excelDateTo').value   = '';
  await queryCategoryData();
}

function showExcelCategories() {
  excelActiveCategory = null;
  excelActiveShortcut = null;
  const si = document.getElementById('excelSearchInput');
  if (si) si.value = '';
  document.getElementById('excelDateFrom').value = '';
  document.getElementById('excelDateTo').value   = '';
  document.querySelectorAll('.excel-shortcut-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('excelCatView').style.display          = '';
  document.getElementById('excelDashView').style.display         = 'none';
  document.getElementById('excelBackBtn').style.display          = 'none';
  document.getElementById('excelChartsPdfBtn').style.display     = 'none';
  document.getElementById('excelChartsDocxBtn').style.display    = 'none';
  document.getElementById('excelTopDeptsWrap').style.display     = 'none';
  document.getElementById('excelMonthlyCompWrap').style.display  = 'none';
  document.getElementById('excelViewTitle').textContent          = '📁 Excel Files Dashboard';
  loadExcelCategories();
}

async function queryCategoryData() {
  if (!excelActiveCategory) return;
  const loading   = document.getElementById('excelLoading');
  const tableWrap = document.getElementById('excelTableWrap');
  loading.style.display   = '';
  tableWrap.style.display = 'none';
  document.getElementById('excelSummaryCards').style.display = 'none';
  document.getElementById('excelChartGrid').style.display    = 'none';

  try {
    const body = {
      category: excelActiveCategory,
      dateFrom: document.getElementById('excelDateFrom').value || null,
      dateTo:   document.getElementById('excelDateTo').value   || null,
      search:   (document.getElementById('excelSearchInput')?.value || '').trim() || null,
      page: excelCurrentPage, pageSize: 100
    };
    const r = await apiFetch(`${API}/api/dashboard/category-query`, { method: 'POST', body: JSON.stringify(body) });
    if (!r) { loading.style.display = 'none'; return; }
    const data = await r.json();
    if (data.error) { loading.style.display = 'none'; return; }

    const isFiltered = body.dateFrom || body.dateTo;
    let statusText = isFiltered
      ? `Showing ${data.filtered.toLocaleString()} of ${data.total.toLocaleString()} rows` : '';
    if (isFiltered && data.skippedUndated) {
      statusText += ` (${data.skippedUndated.toLocaleString()} skipped — missing date)`;
    }
    document.getElementById('excelFilterStatus').textContent = statusText;

    renderTypeCards(data.type, data.summary, data.total, data.filtered, data.dateColumn, data.columns.length);
    renderTypeCharts(data.type, data.summary, data.monthlyChart);
    renderExcelTable(data.columns, data.rows, data.filtered, data.page, data.pageSize, data.totalPages);
    tableWrap.style.display = '';
    loading.style.display   = 'none';
  } catch (e) {
    console.error('queryCategoryData', e);
    loading.style.display = 'none';
  }
}

function applyExcelFilter() {
  excelActiveShortcut = null;
  document.querySelectorAll('.excel-shortcut-btn').forEach(b => b.classList.remove('active'));
  excelCurrentPage = 1;
  queryCategoryData();
}
function clearExcelFilter() {
  document.getElementById('excelDateFrom').value = '';
  document.getElementById('excelDateTo').value   = '';
  const si = document.getElementById('excelSearchInput');
  if (si) si.value = '';
  excelActiveShortcut = null;
  document.querySelectorAll('.excel-shortcut-btn').forEach(b => b.classList.remove('active'));
  excelCurrentPage = 1;
  queryCategoryData();
}
function excelGoPage(p) { excelCurrentPage = p; queryCategoryData(); }

function excelShortcut(key) {
  const now   = new Date();
  const pad   = n => String(n).padStart(2, '0');
  const ymd   = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  let from = '', to = '';
  if (key === 'thisMonth') {
    from = `${now.getFullYear()}-${pad(now.getMonth()+1)}-01`;
    to   = ymd(new Date(now.getFullYear(), now.getMonth()+1, 0));
  } else if (key === 'lastMonth') {
    const first = new Date(now.getFullYear(), now.getMonth()-1, 1);
    const last  = new Date(now.getFullYear(), now.getMonth(), 0);
    from = ymd(first); to = ymd(last);
  } else if (key === 'thisYear') {
    from = `${now.getFullYear()}-01-01`;
    to   = `${now.getFullYear()}-12-31`;
  }
  document.getElementById('excelDateFrom').value = from;
  document.getElementById('excelDateTo').value   = to;
  excelActiveShortcut = key;
  document.querySelectorAll('.excel-shortcut-btn').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById(`shortcut${key.charAt(0).toUpperCase()+key.slice(1)}`);
  if (btn) btn.classList.add('active');
  excelCurrentPage = 1;
  queryCategoryData();
}

function scheduleExcelSearch() {
  clearTimeout(excelSearchTimer);
  excelSearchTimer = setTimeout(() => { excelCurrentPage = 1; queryCategoryData(); }, 400);
}

async function exportExcelData() {
  if (!excelActiveCategory) return;
  const body = {
    category: excelActiveCategory,
    dateFrom: document.getElementById('excelDateFrom').value || null,
    dateTo:   document.getElementById('excelDateTo').value   || null,
    search:   (document.getElementById('excelSearchInput')?.value || '').trim() || null,
  };
  try {
    const r = await fetch(`${API}/api/dashboard/category-export`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body)
    });
    if (!r.ok) { alert('Export failed'); return; }
    const blob = await r.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `${excelActiveCategory}-export.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (e) { alert('Export failed: ' + e.message); }
}

async function exportCategoryCharts(fileType) {
  if (!excelActiveCategory) return;
  if (!excelChartInstances.length) { showToast('No charts to export — load a category with data first.', 'error'); return; }

  // Bake the value/percentage labels into the canvas for this one snapshot —
  // update('none') redraws synchronously (no animation) so toDataURL() captures
  // the labelled frame, then we flip it back off to keep the live view hover-only.
  chartExportMode = true;
  excelChartInstances.forEach(c => { try { c.update('none'); } catch(_){} });

  const charts = [];
  excelChartInstances.forEach(inst => {
    const canvas = inst.canvas;
    const panel  = canvas?.closest('.excel-chart-panel');
    const title  = panel?.querySelector('.excel-chart-title')?.textContent?.trim() || 'Chart';
    if (!canvas) return;
    try {
      charts.push({ title, image: canvas.toDataURL('image/png', 1.0), width: canvas.width, height: canvas.height });
    } catch (e) { /* skip unreadable canvas */ }
  });

  chartExportMode = false;
  excelChartInstances.forEach(c => { try { c.update('none'); } catch(_){} });

  if (!charts.length) { showToast('No charts to export.', 'error'); return; }

  const cfg = CAT_CONFIG[excelActiveCategory] || CAT_CONFIG.generic;
  const body = {
    category:      excelActiveCategory,
    categoryLabel: cfg.label,
    dateFrom: document.getElementById('excelDateFrom').value || null,
    dateTo:   document.getElementById('excelDateTo').value   || null,
    charts
  };

  const btn = document.getElementById(fileType === 'pdf' ? 'excelChartsPdfBtn' : 'excelChartsDocxBtn');
  const origText = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Exporting…'; }
  try {
    const r = await fetch(`${API}/api/dashboard/category-charts-export/${fileType}`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body)
    });
    if (!r.ok) { showToast('Export failed.', 'error'); return; }
    const blob = await r.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `${excelActiveCategory}-charts.${fileType}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (e) {
    showToast('Export error: ' + e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = origText; }
  }
}

// ── Chart helpers ──────────────────────────────────────
const CHART_PALETTE = ['#C0392B','#1A5276','#1A7F4B','#E8B84B','#8E44AD','#2E86C1','#E67E22','#1ABC9C','#D4730A','#2C3E50','#F39C12','#16A085'];
const GROUP_COLOR_MAP = {'O+':'#2ecc71','O-':'#27ae60','A+':'#e74c3c','A-':'#c0392b','B+':'#3498db','B-':'#2980b9','AB+':'#9b59b6','AB-':'#8e44ad'};

// Data-label plugin: registered globally but OFF by default, so the live dashboard
// stays hover/tooltip-driven. The category charts below opt in with a `display`
// callback gated on chartExportMode, so labels only bake into the canvas — and
// therefore into the exported PNG snapshot — during a Charts PDF/Word export.
if (typeof ChartDataLabels !== 'undefined') {
  Chart.register(ChartDataLabels);
  Chart.defaults.set('plugins.datalabels', { display: false });
}
let chartExportMode = false;

function destroyCharts() {
  excelChartInstances.forEach(c => { try { c.destroy(); } catch(_){} });
  excelChartInstances = [];
}

function makeBar(id, labels, values, color) {
  const ctx = document.getElementById(id);
  if (!ctx) return;
  const c = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{ data: values, backgroundColor: color || 'rgba(192,57,43,0.75)', borderRadius: 4, borderSkipped: false }]
    },
    options: {
      responsive: true, maintainAspectRatio: true,
      plugins: {
        legend: { display: false },
        datalabels: {
          display: () => chartExportMode,
          anchor: 'end', align: 'top', offset: 2,
          color: '#1a2a3a', font: { size: 9, weight: 'bold' },
          formatter: v => v.toLocaleString()
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 10 }, maxRotation: 45 } },
        y: { beginAtZero: true, ticks: { font: { size: 10 } } }
      }
    }
  });
  excelChartInstances.push(c);
}

function makeDoughnut(id, items, useGroupColors) {
  const ctx = document.getElementById(id);
  if (!ctx) return;
  const labels = items.map(x => x.label);
  const values = items.map(x => x.count);
  const colors = useGroupColors
    ? labels.map(l => GROUP_COLOR_MAP[l] || '#95a5a6')
    : CHART_PALETTE.slice(0, labels.length);
  const c = new Chart(ctx, {
    type: 'doughnut',
    data: { labels, datasets: [{ data: values, backgroundColor: colors, borderWidth: 2 }] },
    options: {
      responsive: true, maintainAspectRatio: true,
      plugins: {
        legend: { position: 'right', labels: { font: { size: 10 }, boxWidth: 12, padding: 8 } },
        datalabels: {
          display: () => chartExportMode,
          color: '#fff', font: { size: 9, weight: 'bold' },
          formatter: (v, ctx) => {
            const total = ctx.dataset.data.reduce((a,b)=>a+b,0);
            const pct = total ? (v/total*100).toFixed(1) : 0;
            return total ? [v.toLocaleString(), `${pct}%`] : v.toLocaleString();
          }
        }
      }
    }
  });
  excelChartInstances.push(c);
}

function makeHBar(id, items) {
  const ctx = document.getElementById(id);
  if (!ctx) return;
  const c = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: items.map(x => x.label),
      datasets: [{ data: items.map(x => x.count), backgroundColor: CHART_PALETTE, borderRadius: 4 }]
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: true,
      plugins: {
        legend: { display: false },
        datalabels: {
          display: () => chartExportMode,
          anchor: 'end', align: 'right', offset: 4,
          color: '#1a2a3a', font: { size: 9, weight: 'bold' },
          formatter: v => v.toLocaleString()
        }
      },
      scales: {
        x: { beginAtZero: true, ticks: { font: { size: 10 } } },
        y: { ticks: { font: { size: 10 } } }
      }
    }
  });
  excelChartInstances.push(c);
}

function makePareto(id, items) {
  const ctx = document.getElementById(id);
  if (!ctx || !items?.length) return;
  ctx.parentElement.style.position = 'relative';
  ctx.parentElement.style.height   = '240px';
  const c = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: items.map(d => d.label.length > 18 ? d.label.substring(0,18)+'…' : d.label),
      datasets: [
        { label: 'Count', data: items.map(d => d.count), backgroundColor: '#4a9eff', borderRadius: 3, yAxisID: 'y',
          datalabels: { anchor: 'end', align: 'top', offset: 2, color: '#1a5276', font: { size: 8, weight: 'bold' }, formatter: v => v.toLocaleString() } },
        { label: 'Cumulative %', data: items.map(d => d.cumPct), type: 'line', borderColor: '#e53e3e',
          backgroundColor: 'transparent', borderWidth: 2, pointRadius: 3, yAxisID: 'y2', tension: 0.3,
          datalabels: { anchor: 'end', align: 'top', offset: 6, color: '#e53e3e', font: { size: 8, weight: 'bold' }, formatter: v => v.toFixed(0) + '%' } }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'top', labels: { font: { size: 10 } } },
        datalabels: { display: () => chartExportMode }
      },
      scales: {
        x: { ticks: { font: { size: 8 }, maxRotation: 40 } },
        y:  { beginAtZero: true, position: 'left',  ticks: { precision: 0, font: { size: 9 } }, title: { display: true, text: 'Count', font: { size: 9 } } },
        y2: { beginAtZero: true, position: 'right', max: 100, ticks: { font: { size: 9 }, callback: v => v + '%' }, grid: { drawOnChartArea: false }, title: { display: true, text: 'Cumulative %', font: { size: 9 } } }
      }
    }
  });
  excelChartInstances.push(c);
}

function makeGeoBar(id, items) {
  const ctx = document.getElementById(id);
  if (!ctx || !items?.length) return;
  const h = Math.min(360, Math.max(150, items.length * 22));
  ctx.parentElement.style.position = 'relative';
  ctx.parentElement.style.height   = h + 'px';
  const maxVal = Math.max(...items.map(d => d.count));
  const colors = items.map(d => {
    const ratio = d.count / maxVal;
    if (ratio < 0.2) return '#fc8181';
    if (ratio < 0.5) return '#f6ad55';
    return '#68d391';
  });
  const c = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: items.map(d => d.label),
      datasets: [{ label: 'Donors', data: items.map(d => d.count), backgroundColor: colors, borderRadius: 3 }]
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        datalabels: {
          display: () => chartExportMode,
          anchor: 'end', align: 'right', offset: 4,
          color: '#1a2a3a', font: { size: 9, weight: 'bold' },
          formatter: v => v.toLocaleString()
        }
      },
      scales: {
        x: { beginAtZero: true, ticks: { precision: 0, font: { size: 10 } } },
        y: { ticks: { font: { size: 10 }, padding: 4 } }
      }
    }
  });
  excelChartInstances.push(c);
}

function makeIATDoughnut(id, items) {
  const ctx = document.getElementById(id);
  if (!ctx) return;
  const colors = items.map(d => /pos|\+/i.test(d.label) ? '#e53e3e' : '#38a169');
  const c = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: items.map(d => d.label),
      datasets: [{ data: items.map(d => d.count), backgroundColor: colors, borderWidth: 2 }]
    },
    options: {
      responsive: true, maintainAspectRatio: true,
      plugins: {
        legend: { position: 'bottom', labels: { font: { size: 11 } } },
        tooltip: { callbacks: { label: c => ` ${c.label}: ${c.parsed.toLocaleString()} (${((c.parsed/c.dataset.data.reduce((a,b)=>a+b,0))*100).toFixed(1)}%)` } },
        datalabels: {
          display: () => chartExportMode,
          color: '#fff', font: { size: 9, weight: 'bold' },
          formatter: (v, ctx) => {
            const total = ctx.dataset.data.reduce((a,b)=>a+b,0);
            const pct = total ? (v/total*100).toFixed(1) : 0;
            return total ? [v.toLocaleString(), `${pct}%`] : v.toLocaleString();
          }
        }
      }
    }
  });
  excelChartInstances.push(c);
}

function makePeakBar(id, hourData) {
  const ctx = document.getElementById(id);
  if (!ctx) return;
  const maxVal = Math.max(...hourData.map(d => d.count));
  // Colour by shift: night=indigo, morning=amber, afternoon=blue, evening=purple
  const shiftColor = h => {
    if (h >= 0  && h < 6)  return '#6366f1'; // night
    if (h >= 6  && h < 12) return '#f59e0b'; // morning
    if (h >= 12 && h < 18) return '#3b82f6'; // afternoon
    return '#8b5cf6';                          // evening
  };
  const labels = hourData.map(d => d.label);
  const values = hourData.map(d => d.count);
  const colors = hourData.map(d => {
    const h = parseInt(d.label);
    return d.count === maxVal ? '#e53e3e' : shiftColor(h);
  });
  const c = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ data: values, backgroundColor: colors, borderRadius: 3 }] },
    options: {
      responsive: true, maintainAspectRatio: true,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: c => ` ${c.parsed.y.toLocaleString()} units` } },
        datalabels: {
          display: () => chartExportMode,
          anchor: 'end', align: 'top', offset: 2,
          color: '#1a2a3a', font: { size: 9, weight: 'bold' },
          formatter: v => v.toLocaleString()
        }
      },
      scales: {
        x: { ticks: { font: { size: 9 }, maxRotation: 45 } },
        y: { beginAtZero: true, ticks: { precision: 0, font: { size: 10 } } }
      }
    }
  });
  excelChartInstances.push(c);
}

function chartPanel(id, title, span2) {
  return `<div class="excel-chart-panel${span2?' span-2':''}">
    <div class="excel-chart-title">${title}</div>
    <canvas id="${id}"></canvas>
  </div>`;
}

// ── Type-specific card rendering ───────────────────────
const TYPE_LABELS = {
  transfusion:    'Units Issued for Transfusion',
  requests:       'Registered Patient Requests',
  donors:         'Registered Donors',
  wasted:         'Wasted / Withdrawn Units',
  sent_to_centres:'Units Sent to Other Centres',
  external_units: 'External Units from Other Centres',
  generic:        'Excel Data'
};

function card(label, value, accent, sub) {
  return `<div class="excel-card${accent?' '+accent:''}">
    <div class="excel-card-label">${label}</div>
    <div class="excel-card-num">${value}</div>
    ${sub ? `<div style="font-size:0.68rem;color:#a0aec0;margin-top:2px;">${sub}</div>` : ''}
  </div>`;
}

function topLabel(arr) { return arr && arr[0] ? arr[0].label : '—'; }

function renderTypeCards(type, s, total, filtered, dateCol, colCount) {
  destroyCharts();
  const container = document.getElementById('excelSummaryCards');
  const cfg = CAT_CONFIG[type] || CAT_CONFIG.generic;
  document.getElementById('excelTableTitle').textContent = cfg.label;

  let html = '';
  switch (type) {
    case 'transfusion':
      html = card('Total Issued', total.toLocaleString(), 'accent-red')
           + card('Returned', (s.returnedCount||0).toLocaleString())
           + card('Still In Use', (s.notReturnedCount||0).toLocaleString())
           + card('Unique Patients', (s.uniquePatients||0).toLocaleString());
      break;
    case 'requests': {
      const iatPct = s.iatTotal > 0 ? ((s.iatPositive / s.iatTotal) * 100).toFixed(1) + '%' : '—';
      html = card('Total Requests', total.toLocaleString(), 'accent-red')
           + card('IAT Positive', (s.iatPositive||0).toLocaleString(), s.iatPositive > 0 ? 'accent-red' : '')
           + card('IAT Positive %', iatPct)
           + card('Top Department', topLabel(s.byDepartment));
      break;
    }
    case 'donors':
      html = card('Total Donations', total.toLocaleString(), 'accent-red')
           + card('New Donors',       (s.newDonors||0).toLocaleString())
           + card('Returning Donors', (s.returningDonors||0).toLocaleString())
           + card('Top Blood Group',  topLabel(s.byGroup));
      break;
    case 'wasted': {
      const expPct = total > 0 ? ((s.expiryWaste||0)/total*100).toFixed(1)+'%' : '—';
      html = card('Total Wasted', total.toLocaleString(), 'accent-red')
           + card('Expiry-Related', (s.expiryWaste||0).toLocaleString(), s.expiryWaste > 0 ? 'accent-red' : '')
           + card('Expiry %', expPct)
           + card('Top Reason', topLabel(s.byReason));
      break;
    }
    case 'sent_to_centres':
      html = card('Total Sent', total.toLocaleString(), 'accent-red')
           + card('Returned', (s.returnedCount||0).toLocaleString())
           + card('Near-Expiry Sent', (s.nearExpiryCount||0).toLocaleString(), s.nearExpiryCount > 0 ? 'accent-red' : '', 'within 14 days of expiry')
           + card('Top Hospital', topLabel(s.byHospital));
      break;
    case 'external_units':
      html = card('Total Received', total.toLocaleString(), 'accent-red')
           + card('Filtered', filtered.toLocaleString())
           + card('Top Donation Type', topLabel(s.byDonationType))
           + card('Top Bag Type', topLabel(s.byBag));
      break;
    default:
      html = card('Total Rows', total.toLocaleString(), 'accent-red')
           + card('Filtered', filtered.toLocaleString())
           + card('Date Column', dateCol || 'N/A')
           + card('Columns', colCount);
  }
  container.innerHTML = html;
  container.style.display = '';
}

// ── Type-specific chart rendering ──────────────────────
function renderTypeCharts(type, s, monthly) {
  const grid = document.getElementById('excelChartGrid');
  destroyCharts();
  grid.className = 'excel-chart-grid';
  grid.innerHTML = '';

  const hasMon = monthly && monthly.length > 0;

  switch (type) {
    case 'transfusion':
      if (hasMon)                  grid.innerHTML += chartPanel('xc0', 'Monthly Units Issued');
      if (s.byGroup?.length)       grid.innerHTML += chartPanel('xc1', 'By Blood Group');
      if (s.byDestination?.length) grid.innerHTML += chartPanel('xc2', 'Top Destinations');
      if (s.byHour?.length)        grid.innerHTML += chartPanel('xc3', 'Peak Issue Hours');
      if (s.byComponent?.length)   grid.innerHTML += chartPanel('xc4', 'By Component');
      grid.className = 'excel-chart-grid' + (grid.children.length <= 1 ? ' cols-1' : grid.children.length === 3 ? ' cols-3' : '');
      break;
    case 'requests':
      if (hasMon)                  grid.innerHTML += chartPanel('xc0', 'Monthly Requests');
      if (s.byDepartment?.length)  grid.innerHTML += chartPanel('xc1', 'By Department');
      if (s.byGroup?.length)       grid.innerHTML += chartPanel('xc2', 'By Blood Group');
      if (s.byHour?.length)        grid.innerHTML += chartPanel('xc3', 'Peak Request Hours');
      if (s.byIAT?.length)         grid.innerHTML += chartPanel('xc4', 'IAT Distribution');
      grid.className = 'excel-chart-grid' + (grid.children.length === 3 ? ' cols-3' : '');
      break;
    case 'donors':
      if (hasMon)                       grid.innerHTML += chartPanel('xc0', 'Monthly Donations');
      if (s.byGroup?.length)            grid.innerHTML += chartPanel('xc1', 'By Blood Group');
      if (s.byGender?.length)           grid.innerHTML += chartPanel('xc2', 'By Gender');
      if (s.byAgeGroup?.length)         grid.innerHTML += chartPanel('xc3', 'By Age Group');
      if (s.byFrequentDonors?.length)   grid.innerHTML += chartPanel('xc4', 'Top Frequent Donors');
      if (s.byMohafaza?.length)         grid.innerHTML += chartPanel('xc5', 'By Mohafaza (Region)', true);
      if (s.byCity?.length)             grid.innerHTML += chartPanel('xc6', 'By City / Town', true);
      grid.className = 'excel-chart-grid cols-2';
      break;
    case 'wasted':
      if (hasMon)                        grid.innerHTML += chartPanel('xc0', 'Monthly Waste');
      if (s.byReasonPareto?.length)      grid.innerHTML += chartPanel('xc1', 'Waste Pareto — Top Reasons');
      if (s.byGroup?.length)             grid.innerHTML += chartPanel('xc2', 'By Blood Group');
      if (s.byWasteType?.length)         grid.innerHTML += chartPanel('xc3', 'Expiry vs Operational');
      if (s.expiryDaysHist?.length)      grid.innerHTML += chartPanel('xc4', 'Days Before Expiry When Wasted');
      grid.className = 'excel-chart-grid cols-2';
      break;
    case 'sent_to_centres':
      if (hasMon)                   grid.innerHTML += chartPanel('xc0', 'Monthly Units Sent');
      if (s.byComponent?.length)    grid.innerHTML += chartPanel('xc1', 'By Component');
      if (s.byHospital?.length)     grid.innerHTML += chartPanel('xc2', 'By Hospital', false);
      if (grid.children.length===3) grid.className = 'excel-chart-grid cols-3';
      break;
    case 'external_units':
      if (hasMon)                   grid.innerHTML += chartPanel('xc0', 'Monthly Units Received');
      if (s.byDonationType?.length) grid.innerHTML += chartPanel('xc1', 'By Donation Type');
      if (s.byBag?.length)          grid.innerHTML += chartPanel('xc2', 'By Bag Type');
      if (grid.children.length===3) grid.className = 'excel-chart-grid cols-3';
      break;
    default:
      if (hasMon) grid.innerHTML += chartPanel('xc0', 'Records per Month');
      if (s.byGroup?.length) grid.innerHTML += chartPanel('xc1', 'By Blood Group');
  }

  if (!grid.children.length) { grid.style.display = 'none'; return; }
  grid.style.display = '';

  // Render charts after DOM update
  requestAnimationFrame(() => {
    if (hasMon && document.getElementById('xc0'))
      makeBar('xc0', monthly.map(d=>d.label), monthly.map(d=>d.count));

    switch (type) {
      case 'transfusion':
        if (s.byGroup?.length)       makeBar('xc1', s.byGroup.map(d=>d.label), s.byGroup.map(d=>d.count));
        if (s.byDestination?.length) makeHBar('xc2', s.byDestination.slice(0,8));
        if (s.byHour?.length)        makePeakBar('xc3', s.byHour);
        if (s.byComponent?.length)   makeDoughnut('xc4', s.byComponent, false);
        break;
      case 'requests':
        if (s.byDepartment?.length) makeHBar('xc1', s.byDepartment.slice(0,8));
        if (s.byGroup?.length)      makeBar('xc2', s.byGroup.map(d=>d.label), s.byGroup.map(d=>d.count));
        if (s.byHour?.length)       makePeakBar('xc3', s.byHour);
        if (s.byIAT?.length)        makeIATDoughnut('xc4', s.byIAT);
        break;
      case 'donors':
        if (s.byGroup?.length)          makeBar('xc1', s.byGroup.map(d=>d.label), s.byGroup.map(d=>d.count));
        if (s.byGender?.length)         makeDoughnut('xc2', s.byGender, false);
        if (s.byAgeGroup?.length)       makeBar('xc3', s.byAgeGroup.map(d=>d.label), s.byAgeGroup.map(d=>d.count));
        if (s.byFrequentDonors?.length) makeHBar('xc4', s.byFrequentDonors);
        if (s.byMohafaza?.length)       makeGeoBar('xc5', s.byMohafaza);
        if (s.byCity?.length)           makeGeoBar('xc6', s.byCity);
        break;
      case 'wasted':
        if (s.byReasonPareto?.length)  makePareto('xc1', s.byReasonPareto);
        if (s.byGroup?.length)         makeBar('xc2', s.byGroup.map(d=>d.label), s.byGroup.map(d=>d.count));
        if (s.byWasteType?.length)     makeDoughnut('xc3', s.byWasteType, false);
        if (s.expiryDaysHist?.length)  makeBar('xc4', s.expiryDaysHist.map(d=>d.label), s.expiryDaysHist.map(d=>d.count), ['#fc8181','#f6ad55','#68d391','#4a9eff','#805ad5']);
        break;
      case 'sent_to_centres':
        if (s.byComponent?.length) makeDoughnut('xc1', s.byComponent, false);
        if (s.byHospital?.length)  makeHBar('xc2', s.byHospital.slice(0,8));
        break;
      case 'external_units':
        if (s.byDonationType?.length) makeDoughnut('xc1', s.byDonationType, false);
        if (s.byBag?.length)          makeDoughnut('xc2', s.byBag, false);
        break;
      default:
        if (s.byGroup?.length) makeDoughnut('xc1', s.byGroup, true);
    }
  });
}

function renderExcelTable(columns, rows, filteredTotal, page, pageSize, totalPages) {
  const thead = document.getElementById('excelTableHead');
  thead.innerHTML = `<tr>${columns.map(c => `<th>${c}</th>`).join('')}</tr>`;
  const tbody = document.getElementById('excelTableBody');
  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${columns.length}" style="text-align:center;padding:24px;color:var(--text-soft)">No data for the selected range.</td></tr>`;
  } else {
    tbody.innerHTML = rows.map(row =>
      `<tr>${columns.map(c => `<td>${row[c] ?? ''}</td>`).join('')}</tr>`
    ).join('');
  }
  const startRow = (page - 1) * pageSize + 1;
  const endRow   = Math.min(page * pageSize, filteredTotal);
  document.getElementById('excelTableInfo').textContent  = filteredTotal > 0
    ? `Rows ${startRow}–${endRow} of ${filteredTotal.toLocaleString()}`
    : '0 rows';
  const pag = document.getElementById('excelPagination');
  if (totalPages <= 1) { pag.innerHTML = ''; return; }
  pag.innerHTML = `
    <button class="excel-page-btn" onclick="excelGoPage(1)" ${page===1?'disabled':''}>«</button>
    <button class="excel-page-btn" onclick="excelGoPage(${page-1})" ${page<=1?'disabled':''}>‹</button>
    <span class="excel-page-info">Page ${page} of ${totalPages}</span>
    <button class="excel-page-btn" onclick="excelGoPage(${page+1})" ${page>=totalPages?'disabled':''}>›</button>
    <button class="excel-page-btn" onclick="excelGoPage(${totalPages})" ${page>=totalPages?'disabled':''}>»</button>
  `;
}
