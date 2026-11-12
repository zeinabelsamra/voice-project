// App shell — sidebar drawer / icon rail, page heading, nav-group visibility.
// showPage() (core/navigation.js) calls onPageShown(page) after switching.
// Loaded as a classic script (shared global scope) — see index.html for load order.

const PAGE_META = {
  forms:       ['Workspace',      'Request & Delivery Forms'],
  extdel:      ['Workspace',      'External Delivery'],
  donor:       ['Workspace',      'Donor Card'],
  dashboard:   ['Insights',       'Dashboard'],
  excel:       ['Insights',       'Live Dashboard'],
  analytics:   ['Insights',       'Advanced Analytics'],
  stock:       ['Insights',       'Blood Stock'],
  consumption: ['Insights',       'Consumption Report'],
  handover:    ['Insights',       'Shift Handover'],
  monthly:     ['Insights',       'Monthly Report'],
  chat:        ['Communication',  'Department Chat'],
  ai:          ['Communication',  'AI Assistant'],
  admin:       ['Administration', 'User Management'],
  settings:    ['Administration', 'Settings'],
};

function onPageShown(page) {
  const [group, title] = PAGE_META[page] || ['', ''];
  document.body.dataset.page = page;
  const eyebrow = document.getElementById('pageEyebrow');
  const heading = document.getElementById('pageTitle');
  if (eyebrow) eyebrow.textContent = group;
  if (heading) heading.textContent = title;
  document.title = title ? `${title} · Al Rassoul Blood Bank` : 'Al Rassoul Blood Bank — SBB';
  closeNavDrawer();
  window.scrollTo({ top: 0 });
}

// ── Drawer (tablet / phone) and rail (desktop) ──
function toggleNavDrawer() {
  document.body.classList.toggle('nav-open');
}
function closeNavDrawer() {
  document.body.classList.remove('nav-open');
}
function toggleSidebarRail() {
  const on = document.body.classList.toggle('nav-rail');
  try { localStorage.setItem('bb_nav_rail', on ? '1' : '0'); } catch { /* storage blocked — preference just isn't remembered */ }
}
try { if (localStorage.getItem('bb_nav_rail') === '1') document.body.classList.add('nav-rail'); } catch { /* ignore */ }

document.addEventListener('keydown', ev => { if (ev.key === 'Escape') closeNavDrawer(); });
window.matchMedia('(min-width: 1280px)').addEventListener('change', mq => { if (mq.matches) closeNavDrawer(); });

// ── Hide a nav group when every button in it is hidden (e.g. Administration for staff) ──
function refreshNavGroups() {
  document.querySelectorAll('#sidebarNav .nav-group').forEach(group => {
    const anyVisible = [...group.querySelectorAll('.sidebar-nav-btn')].some(b => b.style.display !== 'none');
    group.style.display = anyVisible ? '' : 'none';
  });
}
document.addEventListener('DOMContentLoaded', () => {
  refreshNavGroups();
  const nav = document.getElementById('sidebarNav');
  if (nav) new MutationObserver(refreshNavGroups).observe(nav, { subtree: true, attributes: true, attributeFilter: ['style'] });
  document.body.dataset.page = 'forms';
});
