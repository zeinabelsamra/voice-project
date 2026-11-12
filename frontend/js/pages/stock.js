// Blood Stock page — live stock from e-Delphyn (read-only).
// Backend: /api/stock/overview and /api/stock/movements (node-backend/edelphynStockQueries.js).
// Loaded as a classic script (shared global scope) — see index.html for load order.

let _stkOverview = null;
let _stkMoveChart = null;

const STK_STATUS_LABEL = { next: 'Issue next', near: 'Near expiry', expired: 'Expired', ok: 'In date' };
const STK_LEVEL_LABEL  = { critical: 'Critical', low: 'Low', ok: 'OK' };
const STK_UNIT_ROW_LIMIT = 300;

function stkEsc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function stkDate(ymd) {
  if (!ymd) return '—';
  const d = new Date(`${ymd}T00:00:00`);
  return isNaN(d) ? ymd : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function stkDaysText(days) {
  if (days == null) return '—';
  if (days < 0)  return `${-days} day${days === -1 ? '' : 's'} ago`;
  if (days === 0) return 'today';
  return `${days} day${days === 1 ? '' : 's'}`;
}

// Called by showPage('stock')
async function loadStock() {
  await Promise.all([loadStockOverview(), loadStockMovements()]);
}

async function stkFetchJson(url) {
  const r = await apiFetch(url);
  if (!r) return null; // apiFetch already handled auth redirect
  let data;
  try { data = await r.json(); } catch { data = { error: `Request failed (${r.status})` }; }
  if (!r.ok || data.error) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}

function stkShowError(message) {
  const el = document.getElementById('stkError');
  if (!message) { el.style.display = 'none'; el.innerHTML = ''; return; }
  el.style.display = '';
  el.innerHTML = `
    <div class="excel-no-files" style="border-color:var(--blood);background:var(--blood-50);margin-bottom:16px;">
      <div style="font-size:18px;margin-bottom:6px;">⚠️ Couldn't load stock from eDelphyn</div>
      <div style="font-size:13px;color:var(--text-soft);margin-bottom:12px;">${stkEsc(message)}</div>
      <button class="excel-filter-apply" onclick="loadStock()">🔄 Retry</button>
    </div>`;
}

// ════════════════════════════════════════════════════════════════
// Overview: alerts, cards, matrix, levels, oldest-first list
// ════════════════════════════════════════════════════════════════
async function loadStockOverview() {
  const nearDays = document.getElementById('stkNearDays').value || 7;
  let data;
  try {
    data = await stkFetchJson(`${API}/api/stock/overview?nearDays=${encodeURIComponent(nearDays)}`);
  } catch (e) {
    stkShowError(e.message);
    return;
  }
  if (!data) return;
  stkShowError(null);
  _stkOverview = data;

  const upd = document.getElementById('stkUpdated');
  if (upd) upd.textContent = `Live from eDelphyn · ${new Date(data.generatedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;

  renderStockLevelsNotice(data);
  renderStockAlerts(data.alerts || []);
  renderStockCards(data);
  renderStockMatrix(data);
  renderStockLevels(data);
  fillStockFilters(data);
  renderStockUnits();
}

function renderStockLevelsNotice(data) {
  const el = document.getElementById('stkLevelsNotice');
  if (data.levelsConfigured) { el.style.display = 'none'; return; }
  el.style.display = '';
  el.innerHTML = data.levelsTableExists
    ? '<strong>No stock levels are set in eDelphyn yet.</strong> Low-stock alerts are off until the blood bank enters alert and critical levels per blood group in eDelphyn\'s stock settings (STOCK table).'
    : '<strong>This eDelphyn database has no stock-level tables (STOCK / STOCK_COMPONENT).</strong> Stock counts and expiry alerts still work; low-stock alerts need those levels.';
}

function renderStockAlerts(alerts) {
  const el = document.getElementById('stkAlerts');
  if (!alerts.length) {
    el.innerHTML = '<div class="excel-no-alerts" style="margin-bottom:16px;">✅ No stock alerts — every group is above its alert level and nothing is about to expire.</div>';
    return;
  }
  const icon = { blood: '🩸', clock: '⏰', calendar: '📅' };
  el.innerHTML = `
    <div class="excel-alerts-wrap" style="margin-bottom:16px;">
      ${alerts.map(a => `
        <div class="excel-alert ${a.severity}">
          <div class="excel-alert-icon">${icon[a.icon] || '⚠️'}</div>
          <div class="excel-alert-body">
            <div class="excel-alert-title">${stkEsc(a.title)} <span class="excel-alert-badge">${stkEsc(a.severity)}</span></div>
            <div class="excel-alert-msg">${stkEsc(a.message)}</div>
          </div>
        </div>`).join('')}
    </div>`;
}

function renderStockCards(data) {
  const t = data.totals;
  const belowLevel = t.lowLevels + t.criticalLevels;
  const card = (cls, label, num, sub) => `
    <div class="consump-card ${cls}">
      <div class="consump-card-label">${label}</div>
      <div class="consump-card-num">${num}</div>
      <div class="consump-card-sub">${sub}</div>
    </div>`;
  document.getElementById('stkCards').innerHTML = [
    card('total', 'Units in Stock', t.available.toLocaleString(), 'in date, ready to issue'),
    card('plt', `Near Expiry (≤ ${data.nearDays} d)`, t.near.toLocaleString(), 'issue these first'),
    card('exp', 'Expired, Not Discarded', t.expiredNotDiscarded.toLocaleString(), 'discard in eDelphyn'),
    card(t.criticalLevels ? 'prc' : 'ffp', 'Groups Below Level',
      data.levelsConfigured ? belowLevel.toLocaleString() : '—',
      data.levelsConfigured ? `${t.criticalLevels} critical · ${t.lowLevels} low` : 'no levels set'),
  ].join('');
}

// Columns: the 8 standard groups, plus any odd values found in the data
// (e.g. a unit with no group recorded) so nothing silently disappears.
function stkGroupColumns(data) {
  const extra = new Set();
  for (const c of data.components) for (const g of Object.keys(c.groups)) if (!data.groups.includes(g)) extra.add(g);
  return [...data.groups, ...[...extra].sort()];
}

function renderStockMatrix(data) {
  const el = document.getElementById('stkMatrix');
  if (!data.components.length) { el.innerHTML = '<div class="rt-empty">No units in stock.</div>'; return; }
  const cols = stkGroupColumns(data);
  const totals = Object.fromEntries(cols.map(g => [g, { available: 0, near: 0, expired: 0 }]));

  const rows = data.components.map(c => {
    const cells = cols.map(g => {
      const v = c.groups[g];
      if (!v) return '<td class="stk-cell zero">0</td>';
      totals[g].available += v.available; totals[g].near += v.near; totals[g].expired += v.expired;
      const title = [`${v.available} in date`, v.near ? `${v.near} near expiry` : '', v.expired ? `${v.expired} expired` : '',
        v.oldestExpiry ? `oldest expires ${stkDate(v.oldestExpiry)}` : ''].filter(Boolean).join(' · ');
      return `<td class="stk-cell${v.available ? '' : ' zero'}" title="${stkEsc(title)}">
        ${v.available}
        ${v.near ? `<span class="stk-tag near">${v.near}</span>` : ''}
        ${v.expired ? `<span class="stk-tag expired">${v.expired}</span>` : ''}
      </td>`;
    }).join('');
    return `<tr>
      <td><strong>${stkEsc(c.component)}</strong>${c.componentType ? `<div class="stk-sub">${stkEsc(c.componentType)}</div>` : ''}</td>
      ${cells}
      <td class="stk-cell total">${c.available}${c.near ? `<span class="stk-tag near">${c.near}</span>` : ''}</td>
    </tr>`;
  }).join('');

  const grand = data.components.reduce((s, c) => s + c.available, 0);
  el.innerHTML = `
    <table class="consump-table stk-matrix">
      <thead><tr><th>Component</th>${cols.map(g => `<th class="stk-cell">${stkEsc(g)}</th>`).join('')}<th class="stk-cell">Total</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td><strong>All components</strong></td>
        ${cols.map(g => `<td class="stk-cell total">${totals[g].available}</td>`).join('')}
        <td class="stk-cell total">${grand}</td></tr></tfoot>
    </table>`;
}

function renderStockLevels(data) {
  const el = document.getElementById('stkLevels');
  if (!data.levels.length) {
    el.innerHTML = '<div class="rt-empty">No alert / critical levels set in eDelphyn.</div>';
    return;
  }
  el.innerHTML = data.levels.map(s => `
    <div class="stk-level-row">
      <div class="stk-level-name">
        <strong>${stkEsc(s.name)}</strong>
        <div class="stk-sub">${stkEsc(s.components.join(', '))}</div>
      </div>
      <div class="stk-chips">
        ${s.groups.map(g => `
          <div class="stk-chip ${g.status}" title="${stkEsc(`${g.group}: ${g.count} in stock · alert level ${g.alert ?? '—'} · critical level ${g.critical ?? '—'}`)}">
            <span class="stk-chip-group">${stkEsc(g.group)}</span>
            <span class="stk-chip-count">${g.count}</span>
            <span class="stk-chip-levels">alert ${g.alert ?? '—'} · crit ${g.critical ?? '—'}</span>
            <span class="stk-chip-status">${STK_LEVEL_LABEL[g.status] || ''}</span>
          </div>`).join('')}
      </div>
    </div>`).join('');
}

function fillStockFilters(data) {
  const compSel = document.getElementById('stkFilterComponent');
  const groupSel = document.getElementById('stkFilterGroup');
  const keepComp = compSel.value, keepGroup = groupSel.value;
  compSel.innerHTML = '<option value="">All components</option>' +
    data.components.map(c => `<option value="${c.componentId}">${stkEsc(c.component)}</option>`).join('');
  groupSel.innerHTML = '<option value="">All groups</option>' +
    stkGroupColumns(data).map(g => `<option value="${stkEsc(g)}">${stkEsc(g)}</option>`).join('');
  if ([...compSel.options].some(o => o.value === keepComp)) compSel.value = keepComp;
  if ([...groupSel.options].some(o => o.value === keepGroup)) groupSel.value = keepGroup;
}

function renderStockUnits() {
  const el = document.getElementById('stkUnits');
  const data = _stkOverview;
  if (!data) return;
  const comp = document.getElementById('stkFilterComponent').value;
  const group = document.getElementById('stkFilterGroup').value;
  const status = document.getElementById('stkFilterStatus').value;
  const q = document.getElementById('stkFilterUnit').value.trim().toLowerCase();
  const nextIds = new Set(data.nextToIssue.map(u => u.id));

  const rows = data.units.filter(u =>
    (!comp || String(u.componentId) === comp) &&
    (!group || u.group === group) &&
    (!status || (status === 'next' ? nextIds.has(u.id) : u.status === status)) &&
    (!q || String(u.unitNumber || '').toLowerCase().includes(q)));

  if (!rows.length) { el.innerHTML = '<div class="rt-empty">No units match these filters.</div>'; return; }

  // Position in the issuing queue of its own component + group.
  const position = new Map();
  const counter = {};
  for (const u of data.units) {
    if (u.status === 'expired') continue;
    const key = `${u.componentId}|${u.group}`;
    counter[key] = (counter[key] || 0) + 1;
    position.set(u.id, counter[key]);
  }

  const shown = rows.slice(0, STK_UNIT_ROW_LIMIT);
  el.innerHTML = `
    <table class="consump-table">
      <thead><tr><th>Queue</th><th>Unit number</th><th>Component</th><th>Group</th><th>Expiry date</th><th>Expires in</th><th>Status</th></tr></thead>
      <tbody>${shown.map(u => {
        const st = u.status === 'expired' ? 'expired' : nextIds.has(u.id) ? 'next' : u.status;
        return `<tr class="${st === 'next' ? 'stk-next-row' : ''}">
          <td>${u.status === 'expired' ? '—' : `#${position.get(u.id)}`}</td>
          <td><strong>${stkEsc(u.unitNumber || '—')}</strong>${u.division ? ` <span class="stk-sub">${stkEsc(u.division)}</span>` : ''}</td>
          <td>${stkEsc(u.component)}</td>
          <td><strong>${stkEsc(u.group)}</strong></td>
          <td>${stkDate(u.expiryDate)}</td>
          <td>${stkDaysText(u.daysToExpiry)}</td>
          <td><span class="stk-status ${st}">${STK_STATUS_LABEL[st]}</span>${st === 'next' && u.status === 'near' ? ' <span class="stk-status near">Near expiry</span>' : ''}</td>
        </tr>`;
      }).join('')}</tbody>
    </table>
    ${rows.length > shown.length ? `<div class="stk-more">Showing the ${shown.length} oldest of ${rows.length} units. Use the filters to narrow the list.</div>` : ''}
    ${data.truncated ? '<div class="stk-more">eDelphyn returned the maximum number of rows; newest units may be missing from this list (counts above are still complete up to that limit).</div>' : ''}
    ${data.totals.expiredNotDiscarded > data.units.filter(u => u.status === 'expired').length
      ? `<div class="stk-more">${data.totals.expiredNotDiscarded} expired units are still recorded as in stock; only those that expired in the last ${data.expiredListDays} days are listed.</div>` : ''}`;
}

// ════════════════════════════════════════════════════════════════
// Movements: received / issued / sent / returned / discarded
// ════════════════════════════════════════════════════════════════
function clearStockMovementFilter() {
  document.getElementById('stkFrom').value = '';
  document.getElementById('stkTo').value = '';
  loadStockMovements();
}

async function loadStockMovements() {
  const params = new URLSearchParams();
  const from = document.getElementById('stkFrom').value;
  const to = document.getElementById('stkTo').value;
  if (from) params.set('from', from);
  if (to) params.set('to', to);

  let data;
  try {
    data = await stkFetchJson(`${API}/api/stock/movements?${params}`);
  } catch (e) {
    document.getElementById('stkMoveCards').innerHTML = `<div class="rt-empty">Couldn't load movements: ${stkEsc(e.message)}</div>`;
    return;
  }
  if (!data) return;

  const t = data.totals;
  const card = (cls, label, num, sub) => `
    <div class="consump-card ${cls}">
      <div class="consump-card-label">${label}</div>
      <div class="consump-card-num">${num.toLocaleString()}</div>
      <div class="consump-card-sub">${sub}</div>
    </div>`;
  document.getElementById('stkMoveCards').innerHTML = [
    card('total', 'Received', t.received, 'donations + external units'),
    card('ffp', 'Issued to Patients', t.issued, 'transfusions'),
    card('', 'Sent to Other Centres', t.sent, 'deliveries'),
    card('plt', 'Returned', t.returned, 'back into stock'),
    card('prc', 'Discarded', t.discarded, 'wasted / destroyed'),
  ].join('');

  renderStockMoveChart(data.daily);
  document.getElementById('stkMoveComponents').innerHTML = stkMoveTable(data.byComponent, 'component', 'Component');
  document.getElementById('stkMoveGroups').innerHTML = stkMoveTable(data.byGroup, 'group', 'Group');
}

function stkMoveTable(rows, key, label) {
  if (!rows.length) return '<div class="rt-empty">No movements in this period.</div>';
  return `
    <table class="consump-table">
      <thead><tr><th>${label}</th><th>Received</th><th>Issued</th><th>Sent</th><th>Returned</th><th>Discarded</th></tr></thead>
      <tbody>${rows.map(r => `
        <tr><td><strong>${stkEsc(r[key])}</strong></td><td>${r.received}</td><td>${r.issued}</td><td>${r.sent}</td><td>${r.returned}</td><td>${r.discarded}</td></tr>`).join('')}
      </tbody>
    </table>`;
}

function renderStockMoveChart(daily) {
  if (_stkMoveChart) { _stkMoveChart.destroy(); _stkMoveChart = null; }
  const el = document.getElementById('stkMoveChart');
  if (!el) return;
  _stkMoveChart = new Chart(el, {
    type: 'bar',
    data: {
      labels: daily.map(d => d.date.slice(5)),
      datasets: [
        { label: 'Received',            data: daily.map(d => d.received),  backgroundColor: 'rgba(19,133,90,0.85)' },
        { label: 'Issued + sent',       data: daily.map(d => d.issued + d.sent), backgroundColor: 'rgba(31,95,173,0.85)' },
        { label: 'Discarded',           data: daily.map(d => d.discarded), backgroundColor: 'rgba(200,36,59,0.85)' },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { font: { size: 10 }, boxWidth: 12 } },
        datalabels: { display: false },
      },
      scales: {
        x: { ticks: { font: { size: 9 }, maxRotation: 45, autoSkip: true } },
        y: { beginAtZero: true, ticks: { precision: 0, font: { size: 10 } } },
      },
    },
  });
}
