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

const API = {
    summary:     () => apiGet('/api/summary'),
    incidents:   () => apiGet('/api/incidents'),
    hotspots:    () => apiGet('/api/hotspots'),
    barangayHotspots: () => apiGet('/api/hotspots/barangays'),
    predictions: () => apiGet('/api/predictions'),
    barangayPredictions: () => apiGet('/api/predictions/barangays'),
    stats:       () => apiGet('/api/stats'),
    alerts:      () => apiGet('/api/alerts'),
    alertsSeen:  () => apiSend('/api/alerts/read-all', 'POST', {}),
    me:          () => apiGet('/api/auth/me'),
    updateProfile: (body) => apiSend('/api/auth/profile', 'PUT', body),
    requestData: (body) => apiSend('/api/data-requests', 'POST', body),
    dataRequests: () => apiGet('/api/data-requests')
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
    // Back to the homepage. replace, not href: the signed-in page is taken out of the
    // history, so Back can't reach it.
    location.replace('index.html');
}

/* Shows a message inside a card body while data loads / when it fails. */
function setState(el, html, isError) {
    if (!el) return;
    el.innerHTML = `<div class="empty${isError ? ' is-error' : ''}">${html}</div>`;
}

/* ===== Live updates ===================================================
   Every page showing accident data asks GET /api/data-version (one tiny query) every 20
   seconds while it is on screen. When an administrator has added, edited, deleted or
   imported accidents since, the page refreshes by itself: a page that registered
   onDataChange() redraws in place (the incident map keeps its filters that way); any other
   page reloads and returns to where the visitor had scrolled. */
const DATA_POLL_MS = 20000;
const DATA_SETTLE_MS = 6000;   // an import arrives in chunks; refresh once it has finished
const SCROLL_KEY = 'msLiveScroll';
let dataChangeHandler = null;

function onDataChange(handler) { dataChangeHandler = handler; }

function watchDataChanges() {
    let known = null;      // the version this page's figures were loaded at
    let pending = null;    // a newer version seen on the last check, not yet settled
    let busy = false;
    let timer = null;

    const schedule = ms => { clearTimeout(timer); timer = setTimeout(check, ms); };
    const typing = () => {
        const el = document.activeElement;
        return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
    };

    async function refresh() {
        if (dataChangeHandler) return (await dataChangeHandler()) !== false;
        try { sessionStorage.setItem(SCROLL_KEY, JSON.stringify({ path: location.pathname, y: window.scrollY })); } catch { /* storage off */ }
        location.reload();
        return true;
    }

    async function check() {
        if (busy || document.hidden) return schedule(DATA_POLL_MS);
        busy = true;
        try {
            const response = await fetch('/api/data-version', { cache: 'no-store' });
            const body = response.ok ? await response.json() : null;
            const version = body ? body.version : null;
            // Announcements and TPMO actions change no figures; the homepage cards (js/updates.js)
            // listen for this and redraw themselves without reloading the page.
            if (body && body.content !== undefined) {
                document.dispatchEvent(new CustomEvent('ms:content-version', { detail: body.content }));
            }
            if (version === null || version === undefined) return schedule(DATA_POLL_MS);
            if (known === null) { known = version; return schedule(DATA_POLL_MS); }
            if (version === known) { pending = null; return schedule(DATA_POLL_MS); }

            // Wait until the version stops moving, so a 10-chunk import refreshes once.
            if (version !== pending) { pending = version; return schedule(DATA_SETTLE_MS); }
            if (typing()) return schedule(DATA_SETTLE_MS);

            if (await refresh()) { known = version; pending = null; }
            schedule(DATA_POLL_MS);
        } catch {
            schedule(DATA_POLL_MS);   // offline for a moment; try again later
        } finally {
            busy = false;
        }
    }

    document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(0); });
    check();
}

// Back to where the visitor was before an automatic reload. The figures load after the
// page does, so the position is applied again once they have had a moment to render.
(() => {
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem(SCROLL_KEY) || 'null'); sessionStorage.removeItem(SCROLL_KEY); } catch { /* storage off */ }
    if (!saved || saved.path !== location.pathname) return;
    window.addEventListener('load', () => [300, 1200].forEach(ms => setTimeout(() => window.scrollTo(0, saved.y), ms)));
})();

// The profile page holds an edit form; the sign-in and support pages show no accident data.
if (!/(profile|login|support)\.html$/i.test(location.pathname)) {
    document.addEventListener('DOMContentLoaded', watchDataChanges);
}
