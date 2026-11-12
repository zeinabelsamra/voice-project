// Admin — user management, departments, database settings
// 
// Loaded as a classic script (shared global scope) — see index.html for load order.

// ═══════════════════════════════════════════════════════
// ADMIN — USER MANAGEMENT
// ═══════════════════════════════════════════════════════
let editingUserId = null;

async function loadUsers() {
  const tbody = document.getElementById('usersTableBody');
  tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:20px;color:#888">Loading…</td></tr>';
  try {
    const res   = await apiFetch(API + '/users');
    if (!res) return;
    const users = await res.json();
    if (!users.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:20px;color:#888">No users found.</td></tr>';
      return;
    }
    tbody.innerHTML = users.map(u => `
      <tr>
        <td><strong>${e(u.username)}</strong></td>
        <td>${e(u.full_name)}</td>
        <td><span class="badge-role ${e(u.role)}">${e(u.role)}</span></td>
        <td style="font-size:11px;color:#555">${e(u.department || 'BLOOD BANK')}</td>
        <td><span class="${u.active ? 'badge-active' : 'badge-inactive'}">${u.active ? '● Active' : '○ Inactive'}</span></td>
        <td style="font-size:12px;color:#888">${(u.created_at || '').slice(0,10)}</td>
        <td>
          <button class="tbl-btn" onclick="openEditUser(${u.user_id},'${e(u.username)}','${e(u.full_name)}','${e(u.role)}',${u.active},'${e(u.department||'BLOOD BANK')}')">Edit</button>
          <button class="tbl-btn" onclick="openResetPw(${u.user_id},'${e(u.username)}')">Reset PW</button>
        </td>
      </tr>`).join('');
  } catch {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#dc2626">Failed to load users.</td></tr>';
  }
}

// ═══════════════════════════════════════════════════════
// SETTINGS — tab switcher (Database / Departments)
// ═══════════════════════════════════════════════════════
function showSettingsTab(tab) {
  document.getElementById('setTabDb').classList.toggle('active', tab === 'db');
  document.getElementById('setTabDepts').classList.toggle('active', tab === 'depts');
  document.getElementById('setPaneDb').style.display    = tab === 'db'    ? '' : 'none';
  document.getElementById('setPaneDepts').style.display  = tab === 'depts' ? '' : 'none';
  if (tab === 'depts') loadDepartments();
}

// ═══════════════════════════════════════════════════════
// SETTINGS — Departments (admin only)
// The single source of truth for the department picklist used by the
// Add/Edit User modal and Chat's sidebar — see populateDepartmentOptions()
// and initChat() for the consumers.
// ═══════════════════════════════════════════════════════
function showDeptMsg(text, ok) {
  const el = document.getElementById('deptMsg');
  el.textContent = text;
  el.className = 'settings-msg ' + (ok ? 'ok' : 'fail');
  el.style.display = '';
}

async function loadDepartments() {
  const tbody = document.getElementById('deptTableBody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;padding:20px;color:#888">Loading…</td></tr>';
  try {
    const res = await apiFetch(`${API}/api/departments?includeInactive=1`);
    if (!res) return;
    const depts = await res.json();
    if (!Array.isArray(depts) || !depts.length) {
      tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;padding:20px;color:#888">No departments yet.</td></tr>';
      return;
    }
    tbody.innerHTML = depts.map(d => {
      const isSystem = d.name === 'BLOOD BANK';
      return `
        <tr>
          <td><strong>${e(d.name)}</strong>${isSystem ? '<span class="dept-system-tag">System</span>' : ''}</td>
          <td><span class="${d.active ? 'badge-active' : 'badge-inactive'}">${d.active ? '● Active' : '○ Inactive'}</span></td>
          <td>
            ${isSystem ? '<span style="color:var(--text-soft);font-size:12px">—</span>' : `
              <button class="tbl-btn" onclick="renameDepartment(${d.department_id},'${e(d.name)}')">Rename</button>
              <button class="tbl-btn ${d.active ? 'danger' : ''}" onclick="toggleDepartmentActive(${d.department_id},${!d.active})">${d.active ? 'Deactivate' : 'Activate'}</button>
            `}
          </td>
        </tr>`;
    }).join('');
  } catch {
    tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;color:#dc2626">Failed to load departments.</td></tr>';
  }
}

async function addDepartment() {
  const input = document.getElementById('deptNewName');
  const name = input.value.trim();
  document.getElementById('deptMsg').style.display = 'none';
  if (!name) { showDeptMsg('Enter a department name first.', false); return; }
  const res = await apiFetch(`${API}/api/departments`, { method: 'POST', body: { name } });
  if (!res) return;
  const data = await res.json();
  if (!res.ok) { showDeptMsg(data.error || 'Failed to add department.', false); return; }
  input.value = '';
  showDeptMsg(`✓ "${name.toUpperCase()}" added.`, true);
  loadDepartments();
}

async function renameDepartment(id, currentName) {
  const next = prompt('Rename department:', currentName);
  if (next === null) return; // cancelled
  const name = next.trim();
  if (!name || name.toUpperCase() === currentName.toUpperCase()) return;
  const res = await apiFetch(`${API}/api/departments/${id}`, { method: 'PUT', body: { name } });
  if (!res) return;
  const data = await res.json();
  document.getElementById('deptMsg').style.display = 'none';
  if (!res.ok) { showDeptMsg(data.error || 'Failed to rename department.', false); return; }
  loadDepartments();
}

async function toggleDepartmentActive(id, nextActive) {
  const res = await apiFetch(`${API}/api/departments/${id}`, { method: 'PUT', body: { active: nextActive } });
  if (!res) return;
  const data = await res.json();
  document.getElementById('deptMsg').style.display = 'none';
  if (!res.ok) { showDeptMsg(data.error || 'Failed to update department.', false); return; }
  loadDepartments();
}

// Shared by the Add/Edit User modal's department <select>. Only active
// departments are offered as choices for a NEW selection, but if the user
// being edited already has a (since-deactivated) department, it's kept in
// the list so their existing value doesn't silently disappear from view.
async function populateDepartmentOptions(selectEl, selectedValue) {
  selectEl.innerHTML = '<option value="">— Loading —</option>';
  try {
    const res = await apiFetch(`${API}/api/departments`);
    const depts = res ? await res.json() : [];
    const names = Array.isArray(depts) ? depts.map(d => d.name) : [];
    if (selectedValue && !names.includes(selectedValue)) names.push(selectedValue);
    selectEl.innerHTML = '<option value="">— Select department —</option>'
      + names.map(n => `<option${n === selectedValue ? ' selected' : ''}>${e(n)}</option>`).join('');
  } catch {
    selectEl.innerHTML = '<option value="">— Failed to load departments —</option>';
  }
}

// ═══════════════════════════════════════════════════════
// SETTINGS — Database connection credentials (admin only)
// ═══════════════════════════════════════════════════════
function toggleSettingsPw(id) {
  const input = document.getElementById(id);
  input.type = input.type === 'password' ? 'text' : 'password';
}

function fillDbForm(prefix, s) {
  document.getElementById(prefix + '_server').value      = s.server || '';
  document.getElementById(prefix + '_port').value         = s.port || 1433;
  document.getElementById(prefix + '_database').value     = s.database || '';
  document.getElementById(prefix + '_user').value         = s.user || '';
  document.getElementById(prefix + '_password').value     = s.password || '';
  document.getElementById(prefix + '_windowsAuth').checked = !!s.windowsAuth;
  document.getElementById(prefix + '_trustCert').checked   = s.trustServerCertificate !== false;
}

function collectDbForm(prefix) {
  return {
    server:                 document.getElementById(prefix + '_server').value.trim(),
    port:                   parseInt(document.getElementById(prefix + '_port').value) || 1433,
    database:               document.getElementById(prefix + '_database').value.trim(),
    user:                   document.getElementById(prefix + '_user').value.trim(),
    password:               document.getElementById(prefix + '_password').value,
    windowsAuth:            document.getElementById(prefix + '_windowsAuth').checked,
    trustServerCertificate: document.getElementById(prefix + '_trustCert').checked,
  };
}

function showSetMsg(text, ok) {
  const el = document.getElementById('setMsg');
  el.textContent = text;
  el.className = 'settings-msg ' + (ok ? 'ok' : 'fail');
  el.style.display = '';
}

async function loadDbSettings() {
  document.getElementById('setMsg').style.display = 'none';
  try {
    const res = await apiFetch(`${API}/api/settings/db`);
    if (!res) return;
    const data = await res.json();
    fillDbForm('ed', data.edelphyn || {});
  } catch {
    showSetMsg('Failed to load current settings.', false);
  }
}

async function testDbSettings(which) {
  const prefix   = 'ed';
  const resultEl = document.getElementById(prefix + '_testResult');
  const btn      = document.getElementById(prefix + '_testBtn');
  resultEl.className   = 'settings-test-result pending';
  resultEl.textContent = 'Testing…';
  btn.disabled = true;
  try {
    const res  = await apiFetch(`${API}/api/settings/db/test`, {
      method: 'POST',
      body: { which, ...collectDbForm(prefix) },
    });
    if (!res) return;
    const data = await res.json();
    if (data.ok) {
      resultEl.className   = 'settings-test-result ok';
      resultEl.textContent = '✓ Connected successfully';
    } else {
      resultEl.className   = 'settings-test-result fail';
      resultEl.textContent = '✗ ' + (data.error || 'Connection failed');
    }
  } catch (err) {
    resultEl.className   = 'settings-test-result fail';
    resultEl.textContent = '✗ ' + err.message;
  } finally {
    btn.disabled = false;
  }
}

async function saveDbSettings() {
  document.getElementById('setMsg').style.display = 'none';
  try {
    const res = await apiFetch(`${API}/api/settings/db`, {
      method: 'PUT',
      body: { edelphyn: collectDbForm('ed') },
    });
    if (!res) return;
    const data = await res.json();
    if (!res.ok) { showSetMsg(data.error || 'Failed to save settings.', false); return; }
    const edOk = data.edelphyn?.ok;
    if (edOk) {
      showSetMsg('✓ Settings saved — connection verified.', true);
    } else {
      showSetMsg('Settings saved, but could not connect: ' + (data.edelphyn?.error || 'unknown error'), false);
    }
  } catch (err) {
    showSetMsg('Failed to save settings: ' + err.message, false);
  }
}

async function reloadDbSettings() {
  document.getElementById('setMsg').style.display = 'none';
  try {
    const res = await apiFetch(`${API}/api/settings/db/reload`, { method: 'POST' });
    if (!res) return;
    const data = await res.json();
    await loadDbSettings();
    const edOk = data.edelphyn?.ok;
    showSetMsg(
      edOk ? '✓ Reloaded — connection verified.'
           : 'Reloaded, but could not connect: ' + (data.edelphyn?.error || 'unknown error'),
      edOk
    );
  } catch (err) {
    showSetMsg('Failed to reload: ' + err.message, false);
  }
}

function openAddUser() {
  editingUserId = null;
  document.getElementById('modalTitle').textContent    = 'Add New User';
  document.getElementById('mUsername').value           = '';
  document.getElementById('mUsername').disabled        = false;
  document.getElementById('mFullName').value           = '';
  document.getElementById('mPassword').value           = '';
  document.getElementById('mPasswordLabel').textContent = 'Password';
  document.getElementById('mRole').value               = 'staff';
  populateDepartmentOptions(document.getElementById('mDepartment'), 'BLOOD BANK');
  document.getElementById('mActiveWrap').style.display = 'none';
  document.getElementById('mPasswordWrap').style.display = '';
  document.getElementById('modalErr').textContent      = '';
  document.getElementById('modalBg').classList.add('open');
}

function openEditUser(id, username, fullName, role, active, department) {
  editingUserId = id;
  document.getElementById('modalTitle').textContent    = 'Edit User';
  document.getElementById('mUsername').value           = username;
  document.getElementById('mUsername').disabled        = true;
  document.getElementById('mFullName').value           = fullName;
  document.getElementById('mPasswordWrap').style.display = 'none';
  document.getElementById('mRole').value               = role;
  populateDepartmentOptions(document.getElementById('mDepartment'), department || 'BLOOD BANK');
  document.getElementById('mActive').value             = active ? '1' : '0';
  document.getElementById('mActiveWrap').style.display = '';
  document.getElementById('modalErr').textContent      = '';
  document.getElementById('modalBg').classList.add('open');
}

let resetPwUserId = null;
function openResetPw(id, username) {
  resetPwUserId = id;
  editingUserId = null;
  document.getElementById('modalTitle').textContent       = `Reset Password — ${username}`;
  document.getElementById('mUsername').value              = username;
  document.getElementById('mUsername').disabled           = true;
  document.getElementById('mFullName').value              = '';
  document.getElementById('mPasswordWrap').style.display  = '';
  document.getElementById('mPasswordLabel').textContent   = 'New Password';
  document.getElementById('mPassword').value              = '';
  document.getElementById('mActiveWrap').style.display    = 'none';
  document.getElementById('mRole').value                  = 'staff';
  document.getElementById('modalErr').textContent         = '';
  document.getElementById('modalBg').classList.add('open');
}

function closeModal() {
  document.getElementById('modalBg').classList.remove('open');
  resetPwUserId = null;
}

async function submitUserModal() {
  const errEl    = document.getElementById('modalErr');
  const fullName = document.getElementById('mFullName').value.trim();
  const password = document.getElementById('mPassword').value;
  const role     = document.getElementById('mRole').value;
  errEl.textContent = '';

  // Password reset mode
  if (resetPwUserId) {
    if (!password || password.length < 8) { errEl.textContent = 'Password must be at least 8 characters.'; return; }
    const res = await apiFetch(`${API}/users/${resetPwUserId}/password`, { method: 'PUT', body: { password } });
    if (!res) return;
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error; return; }
    closeModal(); loadUsers();
    return;
  }

  const department = document.getElementById('mDepartment').value;

  // Edit mode
  if (editingUserId) {
    if (!fullName) { errEl.textContent = 'Full name is required.'; return; }
    const active = document.getElementById('mActive').value === '1';
    const res = await apiFetch(`${API}/users/${editingUserId}`, { method: 'PUT', body: { full_name: fullName, role, active, department } });
    if (!res) return;
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error; return; }
    closeModal(); loadUsers();
    return;
  }

  // Add mode
  const username = document.getElementById('mUsername').value.trim();
  if (!username || !fullName || !password) { errEl.textContent = 'All fields are required.'; return; }
  if (password.length < 8) { errEl.textContent = 'Password must be at least 8 characters.'; return; }
  const res = await apiFetch(`${API}/users`, { method: 'POST', body: { username, full_name: fullName, password, role, department } });
  if (!res) return;
  const data = await res.json();
  if (!res.ok) { errEl.textContent = data.error; return; }
  closeModal(); loadUsers();
}

// Close modal on background click
document.getElementById('modalBg').addEventListener('click', e => {
  if (e.target === document.getElementById('modalBg')) closeModal();
});
