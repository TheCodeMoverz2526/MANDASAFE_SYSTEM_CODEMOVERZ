/* =========================================================
   MandaSafe — resident side shell, icons and formatters
   ========================================================= */

/* ---------------- SVG icon set ---------------- */
const ICONS = {
  logo:'<path d="M12 2C7.6 2 4 5.6 4 10c0 5.2 7 12 8 12s8-6.8 8-12c0-4.4-3.6-8-8-8z" fill="currentColor" opacity=".25"/><path d="M12 2C7.6 2 4 5.6 4 10c0 5.2 7 12 8 12s8-6.8 8-12c0-4.4-3.6-8-8-8zm0 11a3 3 0 110-6 3 3 0 010 6z" stroke="currentColor" stroke-width="1.6" fill="none"/>',
  home:'<path d="M3 10.5L12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
  plus:'<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8M8 12h8"/>',
  minus:'<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M8 12h8"/>',
  target:'<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/>',
  pin:'<path d="M12 21s7-6.2 7-11a7 7 0 10-14 0c0 4.8 7 11 7 11z"/><circle cx="12" cy="10" r="2.6"/>',
  clipboard:'<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1"/><path d="M9 10h6M9 14h6M9 18h3"/>',
  fire:'<path d="M12 3s5 4 5 8a5 5 0 11-10 0c0-2 1-3 1-3s.5 2 2 2c0-3 2-7 2-7z"/>',
  shield:'<path d="M12 3l7 3v6c0 4.4-3 7.9-7 9-4-1.1-7-4.6-7-9V6l7-3z"/><path d="M9.2 12.2l2 2 3.6-3.9"/>',
  megaphone:'<path d="M3 11v2a1 1 0 001 1h2l5 4V6L6 10H4a1 1 0 00-1 1z"/><path d="M16 9a4 4 0 010 6"/><path d="M19 6.5a8 8 0 010 11"/>',
  bell:'<path d="M18 15v-4a6 6 0 10-12 0v4l-1.5 3h15L18 15z"/><path d="M10 21h4"/>',
  user:'<circle cx="12" cy="8" r="3.6"/><path d="M4.5 20a7.5 7.5 0 0115 0"/>',
  users:'<circle cx="9" cy="8" r="3.2"/><path d="M2.8 19a6.2 6.2 0 0112.4 0"/><circle cx="17.5" cy="8.5" r="2.6"/><path d="M16 14.4a5.6 5.6 0 015.3 4.6"/>',
  info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  headset:'<path d="M4 13v-1a8 8 0 0116 0v1"/><rect x="2.6" y="13" width="4" height="6" rx="1.6"/><rect x="17.4" y="13" width="4" height="6" rx="1.6"/><path d="M19.4 19v.6a2.4 2.4 0 01-2.4 2.4h-3"/>',
  car:'<path d="M5 16.5h14M6.5 16.5V19H4.8v-2.5M17.5 16.5V19h1.7v-2.5"/><path d="M4 16.5v-4l2-4.5h12l2 4.5v4z"/><circle cx="8" cy="13.6" r="1.1" fill="currentColor" stroke="none"/><circle cx="16" cy="13.6" r="1.1" fill="currentColor" stroke="none"/>',
  alert:'<path d="M12 4l9 15.5H3L12 4z"/><path d="M12 10v4M12 17h.01"/>',
  cone:'<path d="M12 3l5 15H7L12 3z"/><path d="M4 21h16"/><path d="M9.2 12h5.6"/>',
  worker:'<circle cx="12" cy="5.4" r="2.2"/><path d="M8 21l2.2-6.6L8.6 12 6 14.5"/><path d="M12.4 10.2l2.6 2.2 3 .6"/><path d="M12.6 14.4L15 21"/>',
  dots:'<circle cx="7" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="17" cy="12" r="1.5" fill="currentColor" stroke="none"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5.2l3.2 1.9"/>',
  check:'<circle cx="12" cy="12" r="9"/><path d="M8.2 12.4l2.6 2.6L16 9.8"/>',
  checkOnly:'<path d="M4 12.5l5 5L20 6.5"/>',
  chart:'<path d="M4 20V9M10 20V4M16 20v-7M22 20H2"/>',
  trend:'<path d="M3 17l5.5-6 4 4L21 6"/><path d="M15 6h6v6"/>',
  map:'<path d="M9 4L3 6.5v13L9 17l6 2.5 6-2.5v-13L15 6.5 9 4z"/><path d="M9 4v13M15 6.5v13"/>',
  search:'<circle cx="11" cy="11" r="6.4"/><path d="M20 20l-3.6-3.6"/>',
  filter:'<path d="M3.5 5.5h17l-6.6 7.6V19l-3.8 2v-7.9L3.5 5.5z"/>',
  layers:'<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>',
  calendar:'<rect x="3.5" y="5" width="17" height="16" rx="2.5"/><path d="M8 3v4M16 3v4M3.5 10h17"/>',
  mail:'<rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="M3.6 7l8.4 6 8.4-6"/>',
  lock:'<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7.8a4 4 0 018 0v2.7"/>',
  eye:'<path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  login:'<path d="M14 3h4.5A1.5 1.5 0 0120 4.5v15a1.5 1.5 0 01-1.5 1.5H14"/><path d="M10 8l-4 4 4 4M6 12h9"/>',
  arrow:'<path d="M5 12h13M13 6.5l5.5 5.5L13 17.5"/>',
  phone:'<path d="M6 3.5h3l1.6 4-2 1.4a12 12 0 006.5 6.5l1.4-2 4 1.6v3a2 2 0 01-2.2 2A16.5 16.5 0 014 5.7 2 2 0 016 3.5z"/>',
  camera:'<rect x="3" y="7" width="18" height="13" rx="2.5"/><circle cx="12" cy="13.5" r="3.4"/><path d="M8.5 7l1.5-2.5h4L15.5 7"/>',
  edit:'<path d="M4 20h4l10-10-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/>',
  key:'<circle cx="8" cy="12" r="4"/><path d="M12 12h9M18 12v3.5M15.5 12v2.5"/>',
  copy:'<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5.5 15H5a1 1 0 01-1-1V5a1 1 0 011-1h9a1 1 0 011 1v.5"/>',
  logout:'<path d="M10 3H5.5A1.5 1.5 0 004 4.5v15A1.5 1.5 0 005.5 21H10"/><path d="M16 8l4 4-4 4M20 12H9"/>',
  file:'<path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5z"/><path d="M14 3v5h5"/>',
  wifi:'<path d="M5 12.5a10 10 0 0114 0"/><path d="M8.2 15.6a5.5 5.5 0 017.6 0"/><circle cx="12" cy="19" r="1.3" fill="currentColor" stroke="none"/>',
  google:''
};
function icon(name,cls){
  return '<svg class="'+(cls||'')+'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'+(ICONS[name]||'')+'</svg>';
}

/* ---------------- Severity / status meta ----------------
   These match what the RIMAS console stores: Fatal, Injury, Minor, Damage. */
const SEVERITY = {
    Fatal:  { color: '#dc2626', tag: 't-high',  icon: 'alert' },
    Injury: { color: '#eab308', tag: 't-med',   icon: 'car' },
    Minor:  { color: '#16a34a', tag: 't-low',   icon: 'car' },
    Damage: { color: '#16a34a', tag: 't-review', icon: 'cone' }
};
function sevMeta(sev) { return SEVERITY[sev] || { color: '#8b5cf6', tag: 't-review', icon: 'dots' }; }

const STATUS_TAG = { active: 't-process', resolved: 't-resolved', pending: 't-review' };
function statusTag(status) { return STATUS_TAG[status] || 't-review'; }

// Red / yellow / green, the same three levels the maps colour by.
const RISK_TAG = { high: 't-high', medium: 't-med', low: 't-low' };
const RISK_LABEL = { high: 'High', medium: 'Moderate', low: 'Low' };

/* ---------------- Shell ---------------- */
const NAV = [
    { id: 'dashboard', label: 'Dashboard',     icon: 'home',   href: 'dashboard.html' },
    { id: 'map',       label: 'Accident Map',  icon: 'pin',    href: 'incident-map.html' },
    { id: 'hotspots',  label: 'Hotspots',      icon: 'fire',   href: 'hotspots.html' },
    { id: 'forecast',  label: 'Forecast',      icon: 'trend',  href: 'forecast.html' },
    { id: 'safety',    label: 'Safety Index',  icon: 'shield', href: 'safety-index.html' },
    { id: 'profile',   label: 'My Account',    icon: 'user',   href: 'profile.html' }
];
const NAV_SUPPORT = [
    { id: 'about',   label: 'About Us',        icon: 'info',   href: 'about.html' },
    { id: 'support', label: 'Contact Support', icon: 'headset', href: 'support.html' }
];

/* ---------------- navigation drawer ----------------
   The hamburger means two things, because the sidebar starts from two different
   places. On a wide screen the navigation is pinned open, so the button collapses
   it: it slides off to the left and the page spreads into the freed width. Below
   1024px the sidebar is already off-canvas, so the button opens it over the page.

   The resident side is a set of separate pages rather than one app, so the
   collapsed state is remembered in localStorage — otherwise every link would push
   the sidebar back open. */
const NAV_COLLAPSE_KEY = 'mandasafeNavCollapsed';

function isNarrow() { return window.matchMedia('(max-width:1024px)').matches; }

function navCollapsePreferred() {
    try { return localStorage.getItem(NAV_COLLAPSE_KEY) === '1'; } catch { return false; }
}

function applyNavState() {
    // Narrow layout: the drawer is off-canvas already and 'nav-open' is the one that
    // matters. Leave it alone — mobile browsers fire resize while scrolling, and
    // clearing it here would snap the open drawer shut under the reader's finger.
    if (isNarrow()) {
        document.body.classList.remove('nav-collapsed');
        return;
    }
    document.body.classList.remove('nav-open');
    document.body.classList.toggle('nav-collapsed', navCollapsePreferred());
}

/* Leaflet sizes its canvas to the container it was given, so a map that was on the
   page while the sidebar moved is left with stale dimensions. Leaflet re-measures on
   a window resize (trackResize), so one event after the slide finishes is enough. */
function notifyLayoutChanged() {
    setTimeout(() => window.dispatchEvent(new Event('resize')), 280);
}

function wireNav() {
    applyNavState();

    document.getElementById('ms-burger').onclick = () => {
        if (isNarrow()) {
            document.body.classList.toggle('nav-open');
            return;
        }
        const collapsed = document.body.classList.toggle('nav-collapsed');
        try { localStorage.setItem(NAV_COLLAPSE_KEY, collapsed ? '1' : '0'); } catch { /* private mode */ }
        notifyLayoutChanged();
    };

    document.getElementById('ms-backdrop').onclick = () => document.body.classList.remove('nav-open');

    // Crossing the breakpoint (rotating a tablet, resizing a window) must not leave the
    // page holding the class that belongs to the other layout.
    window.addEventListener('resize', applyNavState);
}

function buildShell(active) {
    const u = currentUser() || { name: 'Resident', role: 'user' };
    const initials = u.avatar || u.name.split(' ').map(s => s[0]).slice(0, 2).join('').toUpperCase();

    const adminLink = u.role === 'admin'
        ? '<a class="nav-item" href="Mandasafe.html" style="background:rgba(249,115,22,.18);color:#ffd9bd">' +
          icon('shield') + '<span>Admin Console</span></a>'
        : '';

    const topbar =
      '<header class="topbar">' +
        '<button class="hamburger" id="ms-burger" aria-label="Toggle menu">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>' +
        '</button>' +
        '<a class="brand" href="dashboard.html">' +
          '<img class="brand-logo" src="assets/logo-192.png" alt="MandaSafe logo">' +
          '<span><span class="brand-name">Manda<span>Safe</span></span>' +
          '<span class="brand-sub" style="display:block">Road Accident Mapping &amp; Analytics System</span></span>' +
        '</a>' +
        '<div class="topbar-actions">' +
          '<span class="pill" id="ms-live" title="Data source"><span class="live"></span> Live data</span>' +
          '<div class="alerts-wrap">' +
            '<button type="button" class="bell" id="ms-bell" aria-label="Notifications" aria-expanded="false" aria-controls="ms-alerts">' +
              icon('bell') + '<span class="dot" id="ms-bell-dot" hidden></span>' +
            '</button>' +
            '<div class="alerts-panel" id="ms-alerts" hidden>' +
              '<div class="alerts-head">Notifications</div>' +
              '<div class="alerts-list" id="ms-alerts-list"><div class="empty">Loading…</div></div>' +
            '</div>' +
          '</div>' +
          '<div class="userchip is-static" id="ms-userchip">' +
            '<span class="avatar">' + initials + '</span>' +
            '<span><span class="nm">' + u.name + '</span>' +
            '<span class="rl" style="display:block">' + (u.role === 'admin' ? 'Administrator' : 'Resident') + '</span></span>' +
          '</div>' +
        '</div>' +
      '</header>';

    const item = n => '<a class="nav-item' + (n.id === active ? ' active' : '') + '" href="' + n.href + '">' +
        icon(n.icon) + '<span>' + n.label + '</span></a>';

    const sidebar =
      '<aside class="sidebar">' +
        '<div class="nav-label">NAVIGATION</div>' + NAV.map(item).join('') + adminLink +
        '<div class="nav-sep"></div>' +
        '<div class="nav-label">SUPPORT</div>' + NAV_SUPPORT.map(item).join('') +
        '<div class="nav-sep"></div>' +
        '<button type="button" class="nav-item nav-signout" id="ms-signout">' + icon('logout') + '<span>Sign Out</span></button>' +
        '<div class="side-card">' +
          '<img class="seal" src="assets/logo-192.png" alt="MandaSafe logo">' +
          '<p>Mandaluyong City<br>Traffic Planning and<br>Management Office</p>' +
        '</div>' +
        '<div class="side-copy">&copy; 2026 All rights reserved.</div>' +
      '</aside><div class="backdrop" id="ms-backdrop"></div>';

    // Styled sign-out confirmation, in place of the browser's plain confirm() pop-up.
    const signOutDialog =
      '<div class="ms-modal" id="ms-signout-modal" role="dialog" aria-modal="true" aria-labelledby="ms-signout-title" hidden>' +
        '<div class="ms-modal-card">' +
          '<span class="ms-modal-ic">' + icon('logout') + '</span>' +
          '<h3 id="ms-signout-title">Sign out of MandaSafe?</h3>' +
          '<p>You will need to sign in again to see the dashboard, maps and forecasts.</p>' +
          '<div class="ms-modal-actions">' +
            '<button type="button" class="ms-btn ms-btn-ghost" id="ms-signout-cancel">Cancel</button>' +
            '<button type="button" class="ms-btn ms-btn-danger" id="ms-signout-confirm">Sign Out</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    document.body.insertAdjacentHTML('afterbegin', topbar + sidebar + signOutDialog);
    wireNav();
    wireSignOut();
    wireAlerts();
    document.querySelectorAll('[data-i]').forEach(el => el.insertAdjacentHTML('afterbegin', icon(el.dataset.i)));
}

/* ---------------- notification bell ----------------
   New accident reports and new hotspots, from /api/alerts. Checked on load, every 30
   seconds while the tab is visible, and on returning to the tab. Opening the panel marks
   everything as seen for this account (the badge clears on every device).

   A toast announces an item only once: the highest id already announced is remembered,
   so moving between pages does not repeat it. */
const ALERTS_TOASTED_KEY = 'mandasafeAlertsToasted';
const ALERT_ICONS = { incident_added: 'car', hotspot_new: 'fire' };

function timeAgo(iso) {
    const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (!Number.isFinite(seconds)) return '';
    if (seconds < 60) return 'just now';
    const units = [[86400 * 7, 'w'], [86400, 'd'], [3600, 'h'], [60, 'min']];
    for (const [size, label] of units) {
        if (seconds >= size) return Math.floor(seconds / size) + ' ' + label + ' ago';
    }
    return '';
}

function wireAlerts() {
    const bell = document.getElementById('ms-bell');
    const dot = document.getElementById('ms-bell-dot');
    const panel = document.getElementById('ms-alerts');
    const list = document.getElementById('ms-alerts-list');
    let feed = null;

    const showBadge = count => {
        dot.hidden = count <= 0;
        dot.textContent = count > 9 ? '9+' : String(count);
        bell.setAttribute('aria-label', count > 0 ? `Notifications, ${count} unread` : 'Notifications');
    };

    const render = () => {
        if (!feed.items.length) {
            list.innerHTML = '<div class="empty">No notifications yet. New accident reports and hotspots will appear here.</div>';
            return;
        }
        list.innerHTML = feed.items.map(n =>
            `<a class="alert-item${n.unread ? ' is-unread' : ''}" href="${esc(n.link || '#')}">` +
              `<span class="alert-ic ${n.type === 'hotspot_new' ? 'is-hot' : ''}">${icon(ALERT_ICONS[n.type] || 'bell')}</span>` +
              `<span class="alert-body"><span class="alert-title">${esc(n.title)}</span>` +
              `<span class="alert-desc">${esc(n.desc || '')}</span>` +
              `<span class="alert-time">${esc(timeAgo(n.createdAt))}</span></span>` +
            '</a>').join('');
    };

    const announceNew = () => {
        let toasted = null;
        try { toasted = localStorage.getItem(ALERTS_TOASTED_KEY); } catch { /* private mode */ }
        // First visit on this browser: nothing is "new" yet, only remember where we are.
        const fresh = toasted === null ? [] : feed.items.filter(n => n.unread && n.id > Number(toasted));
        if (fresh.length) toast(fresh.length === 1 ? fresh[0].title : `${fresh.length} new notifications`, 'bell');
        try { localStorage.setItem(ALERTS_TOASTED_KEY, String(feed.latest)); } catch { /* private mode */ }
    };

    const load = async () => {
        try { feed = await API.alerts(); }
        catch { return; }   // the bell is extra; a failed check just waits for the next one
        showBadge(feed.unread);
        render();
        announceNew();
    };

    const close = () => { panel.hidden = true; bell.setAttribute('aria-expanded', 'false'); };
    bell.onclick = event => {
        event.stopPropagation();
        if (!panel.hidden) { close(); return; }
        panel.hidden = false;
        bell.setAttribute('aria-expanded', 'true');
        if (feed && feed.unread > 0) {
            showBadge(0);
            feed.unread = 0;
            API.alertsSeen().catch(() => { /* shown as unread again on the next check */ });
        }
    };
    document.addEventListener('click', event => { if (!panel.hidden && !panel.contains(event.target)) close(); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && !panel.hidden) close(); });

    load();
    setInterval(() => { if (!document.hidden) load(); }, 30000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
}

function wireSignOut() {
    const modal = document.getElementById('ms-signout-modal');
    const confirmBtn = document.getElementById('ms-signout-confirm');
    const open = () => { modal.hidden = false; confirmBtn.focus(); };
    const close = () => { modal.hidden = true; };

    document.getElementById('ms-signout').onclick = open;
    document.getElementById('ms-signout-cancel').onclick = close;
    modal.addEventListener('click', e => { if (e.target === modal) close(); });   // click outside the card
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !modal.hidden) close(); });
    confirmBtn.onclick = () => {
        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Signing out…';
        logout();
    };
}

/* ---------------- formatting ---------------- */
function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso + 'T00:00:00');
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
}
function fmtMonth(key) {
    const [y, m] = String(key).split('-');
    return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}
function fmtTime(value) {
    if (!value) return '';
    const parsed = new Date('2000-01-01 ' + value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}
function num(value) { return Number(value || 0).toLocaleString(); }
function esc(value) {
    return String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]);
}
function countUp(el, target) {
    if (!el) return;
    const duration = 800, start = performance.now();
    const step = now => {
        const p = Math.min((now - start) / duration, 1);
        el.textContent = Math.round(target * (1 - Math.pow(1 - p, 3))).toLocaleString();
        if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
}
function liveClock(el) {
    if (!el) return;
    const tick = () => {
        const d = new Date();
        el.textContent = d.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }) + '   ' +
                         d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    };
    tick(); setInterval(tick, 30000);
}
function toast(msg, iconName) {
    let t = document.querySelector('.toast');
    if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
    t.innerHTML = icon(iconName || 'checkOnly') + '<span>' + esc(msg) + '</span>';
    requestAnimationFrame(() => t.classList.add('show'));
    clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 3200);
}

/* Simple inline bar chart (no chart library on the resident side). */
function barChart(el, rows, opts = {}) {
    if (!el) return;
    const max = Math.max(1, ...rows.map(r => r.value));
    el.innerHTML = rows.map(r => `
        <div class="chart-row" title="${esc(r.label)}: ${num(r.value)}">
            <span class="chart-label">${esc(r.label)}</span>
            <span class="chart-track"><i style="width:${(r.value / max) * 100}%;background:${r.color || 'var(--blue-500)'}"></i></span>
            <span class="chart-value">${num(r.value)}</span>
        </div>`).join('') || '<div class="empty">No data yet.</div>';
    if (opts.footer) el.insertAdjacentHTML('beforeend', `<p class="hint" style="margin-top:10px">${opts.footer}</p>`);
}
