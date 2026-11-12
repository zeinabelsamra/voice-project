// Consumption report
// 
// Loaded as a classic script (shared global scope) — see index.html for load order.

// ════════════════════════════════════════════════════════════════
// CONSUMPTION REPORT
// ════════════════════════════════════════════════════════════════
let _cTrendChart = null, _cGroupChart = null;
let _anTrendChart = null, _anDonationTypeChart = null, _anRetentionChart = null,
    _anFulfilmentChart = null, _anReturnChart = null, _anTurnaroundChart = null,
    _anAnomalyChart = null, _anExpiryComponentChart = null, _anExpiryGroupChart = null;

// Expiry-risk severity ramp — single hue, light (mild) → dark (severe), reused
// for the two bar charts, the calendar, and the detail-table badges so the
// same color always means the same tier everywhere on the page.
const EXPIRY_RISK_ORDER  = ['Expiring soon', 'High risk', 'Critical', 'Expired'];
const EXPIRY_RISK_COLORS = { 'Expiring soon': '#e28378', 'High risk': '#d75142', 'Critical': '#b13325', 'Expired': '#762219' };
const EXPIRY_RISK_TEXT   = { 'Expiring soon': '#1A2535',  'High risk': '#fff',    'Critical': '#fff',    'Expired': '#fff' };
let _anExpiryRows = [];
let _anExpirySort = { key: 'days', dir: 'asc' };

function clearConsumpFilter() {
  document.getElementById('cFrom').value = '';
  document.getElementById('cTo').value   = '';
  loadConsumption();
}

async function loadConsumption() {
  const from   = document.getElementById('cFrom').value;
  const to     = document.getElementById('cTo').value;
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to)   params.set('to',   to);

  const r = await apiFetch(`${API}/dashboard/consumption?${params}`);
  if (!r) return;
  const data = await r.json();
  if (data.error) return;

  const s = data.summary;
  document.getElementById('cTotalPrc').textContent   = (s.total_prc   ?? 0).toLocaleString();
  document.getElementById('cTotalFfp').textContent   = (s.total_ffp   ?? 0).toLocaleString();
  document.getElementById('cTotalPlt').textContent   = (s.total_plt   ?? 0).toLocaleString();
  document.getElementById('cTotalUnits').textContent = (s.total_units ?? 0).toLocaleString();

  // Trend chart — stacked bar
  const granLabel = { day: 'Daily', week: 'Weekly', month: 'Monthly' }[data.granularity] || 'Consumption';
  const titleEl = document.getElementById('cTrendTitle');
  if (titleEl) titleEl.textContent = granLabel + ' Consumption Trend';

  if (_cTrendChart) { _cTrendChart.destroy(); _cTrendChart = null; }
  const tEl = document.getElementById('cTrendChart');
  if (tEl) {
    if (data.trend.length) {
      _cTrendChart = new Chart(tEl, {
        type: 'bar',
        data: {
          labels: data.trend.map(d => d.date.length > 7 ? d.date.slice(5) : d.date),
          datasets: [
            { label: 'Packed Cells', data: data.trend.map(d => d.prc), backgroundColor: 'rgba(192,57,43,0.85)',  stack: 's' },
            { label: 'FFP',          data: data.trend.map(d => d.ffp), backgroundColor: 'rgba(26,82,118,0.85)',  stack: 's' },
            { label: 'Platelets',    data: data.trend.map(d => d.plt), backgroundColor: 'rgba(183,134,11,0.85)', stack: 's' },
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { position: 'bottom', labels: { font: { size: 10 }, boxWidth: 12 } } },
          scales: {
            x: { stacked: true, ticks: { font: { size: 9 }, maxRotation: 45 } },
            y: { stacked: true, beginAtZero: true, ticks: { precision: 0, font: { size: 10 } } }
          }
        }
      });
    } else {
      const ctx = tEl.getContext('2d');
      ctx.clearRect(0, 0, tEl.width, tEl.height);
      ctx.fillStyle = '#8896A7'; ctx.font = '13px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('No data for this period', tEl.width / 2, 90);
    }
  }

  // Blood group chart — horizontal stacked bar
  if (_cGroupChart) { _cGroupChart.destroy(); _cGroupChart = null; }
  const gEl = document.getElementById('cGroupChart');
  if (gEl) {
    if (data.byGroup.length) {
      _cGroupChart = new Chart(gEl, {
        type: 'bar',
        data: {
          labels: data.byGroup.map(d => d.label),
          datasets: [
            { label: 'Packed Cells', data: data.byGroup.map(d => d.prc), backgroundColor: 'rgba(192,57,43,0.85)',  stack: 's' },
            { label: 'FFP',          data: data.byGroup.map(d => d.ffp), backgroundColor: 'rgba(26,82,118,0.85)',  stack: 's' },
            { label: 'Platelets',    data: data.byGroup.map(d => d.plt), backgroundColor: 'rgba(183,134,11,0.85)', stack: 's' },
          ]
        },
        options: {
          indexAxis: 'y',
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { position: 'bottom', labels: { font: { size: 10 }, boxWidth: 12 } } },
          scales: {
            x: { stacked: true, beginAtZero: true, ticks: { precision: 0, font: { size: 10 } } },
            y: { stacked: true, ticks: { font: { size: 11 } } }
          }
        }
      });
    } else {
      const ctx = gEl.getContext('2d');
      ctx.clearRect(0, 0, gEl.width, gEl.height);
      ctx.fillStyle = '#8896A7'; ctx.font = '13px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('No data for this period', gEl.width / 2, 90);
    }
  }

  // Ward table
  const maxWard = Math.max(1, ...data.byRoom.map(r => r.total));
  document.getElementById('cWardTable').innerHTML = data.byRoom.length ? `
    <table class="consump-table">
      <thead><tr><th>Ward / Room</th><th>PRC</th><th>FFP</th><th>PLT</th><th>Total</th><th style="min-width:120px"></th></tr></thead>
      <tbody>${data.byRoom.map(r => `
        <tr>
          <td><strong>${r.room}</strong></td>
          <td>${r.prc}</td>
          <td>${r.ffp}</td>
          <td>${r.plt}</td>
          <td><strong>${r.total}</strong></td>
          <td><div class="consump-bar-wrap"><div class="consump-bar-bg"><div class="consump-bar-fill" style="width:${Math.round((r.total/maxWard)*100)}%"></div></div></div></td>
        </tr>`).join('')}
      </tbody>
    </table>` : '<div class="rt-empty">No ward data for this period.</div>';

  // Blood group detail table
  document.getElementById('cGroupTable').innerHTML = data.byGroup.length ? `
    <table class="consump-table">
      <thead><tr><th>Blood Type</th><th>Packed Cells</th><th>FFP</th><th>Platelets</th><th>Total Units</th></tr></thead>
      <tbody>${data.byGroup.map(g => `
        <tr>
          <td><strong>${g.label}</strong></td>
          <td>${g.prc}</td>
          <td>${g.ffp}</td>
          <td>${g.plt}</td>
          <td><strong>${g.total}</strong></td>
        </tr>`).join('')}
      </tbody>
    </table>` : '<div class="rt-empty">No blood type data for this period.</div>';
}
