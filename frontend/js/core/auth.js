// Core — HTML escaping, API helpers, authentication
// Must load first: defines e(), API, apiFetch, currentUser.
// Loaded as a classic script (shared global scope) — see index.html for load order.

// ── HTML escape — always use e() before inserting user data into innerHTML ──
function e(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ═══════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════
const API = 'http://localhost:3000';
let currentUser = null;

function getToken() { return localStorage.getItem('bb_token'); }

function authHeaders(extra = {}) {
  return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getToken(), ...extra };
}

async function apiFetch(url, opts = {}) {
  if (opts.body && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
  opts.headers = { ...authHeaders(), ...(opts.headers || {}) };
  const res = await fetch(url, opts);
  if (res.status === 401) { doLogout(); return null; }
  return res;
}

async function doLogin() {
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errEl    = document.getElementById('loginErr');
  errEl.textContent = '';
  if (!username || !password) { errEl.textContent = 'Please enter username and password.'; return; }
  try {
    const res  = await fetch(API + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error || 'Login failed.'; return; }
    localStorage.setItem('bb_token', data.token);
    currentUser = data.user;
    onLoginSuccess();
  } catch {
    errEl.textContent = 'Cannot connect to server. Is it running?';
  }
}

function doLogout() {
  localStorage.removeItem('bb_token');
  currentUser = null;
  // Reset chat state so next login picks up the correct department
  if (_chatSocket) { _chatSocket.disconnect(); _chatSocket = null; }
  _chatSidebarBuilt = false;
  _chatMyDept       = null;
  _chatActiveDept   = null;
  _chatUnread       = {};
  document.getElementById('loginScreen').classList.remove('hidden');
  document.getElementById('loginPassword').value = '';
  document.getElementById('loginErr').textContent = '';
  document.getElementById('userBar').style.display = 'none';
  document.getElementById('tabAdmin').style.display  = 'none';
  document.getElementById('tabExtDel').style.display = 'none';
  document.getElementById('tabDonor').style.display  = 'none';
  document.getElementById('notifBellWrap').style.display = 'none';
  document.getElementById('notifPanel').style.display    = 'none';
  _notifications = [];
  _notifUnreadCount = 0;
}

function onLoginSuccess() {
  document.getElementById('loginScreen').classList.add('hidden');
  // Header user bar
  document.getElementById('userBar').style.display  = '';
  document.getElementById('userBarName').textContent = currentUser.fullName;
  const roleEl = document.getElementById('userBarRole');
  roleEl.textContent = currentUser.role;
  roleEl.className   = 'user-bar-role ' + currentUser.role;
  // Show Admin + Ext Delivery tabs only for admins
  const isAdmin = currentUser.role === 'admin';
  // (Analytics + AI are admin-only in showPage too — hide them so staff don't see dead links)
  ['tabAdmin','tabSettings','tabExtDel','tabDonor','tabDashboard','tabExcel','tabHandover','tabConsumption','tabMonthly','tabAnalytics','tabStock','tabAI']
    .forEach(id => { const el = document.getElementById(id); if (el) el.style.display = isAdmin ? '' : 'none'; });
  // Default landing page per role
  showPage(isAdmin ? 'forms' : 'forms');
  // Delete buttons visibility
  document.querySelectorAll('.delete-btn').forEach(b => {
    b.style.display = currentUser.role === 'admin' ? '' : 'none';
  });
  loadHistory();
  checkMode();
  // Notification bell — admins see new transfusion requests saved while
  // they weren't logged in, staff (nurses) see new deliveries the blood
  // bank sent (see loadNotifications / GET /notifications, which scopes
  // by role server-side).
  document.getElementById('notifBellWrap').style.display = '';
  document.getElementById('notifPanelTitle').textContent = isAdmin ? 'Transfusion Requests' : 'Deliveries';
  loadNotifications();
  // Connect chat socket immediately so notifications work from any page
  _connectChatSocket();
  // Ask for browser notification permission
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

// Check session on page load
window.addEventListener('DOMContentLoaded', () => {
  const token = getToken();
  if (!token) return; // stays on login screen
  // Verify token still valid by fetching history (light call)
  fetch(API + '/history', { headers: { Authorization: 'Bearer ' + token } })
    .then(r => {
      if (r.status === 401) { localStorage.removeItem('bb_token'); return; }
      // Decode user from token (no library needed — just parse payload)
      try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        currentUser = { userId: payload.userId, username: payload.username, fullName: payload.fullName, role: payload.role };
        onLoginSuccess();
      } catch { localStorage.removeItem('bb_token'); }
    })
    .catch(() => { /* server offline — stay on login */ });
});
