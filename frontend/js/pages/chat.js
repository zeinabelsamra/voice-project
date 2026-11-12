// Department chat — socket, threads, live notifications, voice notes
// 
// Loaded as a classic script (shared global scope) — see index.html for load order.

// ═══════════════════════════════════════════════════════
// CHAT
// ═══════════════════════════════════════════════════════
// Populated from GET /api/departments in initChat() — was a hardcoded list
// duplicating the Add/Edit User modal's; both now read from the same
// admin-managed Departments table (see Settings → Departments).
let CHAT_DEPTS = [];

let _chatSocket       = null;
let _chatActiveDept   = null;
let _chatMyDept       = null;
let _chatUnread       = {};
let _chatSidebarBuilt = false;

function _parseDeptFromToken() {
  try {
    const tok = getToken();
    if (!tok) return null;
    const payload = JSON.parse(atob(tok.split('.')[1]));
    return payload.department || 'BLOOD BANK';
  } catch { return 'BLOOD BANK'; }
}

// Called right after login — connects socket so notifications work from ANY page
function _connectChatSocket() {
  if (_chatSocket) return;
  _chatMyDept = _parseDeptFromToken();
  console.log('[Chat] Connecting socket as dept:', _chatMyDept);
  _chatSocket = io({ auth: { token: getToken() }, transports: ['websocket'] });
  _chatSocket.on('connect', () => console.log('[Chat] Socket connected ✓'));
  _chatSocket.on('connect_error', (err) => console.error('[Chat] Socket error:', err.message));

  // Online presence
  _chatSocket.on('dept_status', ({ dept, online }) => {
    if (online) _onlineDepts.add(dept); else _onlineDepts.delete(dept);
    _updateOnlineDot(dept, online);
  });

  // Typing indicator
  _chatSocket.on('typing', ({ from_dept, typing }) => {
    if (_chatActiveDept !== from_dept) return;
    const bar = document.getElementById('chatTypingBar');
    if (bar) bar.textContent = typing ? `${from_dept} is typing…` : '';
  });

  // Read receipts — other dept read our messages
  _chatSocket.on('messages_read', ({ by_dept }) => {
    if (_chatActiveDept !== by_dept) return;
    document.querySelectorAll('.chat-receipt.sent').forEach(el => {
      el.classList.replace('sent', 'read');
      el.textContent = '✓✓';
    });
  });

  // New message
  _chatSocket.on('new_message', msg => {
    const other = msg.own ? msg.to_dept : msg.from_dept;
    if (msg.own) {
      if (_chatActiveDept === other) {
        _appendChatBubble(msg);
        _scrollChatToBottom();
      }
    } else {
      if (_chatActiveDept === other) {
        _appendChatBubble(msg);
        _scrollChatToBottom();
        // Auto-mark as read since thread is open
        _chatSocket.emit('mark_read', { from_dept: other });
      } else {
        _chatUnread[other] = (_chatUnread[other] || 0) + 1;
        _updateUnreadBadge(other);
        const preview = msg.message || (msg.file_name?.startsWith('voice-note') ? '🎤 Voice note' : msg.file_name ? `📎 ${msg.file_name}` : '');
        _showChatNotification(msg.from_dept, msg.from_name, preview, msg.urgent);
      }
    }
  });

  // New transfusion request — server only emits this to sockets in the
  // 'admins' room (see io.on('connection') in server.js), so any logged-in
  // admin gets it from whatever page they're on, same as chat.
  _chatSocket.on('new_transfusion_request', data => {
    _showTransfusionRequestNotification(data);
    // Also fold it into the persisted bell list so it shows up there too
    // without needing a manual refresh.
    if (data.notification_id) {
      _notifications.unshift({
        notification_id: data.notification_id,
        request_id:      data.id,
        patient_name:    data.patient_name,
        file_number:     data.file_number,
        blood_group:     data.blood_group,
        rh_factor:       data.rh_factor,
        room:            data.room,
        physician:       data.physician,
        life_saving:     data.life_saving,
        saved_by:        data.saved_by,
        created_at:      data.created_at,
        is_read:         false,
      });
      _notifUnreadCount++;
      renderNotifBadge();
      renderNotifPanel();
    }
  });

  // New delivery sent — server only emits this to sockets in the 'staff'
  // room (see io.on('connection') in server.js), so any logged-in nurse
  // gets it from whatever page they're on.
  _chatSocket.on('new_delivery', data => {
    _showDeliveryNotification(data);
    if (data.notification_id) {
      _notifications.unshift({
        notification_id: data.notification_id,
        request_id:      data.id,
        patient_name:    data.patient_name,
        file_number:     data.file_number,
        blood_group:     data.blood_group,
        rh_factor:       data.rh_factor,
        room:            data.room,
        life_saving:     data.life_saving,
        saved_by:        data.saved_by,
        created_at:      data.created_at,
        is_read:         false,
      });
      _notifUnreadCount++;
      renderNotifBadge();
      renderNotifPanel();
    }
  });
}

// Called when user navigates to Chat page — builds sidebar UI

async function initChat() {
  if (!_chatMyDept) _chatMyDept = _parseDeptFromToken();
  if (!_chatSocket) _connectChatSocket();

  // Re-fetch and rebuild the department list every time Chat is opened —
  // not just once per session — so a department added/renamed in Settings
  // shows up here without needing a full page reload. Unread counts and
  // online status live in _chatUnread/_onlineDepts (not the DOM), so
  // they're just re-applied to the fresh HTML rather than lost.
  try {
    const res = await apiFetch(`${API}/api/departments`);
    const depts = res ? await res.json() : [];
    if (Array.isArray(depts) && depts.length) CHAT_DEPTS = depts.map(d => d.name);
  } catch { /* keep whatever CHAT_DEPTS already had, if anything */ }
  if (!CHAT_DEPTS.length) CHAT_DEPTS = ['BLOOD BANK'];

  const isBloodBank  = _chatMyDept === 'BLOOD BANK';
  const visibleDepts = isBloodBank
    ? CHAT_DEPTS.filter(d => d !== 'BLOOD BANK')
    : ['BLOOD BANK'];

  const list = document.getElementById('chatDeptList');
  list.innerHTML = visibleDepts.map(d => `
    <div class="chat-dept-item" id="chatDept_${CSS.escape(d)}" onclick="openChatThread('${e(d)}')">
      <span class="chat-dept-name">${e(d)}</span>
      <div style="display:flex;align-items:center;gap:6px">
        <span class="chat-dept-badge" id="chatBadge_${CSS.escape(d)}" style="display:none">0</span>
        <span class="chat-offline-dot" id="chatDot_${CSS.escape(d)}"></span>
      </div>
    </div>`).join('');
  visibleDepts.forEach(d => { _updateUnreadBadge(d); _updateOnlineDot(d, _onlineDepts.has(d)); });

  if (_chatSidebarBuilt) return;
  _chatSidebarBuilt = true;

  // Snapshot of who's online right now — first visit only, socket events
  // (_updateOnlineDot via the presence channel) keep it live after this.
  try {
    const res = await apiFetch(`${API}/chat/online`);
    if (res) {
      const online = await res.json();
      online.forEach(d => { _onlineDepts.add(d); _updateOnlineDot(d, true); });
    }
  } catch {}
}

function _updateOnlineDot(dept, online) {
  const dot = document.getElementById('chatDot_' + CSS.escape(dept));
  if (!dot) return;
  dot.className = online ? 'chat-online-dot' : 'chat-offline-dot';
  dot.title = online ? `${dept} is online` : `${dept} is offline`;
}

// Browser push notification (works even when user is on another page/tab)
function _showBrowserNotif(fromDept, message) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const n = new Notification(`New message from ${fromDept}`, {
    body: message.length > 100 ? message.slice(0, 100) + '…' : message,
    icon: '/logo.png',
    tag:  'chat-' + fromDept,   // replaces previous notif from same dept
  });
  n.onclick = () => {
    window.focus();
    showPage('chat');
    setTimeout(() => openChatThread(fromDept), 80);
    n.close();
  };
  setTimeout(() => n.close(), 8000);
}

// ── Notification: banner + sound ─────────────────────────────────
function _showChatNotification(fromDept, fromName, message, urgent) {
  // Remove any existing notification from same dept
  const existingId = 'chatnotif_' + fromDept.replace(/\W/g,'_');
  const existing = document.getElementById(existingId);
  if (existing) existing.remove();

  const preview = message.length > 80 ? message.slice(0, 80) + '…' : message;
  const banner = document.createElement('div');
  banner.id = existingId;
  const accentColor = urgent ? '#e74c3c' : '#f39c12';
  banner.style.cssText = [
    'position:fixed','top:62px','left:50%','transform:translateX(-50%)',
    `background:${urgent ? '#7b1010' : '#0D1B2A'}`, 'color:#fff',
    'padding:14px 22px 14px 18px',
    'border-radius:10px','z-index:999999',
    'box-shadow:0 6px 28px rgba(0,0,0,.45)',
    'cursor:pointer','text-align:center',
    `border-left:5px solid ${accentColor}`,
    'min-width:320px','max-width:480px',
    'font-family:inherit','line-height:1.4',
    'animation:chatNotifIn .25s ease'
  ].join(';');
  banner.innerHTML = `
    <div style="font-size:13px;font-weight:800;margin-bottom:4px">
      ${urgent ? '🚨 URGENT — ' : '💬 '}New message from <span style="color:${accentColor}">${e(fromDept)}</span>
    </div>
    <div style="font-size:12px;opacity:.85">${e(preview)}</div>
    <div style="font-size:10px;opacity:.5;margin-top:6px">Click to open chat</div>`;
  banner.onclick = () => {
    banner.remove();
    showPage('chat');
    setTimeout(() => openChatThread(fromDept), 80);
  };
  document.body.appendChild(banner);

  // Play notification sound (urgent = triple beep, normal = double beep)
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const freqs = urgent ? [880, 880, 1100] : [880, 1100];
    freqs.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = freq;
      osc.type = 'sine';
      const t = ctx.currentTime + i * 0.18;
      gain.gain.setValueAtTime(urgent ? 0.4 : 0.25, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
      osc.start(t); osc.stop(t + 0.18);
    });
  } catch {}

  // Browser notification (when tab is in background)
  _showBrowserNotif(fromDept, message);

  // Auto-dismiss after 8 seconds
  setTimeout(() => { if (banner.parentNode) banner.remove(); }, 8000);
}

// ── Notification: new transfusion request (admins only — see server.js) ──
function _showTransfusionRequestNotification(data) {
  const existingId = 'txnotif_' + data.id;
  const existing = document.getElementById(existingId);
  if (existing) existing.remove();

  const urgent = !!data.life_saving;
  const bg      = data.blood_group ? data.blood_group + (data.rh_factor === 'Pos' ? '+' : data.rh_factor === 'Neg' ? '-' : '') : '';
  const summary = [data.file_number, bg, data.room ? 'Room ' + data.room : ''].filter(Boolean).join(' · ');
  const accentColor = urgent ? '#e74c3c' : '#f39c12';

  const banner = document.createElement('div');
  banner.id = existingId;
  banner.style.cssText = [
    'position:fixed','top:62px','left:50%','transform:translateX(-50%)',
    `background:${urgent ? '#7b1010' : '#0D1B2A'}`, 'color:#fff',
    'padding:14px 22px 14px 18px',
    'border-radius:10px','z-index:999999',
    'box-shadow:0 6px 28px rgba(0,0,0,.45)',
    'cursor:pointer','text-align:center',
    `border-left:5px solid ${accentColor}`,
    'min-width:320px','max-width:480px',
    'font-family:inherit','line-height:1.4',
    'animation:chatNotifIn .25s ease'
  ].join(';');
  banner.innerHTML = `
    <div style="font-size:13px;font-weight:800;margin-bottom:4px">
      ${urgent ? '🚨 LIFE SAVING — ' : '🩸 '}New Transfusion Request — <span style="color:${accentColor}">${e(data.patient_name)}</span>
    </div>
    <div style="font-size:12px;opacity:.85">${e(summary)}${data.physician ? ' · Dr. ' + e(data.physician.replace(/^Dr\.?\s*/i, '')) : ''}</div>
    <div style="font-size:10px;opacity:.5;margin-top:6px">Saved by ${e(data.saved_by)} · Click to open</div>`;
  banner.onclick = () => {
    banner.remove();
    showPage('forms');
    const searchInput = document.getElementById('searchInput');
    if (searchInput && data.file_number) {
      searchInput.value = data.file_number;
      onSearchInput();
    }
    document.getElementById('historyGrid')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  document.body.appendChild(banner);

  // Notification sound — same beep pattern as chat, pitched to feel distinct
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const freqs = urgent ? [660, 880, 660, 880] : [660, 880];
    freqs.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = freq;
      osc.type = 'sine';
      const t = ctx.currentTime + i * 0.18;
      gain.gain.setValueAtTime(urgent ? 0.4 : 0.25, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
      osc.start(t); osc.stop(t + 0.18);
    });
  } catch {}

  // Browser notification (works even when the tab is in the background)
  if ('Notification' in window && Notification.permission === 'granted') {
    const n = new Notification((urgent ? '🚨 Life saving — ' : '🩸 ') + 'New Transfusion Request', {
      body: `${data.patient_name}${summary ? ' — ' + summary : ''}`,
      icon: '/logo.png',
      tag: existingId,
    });
    n.onclick = () => { window.focus(); banner.click(); n.close(); };
    setTimeout(() => n.close(), 8000);
  }

  setTimeout(() => { if (banner.parentNode) banner.remove(); }, 8000);
}

// ── Notification: new delivery sent (staff/nurses only — see server.js) ──
function _showDeliveryNotification(data) {
  const existingId = 'delnotif_' + data.id;
  const existing = document.getElementById(existingId);
  if (existing) existing.remove();

  const urgent = !!data.life_saving;
  const bg      = data.blood_group ? data.blood_group + (data.rh_factor === 'Pos' ? '+' : data.rh_factor === 'Neg' ? '-' : '') : '';
  const summary = [data.file_number, bg, data.room ? 'Room ' + data.room : ''].filter(Boolean).join(' · ');
  const accentColor = urgent ? '#e74c3c' : '#1a7f4b';

  const banner = document.createElement('div');
  banner.id = existingId;
  banner.style.cssText = [
    'position:fixed','top:62px','left:50%','transform:translateX(-50%)',
    `background:${urgent ? '#7b1010' : '#0D1B2A'}`, 'color:#fff',
    'padding:14px 22px 14px 18px',
    'border-radius:10px','z-index:999999',
    'box-shadow:0 6px 28px rgba(0,0,0,.45)',
    'cursor:pointer','text-align:center',
    `border-left:5px solid ${accentColor}`,
    'min-width:320px','max-width:480px',
    'font-family:inherit','line-height:1.4',
    'animation:chatNotifIn .25s ease'
  ].join(';');
  banner.innerHTML = `
    <div style="font-size:13px;font-weight:800;margin-bottom:4px">
      ${urgent ? '🚨 LIFE SAVING — ' : '🚚 '}Delivery Sent — <span style="color:${accentColor}">${e(data.patient_name)}</span>
    </div>
    <div style="font-size:12px;opacity:.85">${e(summary)}</div>
    <div style="font-size:10px;opacity:.5;margin-top:6px">Sent by ${e(data.saved_by)} · Click to open</div>`;
  banner.onclick = () => {
    banner.remove();
    showPage('forms');
    const searchInput = document.getElementById('searchInput');
    if (searchInput && data.file_number) {
      searchInput.value = data.file_number;
      onSearchInput();
    }
    document.getElementById('historyGrid')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  document.body.appendChild(banner);

  // Notification sound — same beep pattern as chat, pitched to feel distinct
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const freqs = urgent ? [660, 880, 660, 880] : [660, 880];
    freqs.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = freq;
      osc.type = 'sine';
      const t = ctx.currentTime + i * 0.18;
      gain.gain.setValueAtTime(urgent ? 0.4 : 0.25, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
      osc.start(t); osc.stop(t + 0.18);
    });
  } catch {}

  // Browser notification (works even when the tab is in the background)
  if ('Notification' in window && Notification.permission === 'granted') {
    const n = new Notification((urgent ? '🚨 Life saving — ' : '🚚 ') + 'Delivery Sent', {
      body: `${data.patient_name}${summary ? ' — ' + summary : ''}`,
      icon: '/logo.png',
      tag: existingId,
    });
    n.onclick = () => { window.focus(); banner.click(); n.close(); };
    setTimeout(() => n.close(), 8000);
  }

  setTimeout(() => { if (banner.parentNode) banner.remove(); }, 8000);
}


function openChatThread(dept) {
  _chatActiveDept = dept;
  _chatUnread[dept] = 0;
  _updateUnreadBadge(dept);

  document.querySelectorAll('.chat-dept-item').forEach(el => el.classList.remove('active'));
  const item = document.getElementById('chatDept_' + CSS.escape(dept));
  if (item) item.classList.add('active');

  const isOnline = _onlineDepts.has(dept);
  const quickSet = (_chatMyDept === 'BLOOD BANK' ? QUICK_REPLIES['BLOOD BANK'] : QUICK_REPLIES['OTHER']);

  const main = document.getElementById('chatMain');
  main.innerHTML = `
    <div class="chat-main-head">
      <div style="display:flex;align-items:center;gap:10px">
        <span class="${isOnline ? 'chat-online-dot' : 'chat-offline-dot'}" id="chatHeadDot"></span>
        <div>
          <div class="chat-main-title">${e(dept)}</div>
          <div class="chat-main-sub" id="chatHeadSub">${isOnline ? 'Online' : 'Offline'} · Chatting as <strong>${e(_chatMyDept)}</strong></div>
        </div>
      </div>
      <span class="chat-my-dept">${e(_chatMyDept)}</span>
    </div>
    <div class="chat-messages" id="chatMessages">
      <div style="text-align:center;padding:20px;color:#aaa;font-size:13px">Loading…</div>
    </div>
    <div class="chat-typing-bar" id="chatTypingBar"></div>
    <div class="chat-quick-wrap">
      ${quickSet.map(q => `<button class="chat-quick-btn" onclick="sendQuickReply('${e(q)}')">${e(q)}</button>`).join('')}
    </div>
    <div class="chat-file-strip" id="chatFileStrip">
      <span>📎</span>
      <span class="chat-file-strip-name"></span>
      <span class="chat-file-strip-remove" onclick="removePendingFile()">✕</span>
    </div>
    <div class="chat-input-bar">
      <button class="chat-attach-btn" onclick="attachFile()" title="Attach file">📎</button>
      <button class="chat-mic-btn" id="chatMicBtn" onclick="toggleVoiceNote()" title="Voice note">🎤</button>
      <span class="chat-rec-timer" id="chatRecTimer">0:00</span>
      <button class="chat-urgent-btn" id="chatUrgentBtn" onclick="toggleUrgent()" title="Mark as urgent">🚨</button>
      <textarea class="chat-input" id="chatInput" placeholder="Type a message… (Enter to send)"
        oninput="_onChatInput()"
        onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendChatMessage();}"></textarea>
      <button class="chat-send-btn" onclick="sendChatMessage()">Send</button>
    </div>`;

  _loadChatHistory(dept);
  // Mark received messages as read
  if (_chatSocket) _chatSocket.emit('mark_read', { from_dept: dept });
}

async function _loadChatHistory(toDept) {
  try {
    const res = await apiFetch(
      `${API}/chat/history?from=${encodeURIComponent(_chatMyDept)}&to=${encodeURIComponent(toDept)}`
    );
    if (!res) return;
    const msgs = await res.json();
    const box = document.getElementById('chatMessages');
    if (!box) return;
    box.innerHTML = '';
    if (!msgs.length) {
      box.innerHTML = '<div style="text-align:center;padding:30px;color:#aaa;font-size:13px">No messages yet. Say hello! 👋</div>';
      return;
    }
    msgs.forEach(m => _appendChatBubble(m));
    _scrollChatToBottom();
  } catch { }
}

function _appendChatBubble(msg) {
  const box = document.getElementById('chatMessages');
  if (!box) return;
  const mine = msg.from_dept === _chatMyDept || msg.own === true;
  const time = msg.created_at
    ? new Date(msg.created_at).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })
    : '';
  const isRead = !!msg.read_at || _readMsgIds.has(msg.message_id);

  let fileHtml = '';
  if (msg.file_url) {
    const fname   = msg.file_name || '';
    const isImage = /\.(jpg|jpeg|png|gif)$/i.test(fname);
    const isAudio = /\.(webm|ogg|mp4|wav|mp3)$/i.test(fname) ||
                    fname.startsWith('voice-note');
    if (isAudio) {
      fileHtml = `
        <div class="chat-voice-bubble">
          <span class="chat-voice-icon">🎤</span>
          <audio controls src="${e(msg.file_url)}" preload="none"
            style="flex:1;height:32px;min-width:0;max-width:200px"></audio>
        </div>`;
    } else if (isImage) {
      fileHtml = `<br><img src="${e(msg.file_url)}" alt="${e(msg.file_name)}"
        style="max-width:200px;max-height:160px;border-radius:8px;margin-top:6px;cursor:pointer"
        onclick="window.open('${e(msg.file_url)}','_blank')">`;
    } else {
      fileHtml = `<a class="chat-attachment" href="${e(msg.file_url)}" target="_blank" download="${e(msg.file_name)}">
        <span class="chat-attach-icon">📄</span>
        <span class="chat-attach-label">${e(msg.file_name)}</span>
      </a>`;
    }
  }

  const receiptHtml = mine
    ? `<span class="chat-receipt ${isRead ? 'read' : 'sent'}" data-id="${msg.message_id}">${isRead ? '✓✓' : '✓'}</span>`
    : '';

  const div = document.createElement('div');
  div.className = 'chat-msg ' + (mine ? 'mine' : 'theirs') + (msg.urgent ? ' urgent' : '');
  div.dataset.msgId = msg.message_id;
  div.innerHTML = `
    ${msg.urgent ? `<div class="chat-urgent-tag">🚨 URGENT</div>` : ''}
    <div class="chat-bubble">${msg.message ? e(msg.message) : ''}${fileHtml}</div>
    <div class="chat-meta">
      ${mine ? e(_chatMyDept) : e(msg.from_name || msg.from_dept)} · ${e(time)}${receiptHtml}
    </div>`;
  box.appendChild(div);
}

function _scrollChatToBottom() {
  const box = document.getElementById('chatMessages');
  if (box) box.scrollTop = box.scrollHeight;
}

function _updateUnreadBadge(dept) {
  const badge = document.getElementById('chatBadge_' + CSS.escape(dept));
  const count = _chatUnread[dept] || 0;
  if (badge) {
    badge.textContent = count;
    badge.style.display = count > 0 ? 'flex' : 'none';
  }
  const total = Object.values(_chatUnread).reduce((a, b) => a + b, 0);
  const globalBadge = document.getElementById('chatUnreadBadge');
  if (globalBadge) {
    globalBadge.textContent = total;
    globalBadge.style.display = total > 0 ? 'flex' : 'none';
  }
}

// ── Quick reply templates ─────────────────────────────────────────
const QUICK_REPLIES = {
  'BLOOD BANK': [
    'Unit ready for collection ✅',
    'Please resend the request form',
    'Blood group confirmation needed',
    'Unit dispatched 🚚',
    'Cross-match in progress',
    'Insufficient stock — please contact supervisor',
  ],
  OTHER: [
    'Requesting blood unit urgently 🚨',
    'Patient blood group: ',
    'Transfusion reaction reported ⚠️',
    'Unit received, thank you ✅',
    'Please send compatible unit ASAP',
    'Patient stable — request cancelled',
  ],
};

// ── Urgent mode & file state ──────────────────────────────────────
let _urgentMode  = false;
let _pendingFile = null;   // { file, url, name }
let _typingTimer = null;
let _onlineDepts = new Set();
// track which of my sent messages have been read: Set of message_ids
let _readMsgIds  = new Set();

function sendChatMessage() {
  const input = document.getElementById('chatInput');
  if (!input || !_chatActiveDept || !_chatSocket) return;
  const text = input.value.trim();
  if (!text && !_pendingFile) return;

  _chatSocket.emit('send_message', {
    to_dept:   _chatActiveDept,
    message:   text,
    urgent:    _urgentMode,
    file_url:  _pendingFile?.url  || null,
    file_name: _pendingFile?.name || null,
  });

  input.value = '';
  input.style.height = 'auto';

  // Clear urgent mode after send
  if (_urgentMode) toggleUrgent();

  // Clear pending file
  if (_pendingFile) {
    _pendingFile = null;
    const strip = document.getElementById('chatFileStrip');
    if (strip) { strip.classList.remove('show'); strip.querySelector('.chat-file-strip-name').textContent = ''; }
  }

  // Stop typing indicator
  if (_typingTimer) { clearTimeout(_typingTimer); _typingTimer = null; }
  _chatSocket.emit('typing', { to_dept: _chatActiveDept, typing: false });
}

function toggleUrgent() {
  _urgentMode = !_urgentMode;
  const btn = document.getElementById('chatUrgentBtn');
  if (btn) btn.classList.toggle('active', _urgentMode);
}

async function attachFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*,.pdf,.doc,.docx,.xls,.xlsx';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file || file.size > 5 * 1024 * 1024) { alert('File too large (max 5 MB)'); return; }
    const fd = new FormData();
    fd.append('file', file);
    try {
      const res = await fetch(`${API}/chat/upload`, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + getToken() },
        body: fd,
      });
      const data = await res.json();
      if (!res.ok) { alert(data.error); return; }
      _pendingFile = { url: data.url, name: data.name };
      const strip = document.getElementById('chatFileStrip');
      if (strip) {
        strip.querySelector('.chat-file-strip-name').textContent = data.name;
        strip.classList.add('show');
      }
    } catch { alert('Upload failed'); }
  };
  input.click();
}

function removePendingFile() {
  _pendingFile = null;
  const strip = document.getElementById('chatFileStrip');
  if (strip) { strip.classList.remove('show'); strip.querySelector('.chat-file-strip-name').textContent = ''; }
}

function sendQuickReply(text) {
  const input = document.getElementById('chatInput');
  if (input) { input.value = text; input.focus(); }
}

// ── Voice note ────────────────────────────────────────────────────
let _mediaRecorder  = null;
let _audioChunks    = [];
let _recTimerInt    = null;
let _recSeconds     = 0;

async function toggleVoiceNote() {
  if (_mediaRecorder && _mediaRecorder.state === 'recording') {
    _stopVoiceRecording();
  } else {
    await _startVoiceRecording();
  }
}

async function _startVoiceRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    _audioChunks = [];
    _recSeconds  = 0;

    // Pick best supported mime type
    const mime = ['audio/webm;codecs=opus','audio/webm','audio/ogg','audio/mp4']
      .find(m => MediaRecorder.isTypeSupported(m)) || '';

    _mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
    _mediaRecorder.ondataavailable = e => { if (e.data.size > 0) _audioChunks.push(e.data); };
    _mediaRecorder.onstop = _onVoiceRecordingStop;
    _mediaRecorder.start(200);

    // UI
    const btn = document.getElementById('chatMicBtn');
    const timer = document.getElementById('chatRecTimer');
    if (btn) btn.classList.add('recording');
    if (timer) { timer.classList.add('show'); timer.textContent = '0:00'; }

    _recTimerInt = setInterval(() => {
      _recSeconds++;
      const m = Math.floor(_recSeconds / 60);
      const s = String(_recSeconds % 60).padStart(2, '0');
      const t = document.getElementById('chatRecTimer');
      if (t) t.textContent = `${m}:${s}`;
      if (_recSeconds >= 120) _stopVoiceRecording(); // 2 min max
    }, 1000);

  } catch (err) {
    alert('Microphone access denied. Please allow microphone permission.');
  }
}

function _stopVoiceRecording() {
  if (!_mediaRecorder) return;
  _mediaRecorder.stop();
  _mediaRecorder.stream.getTracks().forEach(t => t.stop());
  clearInterval(_recTimerInt);
  const btn = document.getElementById('chatMicBtn');
  const timer = document.getElementById('chatRecTimer');
  if (btn) btn.classList.remove('recording');
  if (timer) timer.classList.remove('show');
}

async function _onVoiceRecordingStop() {
  const mime = _mediaRecorder.mimeType || 'audio/webm';
  const blob = new Blob(_audioChunks, { type: mime });
  const ext  = mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'mp4' : 'webm';
  const file = new File([blob], `voice-note-${Date.now()}.${ext}`, { type: mime });

  const fd = new FormData();
  fd.append('file', file);
  try {
    const res = await fetch(`${API}/chat/upload`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + getToken() },
      body: fd,
    });
    const data = await res.json();
    if (!res.ok) { alert('Voice upload failed: ' + data.error); return; }

    // Send immediately as a voice-note message
    if (_chatSocket && _chatActiveDept) {
      _chatSocket.emit('send_message', {
        to_dept:   _chatActiveDept,
        message:   '',
        urgent:    false,
        file_url:  data.url,
        file_name: data.name,
      });
    }
  } catch { alert('Voice upload failed'); }
  _mediaRecorder = null;
}

function _onChatInput() {
  if (!_chatSocket || !_chatActiveDept) return;
  _chatSocket.emit('typing', { to_dept: _chatActiveDept, typing: true });
  clearTimeout(_typingTimer);
  _typingTimer = setTimeout(() => {
    _chatSocket.emit('typing', { to_dept: _chatActiveDept, typing: false });
  }, 2500);
}
