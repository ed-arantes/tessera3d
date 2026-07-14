/**
 * Tessera Client Auth
 * Token stored in localStorage. API calls use same-origin Cloudflare routes
 * that are backed by the D1 database table named users.
 */

const AUTH_URL = '';

async function parseResponse(res) {
  let text = '';
  try { text = await res.text(); } catch (_) { text = ''; }
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch (_) { data = text; }
  }
  return { ok: res.ok, status: res.status, data, text };
}

const Auth = {
  _token: null,
  _username: null,
  _createdAt: null,

  get token() { return this._token || localStorage.getItem('tessera_token'); },
  get username() { return this._username || localStorage.getItem('tessera_username'); },
  get createdAt() { return this._createdAt || localStorage.getItem('tessera_createdAt'); },
  get isLoggedIn() { return !!this.token; },

  setToken(token, username, createdAt) {
    this._token = token;
    this._username = username;
    if (typeof createdAt !== 'undefined' && createdAt !== null) {
      this._createdAt = createdAt;
    } else if (!token) {
      this._createdAt = null;
    }
    if (token) {
      localStorage.setItem('tessera_token', token);
      localStorage.setItem('tessera_username', username);
      if (this._createdAt) {
        localStorage.setItem('tessera_createdAt', this._createdAt);
      } else {
        localStorage.removeItem('tessera_createdAt');
      }
    } else {
      localStorage.removeItem('tessera_token');
      localStorage.removeItem('tessera_username');
      localStorage.removeItem('tessera_createdAt');
    }
    updateAuthUI();
  },

  logout() {
    this.setToken(null, null);
  },

  async signup(username, password) {
    const res = await fetch(`${AUTH_URL}/api/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const parsed = await parseResponse(res);
    if (!parsed.ok) {
      const msg = (parsed.data && parsed.data.error) || parsed.text || `Signup failed (${parsed.status})`;
      throw new Error(msg);
    }
    this.setToken(parsed.data.token, parsed.data.username, parsed.data.createdAt);
    return parsed.data;
  },

  async signin(username, password) {
    const res = await fetch(`${AUTH_URL}/api/signin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const parsed = await parseResponse(res);
    if (!parsed.ok) {
      const msg = (parsed.data && parsed.data.error) || parsed.text || `Signin failed (${parsed.status})`;
      throw new Error(msg);
    }
    this.setToken(parsed.data.token, parsed.data.username, parsed.data.createdAt);
    return parsed.data;
  },

  async verifySession() {
    const token = this.token;
    if (!token) return null;
    const res = await fetch(`${AUTH_URL}/api/session`, {
      headers: { 'Authorization': token }
    });
    if (!res.ok) { this.setToken(null, null); return null; }
    const parsed = await parseResponse(res);
    this.setToken(token, parsed.data && parsed.data.username, parsed.data && parsed.data.createdAt);
    return parsed.data;
  }
};

// ── DiceBear Avatar ──────────────────────────────────────────────────────

function stringHash(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) - hash) + value.charCodeAt(i);
    hash |= 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function avatarUrl(seedValue) {
  const seed = `tessera-${stringHash(seedValue.toString())}`;
  return `https://api.dicebear.com/10.x/bottts/svg?seed=${encodeURIComponent(seed)}&mouth=smile`;
}

// ── Auth UI ──────────────────────────────────────────────────────────────

function updateAuthUI() {
  const container = document.getElementById('user-auth-card');
  if (!container) return;

  if (Auth.isLoggedIn) {
    container.innerHTML = `
      <div style="display: flex; align-items: center; gap: 12px; flex: 1;">
        <div style="position: relative; width: 36px; height: 36px; flex-shrink: 0; cursor: pointer;" onclick="openDashboard()" title="Open Settings">
          <div class="avatar-placeholder" style="width:36px;height:36px;border-radius:50%;background:var(--bg-base);border:2px solid var(--accent);"></div>
          <img src="${avatarUrl(Auth.username || Auth.token || 'guest')}" alt=""
            style="position:absolute;inset:0;width:36px;height:36px;border-radius:50%;border:2px solid var(--accent);object-fit:cover;"
            onerror="this.style.display='none'"
            onload="this.previousElementSibling.style.display='none'">
        </div>
        <div style="cursor: pointer;" onclick="openDashboard()" title="Open Settings">
          <h2 style="margin: 0; padding: 0; font-size: 14px;">
            Welcome, <span id="auth-username">${escapeHtml(capitalise(Auth.username))}!</span>
          </h2>
        </div>
      </div>
      <div style="display: flex; gap: 8px;">
        <button class="btn-secondary" style="padding: 4px 12px; font-size: 14px; display: flex; align-items: center; gap: 6px;" onclick="Auth.logout()">
          <i data-lucide="log-out"></i> Logout
        </button>
      </div>
    `;
  } else {
    container.innerHTML = `
      <div style="display: flex; align-items: center; gap: 12px; flex: 1;">
        <div style="width: 32px; height: 32px; background: var(--accent); border-radius: 50%; display: flex; align-items: center; justify-content: center; color: white; flex-shrink: 0;">
          <i data-lucide="user"></i>
        </div>
        <div>
          <h2 style="margin: 0; padding: 0; font-size: 14px;">
            Welcome, Guest!
          </h2>
        </div>
      </div>
      <div style="display: flex; gap: 8px;">
        <button class="btn-secondary" style="padding: 4px 12px; font-size: 14px; display: flex; align-items: center; gap: 6px;" onclick="openAuthModal('signin')">
          <i data-lucide="log-in"></i> Login
        </button>
        <button class="btn-primary-glow" style="padding: 4px 12px; font-size: 14px; display: flex; align-items: center; gap: 6px; background: var(--accent); color: white; border: none; border-radius: 10px; cursor: pointer; font-weight: 700;" onclick="openAuthModal('signup')">
          <i data-lucide="user-plus"></i> Sign Up
        </button>
      </div>
    `;
  }

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function capitalise(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function openAuthModal(mode) {
  const overlay = document.getElementById('auth-modal-overlay');
  const title = document.getElementById('auth-modal-title');
  const submitBtn = document.getElementById('auth-modal-submit');
  const toggleText = document.getElementById('auth-modal-toggle-text');
  const toggleLink = document.getElementById('auth-modal-toggle-link');
  const errorEl = document.getElementById('auth-modal-error');
  const usernameInput = document.getElementById('auth-input-username');
  const passwordInput = document.getElementById('auth-input-password');

  errorEl.textContent = '';
  usernameInput.value = '';
  passwordInput.value = '';
  overlay.classList.remove('hidden');

  if (mode === 'signin') {
    title.textContent = 'Sign In';
    submitBtn.textContent = 'Sign In';
    toggleText.textContent = "Don't have an account? ";
    toggleLink.textContent = 'Sign Up';
    toggleLink.onclick = () => openAuthModal('signup');
  } else {
    title.textContent = 'Sign Up';
    submitBtn.textContent = 'Create Account';
    toggleText.textContent = 'Already have an account? ';
    toggleLink.textContent = 'Sign In';
    toggleLink.onclick = () => openAuthModal('signin');
  }

  overlay.dataset.mode = mode;
  usernameInput.focus();
}

function closeAuthModal() {
  document.getElementById('auth-modal-overlay').classList.add('hidden');
}

async function submitAuthForm() {
  const overlay = document.getElementById('auth-modal-overlay');
  const mode = overlay.dataset.mode;
  const username = document.getElementById('auth-input-username').value.trim();
  const password = document.getElementById('auth-input-password').value;
  const errorEl = document.getElementById('auth-modal-error');
  const submitBtn = document.getElementById('auth-modal-submit');

  errorEl.textContent = '';
  submitBtn.disabled = true;
  submitBtn.textContent = 'Please wait...';

  try {
    if (mode === 'signin') {
      await Auth.signin(username, password);
    } else {
      await Auth.signup(username, password);
    }
    closeAuthModal();
  } catch (err) {
    errorEl.textContent = err.message;
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = mode === 'signin' ? 'Sign In' : 'Create Account';
  }
}

// Handle Enter key in modal inputs and initialize UI
document.addEventListener('DOMContentLoaded', () => {
  const overlay = document.getElementById('auth-modal-overlay');
  if (overlay) {
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeAuthModal();
    });
    ['auth-input-username', 'auth-input-password'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submitAuthForm();
      });
    });
  }
  // Show guest state immediately, then verify session in background
  updateAuthUI();
  Auth.verifySession().then(() => updateAuthUI()).catch(() => updateAuthUI());
});

// ── User Dashboard ────────────────────────────────────────────────────────

function dashStorageKey(type) {
  return `tessera_${type}_${Auth.username}`;
}

function dashLoadActivity() {
  try {
    return JSON.parse(localStorage.getItem(dashStorageKey('activity'))) || { projects: 0, exports: 0, saves: 0 };
  } catch { return { projects: 0, exports: 0, saves: 0 }; }
}

function dashSaveActivity(data) {
  localStorage.setItem(dashStorageKey('activity'), JSON.stringify(data));
}

function dashTrackExport() {
  const a = dashLoadActivity();
  a.exports++;
  dashSaveActivity(a);
}

let _lastSaveTracked = 0;
function dashTrackSave() {
  const now = Date.now();
  if (now - _lastSaveTracked < 5000) return; // max once per 5s
  _lastSaveTracked = now;
  const a = dashLoadActivity();
  a.saves++;
  dashSaveActivity(a);
}

function dashTrackProject() {
  const a = dashLoadActivity();
  a.projects++;
  dashSaveActivity(a);
}

function dashLoadFilaments() {
  try {
    return JSON.parse(localStorage.getItem(dashStorageKey('filaments'))) || [];
  } catch { return []; }
}

function dashSaveFilaments(list) {
  localStorage.setItem(dashStorageKey('filaments'), JSON.stringify(list));
}

function dashLoadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(dashStorageKey('prefs'))) || {};
  } catch { return {}; }
}

function dashSavePrefs() {
  const prefs = {
    gridRes: parseInt(document.getElementById('dash-pref-grid').value),
    layerHeight: parseFloat(document.getElementById('dash-pref-layer').value)
  };
  localStorage.setItem(dashStorageKey('prefs'), JSON.stringify(prefs));
  const msg = document.getElementById('dash-pref-msg');
  msg.textContent = 'Saved!';
  msg.className = 'dash-msg dash-msg-ok';
  setTimeout(() => { msg.textContent = ''; }, 2000);
}

function openDashboard() {
  if (!Auth.isLoggedIn) return;
  const overlay = document.getElementById('dashboard-overlay');
  overlay.classList.remove('hidden');

  // Avatar
  const avatarC = document.getElementById('dash-avatar-container');
  avatarC.innerHTML = `
    <div class="dash-avatar-placeholder" style="position:relative;">
      <div class="avatar-placeholder" style="width:64px;height:64px;border-radius:50%;background:var(--bg-base);position:absolute;inset:0;"></div>
      <img src="${avatarUrl(Auth.username || Auth.token || 'guest')}" class="dash-avatar"
        style="position:absolute;inset:0;"
        onerror="this.style.display='none'"
        onload="this.previousElementSibling.style.display='none'">
    </div>`;

  // Username & meta
  document.getElementById('dash-username').textContent = capitalise(Auth.username);
  const memberMeta = document.getElementById('dash-meta');
  if (memberMeta) {
    const createdAt = Auth.createdAt;
    if (createdAt) {
      const date = new Date(createdAt);
      memberMeta.textContent = Number.isNaN(date.getTime())
        ? 'Member since -'
        : `Member since ${date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`;
    } else {
      memberMeta.textContent = 'Member since -';
    }
  }

  // Activity
  const act = dashLoadActivity();
  document.getElementById('stat-projects').textContent = act.projects;
  document.getElementById('stat-exports').textContent = act.exports;
  document.getElementById('stat-saves').textContent = act.saves;

  // Clear messages
  document.getElementById('dash-username-msg').textContent = '';
  document.getElementById('dash-password-msg').textContent = '';
  document.getElementById('dash-delete-msg').textContent = '';
  document.getElementById('dash-pref-msg').textContent = '';

  // Clear inputs
  document.getElementById('dash-new-username').value = '';
  document.getElementById('dash-username-password').value = '';
  document.getElementById('dash-cur-password').value = '';
  document.getElementById('dash-new-password').value = '';
  document.getElementById('dash-delete-password').value = '';

  // Filaments
  dashRenderFilaments();

  // Prefs
  const prefs = dashLoadPrefs();
  if (prefs.gridRes) document.getElementById('dash-pref-grid').value = prefs.gridRes;
  if (prefs.layerHeight) document.getElementById('dash-pref-layer').value = prefs.layerHeight;

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function closeDashboard() {
  document.getElementById('dashboard-overlay').classList.add('hidden');
}

function dashSetMsg(id, text, ok) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = 'dash-msg ' + (ok ? 'dash-msg-ok' : 'dash-msg-err');
}

async function dashChangeUsername() {
  const newUsername = document.getElementById('dash-new-username').value.trim();
  const password = document.getElementById('dash-username-password').value;
  if (!newUsername || !password) return dashSetMsg('dash-username-msg', 'Fill in all fields.', false);

  try {
    const res = await fetch(`${AUTH_URL}/api/change-username`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': Auth.token },
      body: JSON.stringify({ newUsername, password })
    });
    const parsed = await parseResponse(res);
    if (!parsed.ok) throw new Error(parsed.data && parsed.data.error);

    // Migrate localStorage keys
    const oldUser = Auth.username;
    ['activity', 'filaments', 'prefs'].forEach(type => {
      const oldKey = `tessera_${type}_${oldUser}`;
      const newKey = `tessera_${type}_${newUsername}`;
      const val = localStorage.getItem(oldKey);
      if (val) { localStorage.setItem(newKey, val); localStorage.removeItem(oldKey); }
    });

    Auth.setToken(parsed.data.token, parsed.data.username, parsed.data.createdAt);
    dashSetMsg('dash-username-msg', 'Username updated!', true);
    document.getElementById('dash-username').textContent = capitalise(newUsername);
    updateAuthUI();
    setTimeout(() => closeDashboard(), 1200);
  } catch (err) {
    dashSetMsg('dash-username-msg', err.message, false);
  }
}

async function dashChangePassword() {
  const curPassword = document.getElementById('dash-cur-password').value;
  const newPassword = document.getElementById('dash-new-password').value;
  if (!curPassword || !newPassword) return dashSetMsg('dash-password-msg', 'Fill in all fields.', false);

  try {
    const res = await fetch(`${AUTH_URL}/api/change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': Auth.token },
      body: JSON.stringify({ currentPassword: curPassword, newPassword })
    });
    const parsed = await parseResponse(res);
    if (!parsed.ok) throw new Error(parsed.data && parsed.data.error);

    Auth.setToken(parsed.data.token, Auth.username, parsed.data.createdAt);
    dashSetMsg('dash-password-msg', 'Password updated!', true);
    document.getElementById('dash-cur-password').value = '';
    document.getElementById('dash-new-password').value = '';
  } catch (err) {
    dashSetMsg('dash-password-msg', err.message, false);
  }
}

async function dashDeleteAccount() {
  const password = document.getElementById('dash-delete-password').value;
  if (!password) return dashSetMsg('dash-delete-msg', 'Enter your password to confirm.', false);
  if (!confirm('Are you absolutely sure? This cannot be undone.')) return;

  try {
    const res = await fetch(`${AUTH_URL}/api/account`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'Authorization': Auth.token },
      body: JSON.stringify({ password })
    });
    const parsed = await parseResponse(res);
    if (!parsed.ok) throw new Error(parsed.data && parsed.data.error);

    // Clean localStorage
    ['activity', 'filaments', 'prefs'].forEach(type => {
      localStorage.removeItem(dashStorageKey(type));
    });

    closeDashboard();
    Auth.logout();
  } catch (err) {
    dashSetMsg('dash-delete-msg', err.message, false);
  }
}

function dashRenderFilaments() {
  const list = dashLoadFilaments();
  const container = document.getElementById('dash-filament-list');
  if (list.length === 0) {
    container.innerHTML = '<div style="font-size:12px;color:var(--text-muted);padding:4px 0;">No filaments added yet.</div>';
    return;
  }
  container.innerHTML = list.map((f, i) => `
    <div class="dash-filament-row">
      <div class="dash-filament-swatch" style="background:${escapeHtml(f.color)}"></div>
      <div class="dash-filament-name">${escapeHtml(f.name || 'Unnamed')}</div>
      <div class="dash-filament-brand">${escapeHtml(f.brand || '-')}</div>
      <div class="dash-filament-remaining">${f.remaining || '?'}g</div>
      <button class="dash-filament-remove" onclick="dashRemoveFilament(${i})" title="Remove">&times;</button>
    </div>
  `).join('');
}

function dashAddFilament() {
  const color = document.getElementById('dash-fil-color').value;
  const name = document.getElementById('dash-fil-name').value.trim();
  const brand = document.getElementById('dash-fil-brand').value.trim();
  const remaining = document.getElementById('dash-fil-remaining').value;
  if (!name) return;

  const list = dashLoadFilaments();
  list.push({ color, name, brand, remaining: remaining || '?' });
  dashSaveFilaments(list);
  dashRenderFilaments();

  document.getElementById('dash-fil-name').value = '';
  document.getElementById('dash-fil-brand').value = '';
  document.getElementById('dash-fil-remaining').value = '';
}

function dashRemoveFilament(idx) {
  const list = dashLoadFilaments();
  list.splice(idx, 1);
  dashSaveFilaments(list);
  dashRenderFilaments();
}

// Close dashboard on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const overlay = document.getElementById('dashboard-overlay');
    if (overlay && !overlay.classList.contains('hidden')) closeDashboard();
  }
});
