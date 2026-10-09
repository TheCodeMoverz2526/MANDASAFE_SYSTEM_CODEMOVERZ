/* =========================================================
   MandaSafe — resident (user) side API + session helpers
   Every figure on the resident pages comes from the same database the
   administrators write to through the RIMAS console. The one exception is
   a resident's own profile (name/email/phone) — everything else is read-only.
   ========================================================= */

/* The signed-in account is kept in localStorage rather than sessionStorage: the resident
   side is a set of separate pages, so a link opened in a new tab must stay signed in. */
const SESSION_KEY = 'rimasCurrentUser';
const TOKEN_KEY = 'rimasToken';

function authToken() { return localStorage.getItem(TOKEN_KEY) || ''; }

function currentUser() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); }
    catch { return null; }
}

function isAdmin() { return currentUser()?.role === 'admin'; }

async function apiGet(path) {
    let response;
    try {
        response = await fetch(path, {
            cache: 'no-store',
            headers: authToken() ? { Authorization: `Bearer ${authToken()}` } : {}
        });
    } catch {
        throw new Error(['localhost', '127.0.0.1'].includes(location.hostname)
            ? 'Cannot reach the MandaSafe server. Start it with start-mandasafe.bat.'
            : 'MandaSafe is not responding right now. Please check your connection and try again in a moment.');
    }
    let data = null;
    try { data = await response.json(); } catch { /* no body */ }
    if (response.status === 401) {
        localStorage.removeItem(SESSION_KEY);
        localStorage.removeItem(TOKEN_KEY);
        location.replace('login.html');
        throw new Error('Session expired.');
    }
    if (!response.ok) throw new Error((data && data.error) || `Request failed (${response.status})`);
    return data;
}

async function apiSend(path, method, body) {
    let response;
    try {
        response = await fetch(path, {
            method,
            headers: {
                'Content-Type': 'application/json',
                ...(authToken() ? { Authorization: `Bearer ${authToken()}` } : {})
            },
            body: JSON.stringify(body)
        });
    } catch {
        throw new Error('Cannot reach the MandaSafe server. Start it with start-rimas.bat (or "node server.js").');
    }
    let data = null;
    try { data = await response.json(); } catch { /* no body */ }
    if (response.status === 401) {
        localStorage.removeItem(SESSION_KEY);
        localStorage.removeItem(TOKEN_KEY);
        location.replace('login.html');
        throw new Error('Session expired.');
    }
    if (!response.ok) throw new Error((data && data.error) || `Request failed (${response.status})`);
    return data;
}

const API = {
    summary:     () => apiGet('/api/summary'),
    incidents:   () => apiGet('/api/incidents'),
    hotspots:    () => apiGet('/api/hotspots'),
    barangayHotspots: () => apiGet('/api/hotspots/barangays'),
    predictions: () => apiGet('/api/predictions'),
    stats:       () => apiGet('/api/stats'),
    alerts:      () => apiGet('/api/alerts'),
    alertsSeen:  () => apiSend('/api/alerts/read-all', 'POST', {}),
    me:          () => apiGet('/api/auth/me'),
    updateProfile: (body) => apiSend('/api/auth/profile', 'PUT', body)
};

/* MandaSafe is a served application, not loose files: opening a page straight from the
   folder (file:///...) means every /api/... call resolves to a path on disk and fails.
   Say so plainly instead of bouncing the visitor between pages. */
function ensureServed() {
    if (location.protocol !== 'file:') return true;
    document.body.innerHTML = `
        <div style="max-width:620px;margin:12vh auto;padding:34px;background:#fff;border:1px solid #e5e9f2;
                    border-radius:16px;box-shadow:0 18px 50px rgba(6,35,80,.15);font-family:'Segoe UI',system-ui,sans-serif">
          <h1 style="font-size:22px;margin-bottom:10px;color:#0f172a">Start MandaSafe first</h1>
          <p style="color:#334155;line-height:1.65;font-size:14px">
            This page was opened directly from the folder, so it cannot reach the MandaSafe database.
            Close this tab, double-click <b>start-mandasafe.bat</b> in the MandaSafe folder, then open
            <b>http://localhost:5500/</b> in your browser.</p>
          <p style="color:#64748b;font-size:12.5px;margin-top:14px">
            The sign-in, the maps, the hotspots and the forecasts all read from the server, so the system
            only works through that address.</p>
        </div>`;
    return false;
}

/* Resident pages need a signed-in account; the landing page does not. */
function requireAuth() {
    if (!ensureServed()) return false;
    if (!currentUser() || !authToken()) { location.replace('login.html'); return false; }
    stayGuarded();
    return true;
}

/* Once signed out, a protected page must not come back until the person signs in again:
   - the Back button can restore this page from the browser's memory without running any
     of its scripts again, so the check is repeated whenever the page is shown;
   - signing out in another tab clears the shared storage, which every open tab hears. */
function stayGuarded() {
    const bounce = () => {
        if (currentUser() && authToken()) return;
        document.documentElement.style.visibility = 'hidden';
        location.replace('login.html');
    };
    window.addEventListener('pageshow', bounce);
    window.addEventListener('storage', event => {
        if (event.key === null || event.key === TOKEN_KEY || event.key === SESSION_KEY) bounce();
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) bounce(); });
}

function logout() {
    // Not awaited: the server ends the session on its own time (keepalive lets the request
    // outlive this page), so a slow or busy server never holds the visitor on "Signing out…".
    fetch('/api/auth/logout', { method: 'POST', keepalive: true, headers: { Authorization: `Bearer ${authToken()}` } })
        .catch(() => { /* signing out locally is enough */ });
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(TOKEN_KEY);
    // replace, not href: the signed-in page is taken out of the history, so Back can't reach it.
    location.replace('login.html');
}

/* Shows a message inside a card body while data loads / when it fails. */
function setState(el, html, isError) {
    if (!el) return;
    el.innerHTML = `<div class="empty${isError ? ' is-error' : ''}">${html}</div>`;
}
