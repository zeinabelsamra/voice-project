// Notification bell (persisted notifications)
// 
// Loaded as a classic script (shared global scope) — see index.html for load order.

// ═══════════════════════════════════════════════════════
// NOTIFICATIONS (admin) — persisted list of new transfusion requests, so an
// admin who wasn't online when one came in still sees it on next login.
// The live toast above (_showTransfusionRequestNotification) covers the
// "admin is online right now" case; this covers "admin opens the app later".
// ═══════════════════════════════════════════════════════
let _notifications     = [];
let _notifUnreadCount  = 0;

function timeAgo(dateStr) {
  const then = new Date(String(dateStr).replace(' ', 'T'));
  const diffSec = Math.max(0, Math.floor((Date.now() - then.getTime()) / 1000));
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return diffMin + 'm ago';
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return diffHr + 'h ago';
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return diffDay + 'd ago';
  return then.toLocaleDateString('en-GB');
}

async function loadNotifications() {
  if (!currentUser) return;
  try {
    const res  = await apiFetch(`${API}/notifications`);
    const data = res ? await res.json() : null;
    if (!data) return;
    _notifications    = data.notifications || [];
    _notifUnreadCount = data.unread_count || 0;
    renderNotifBadge();
    renderNotifPanel();
  } catch { /* offline — bell just keeps its last known state */ }
}

function renderNotifBadge() {
  const badge = document.getElementById('notifBadge');
  if (!badge) return;
  if (_notifUnreadCount > 0) {
    badge.textContent = _notifUnreadCount > 99 ? '99+' : _notifUnreadCount;
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }
}

function renderNotifPanel() {
  const list = document.getElementById('notifPanelList');
  if (!list) return;
  if (_notifications.length === 0) {
    list.innerHTML = '<div class="notif-empty">No notifications yet.</div>';
    return;
  }
  list.innerHTML = _notifications.map((n, idx) => {
    const bg      = n.blood_group ? n.blood_group + (n.rh_factor === 'Pos' ? '+' : n.rh_factor === 'Neg' ? '-' : '') : '';
    const summary = [n.file_number, bg, n.room ? 'Room ' + n.room : ''].filter(Boolean).join(' · ');
    const doc     = n.physician ? ' · Dr. ' + e(String(n.physician).replace(/^Dr\.?\s*/i, '')) : '';
    return `
      <div class="notif-item ${n.is_read ? '' : 'unread'}" data-idx="${idx}">
        <div class="notif-item-title">${n.is_read ? '' : '<span class="unread-dot"></span>'}${n.life_saving ? '🚨 ' : '🩸 '}${e(n.patient_name || 'Unknown patient')}</div>
        <div class="notif-item-sub">${e(summary)}${doc}</div>
        <div class="notif-item-time">${e(timeAgo(n.created_at))}</div>
      </div>`;
  }).join('');
  list.querySelectorAll('.notif-item').forEach(el => {
    el.addEventListener('click', () => openNotifItem(_notifications[+el.dataset.idx]));
  });
}

function openNotifItem(n) {
  toggleNotifPanel(false);
  markNotifRead(n.notification_id);
  showPage('forms');
  const searchInput = document.getElementById('searchInput');
  if (searchInput && n.file_number) {
    searchInput.value = n.file_number;
    onSearchInput();
  }
  document.getElementById('historyGrid')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function markNotifRead(id) {
  if (!id) return;
  const item = _notifications.find(n => n.notification_id === id);
  if (item && !item.is_read) {
    item.is_read = true;
    _notifUnreadCount = Math.max(0, _notifUnreadCount - 1);
    renderNotifBadge();
    renderNotifPanel();
  }
  try { await apiFetch(`${API}/notifications/${id}/read`, { method: 'POST' }); } catch {}
}

async function markAllNotifsRead() {
  if (_notifUnreadCount === 0) return;
  _notifications.forEach(n => { n.is_read = true; });
  _notifUnreadCount = 0;
  renderNotifBadge();
  renderNotifPanel();
  try { await apiFetch(`${API}/notifications/read-all`, { method: 'POST' }); } catch {}
}

function toggleNotifPanel(forceOpen) {
  const panel = document.getElementById('notifPanel');
  if (!panel) return;
  const willOpen = forceOpen !== undefined ? forceOpen : panel.style.display === 'none';
  panel.style.display = willOpen ? '' : 'none';
  if (willOpen) markAllNotifsRead();
}

// Close the panel on an outside click (bell button itself is inside the
// wrap, so this never fights with toggleNotifPanel's own open/close).
document.addEventListener('click', (evt) => {
  const wrap = document.getElementById('notifBellWrap');
  if (wrap && wrap.style.display !== 'none' && !wrap.contains(evt.target)) {
    const panel = document.getElementById('notifPanel');
    if (panel) panel.style.display = 'none';
  }
});
