let currentUser = null;
const SESSION_KEY = 'rimasCurrentUser';

function applyDashboardUser(acc) {
    const avatar = document.getElementById('avatarBtn');
    const name = document.getElementById('profileName');
    const email = document.getElementById('profileEmail');
    const badge = document.getElementById('profileRoleBadge');
    const adminLink = document.getElementById('adminPanelLink');
    if (avatar) avatar.textContent = acc.avatar;
    const chipName = document.getElementById('chipName');
    const chipRole = document.getElementById('chipRole');
    if (chipName) chipName.textContent = acc.name;
    if (chipRole) chipRole.textContent = acc.role === 'admin' ? 'Administrator' : 'Resident';
    if (name) name.textContent = acc.name;
    if (email) email.textContent = acc.email;
    if (badge) badge.innerHTML = acc.role === 'admin'
        ? '<span class="admin-badge"><i class="fas fa-shield-alt"></i> Administrator</span>'
        : '<span class="user-badge"><i class="fas fa-user"></i> User</span>';
    if (adminLink) adminLink.style.display = acc.role === 'admin' ? 'flex' : 'none';
    document.querySelectorAll('.admin-only').forEach(el => el.style.display = acc.role === 'admin' ? 'flex' : 'none');
    const welcome = document.getElementById('dashWelcome');
    if (welcome) welcome.textContent = `Welcome, ${acc.name.split(' ')[0]} 👋`;
}

async function restoreDashboardSession() {
    const savedUser = localStorage.getItem(SESSION_KEY);
    if (!savedUser || !localStorage.getItem(TOKEN_KEY)) return window.location.replace('login.html?as=admin');

    try {
        currentUser = JSON.parse(savedUser);
    } catch {
        localStorage.removeItem(SESSION_KEY);
        localStorage.removeItem(TOKEN_KEY);
        return window.location.replace('login.html?as=admin');
    }

    // Render immediately from the stored session, then confirm it against the database.
    // The server's copy is authoritative for the role, so a user cannot grant themselves
    // admin tools by editing their own browser storage.
    applyDashboardUser(currentUser);
    showPage('home');

    try {
        const account = await api.getMe();
        // Residents have their own read-only pages — only administrators use this console.
        if (account.role !== 'admin') return window.location.replace('dashboard.html');
        currentUser = { ...currentUser, ...account };
        localStorage.setItem(SESSION_KEY, JSON.stringify(currentUser));
        applyDashboardUser(currentUser);
    } catch (error) {
        console.error('Session check failed:', error);
        return;
    }

    loadIncidentsFromServer();
    loadNotifications().then(startNotificationPolling);
}

async function doLogout() {
    try { await api.logout(); } catch { /* signing out locally is enough */ }
    currentUser = null;
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(TOKEN_KEY);
    // replace, not assign: the console is taken out of the history, so Back can't reach it.
    window.location.replace('login.html?as=admin');
}

/* Once signed out, the console must not come back until the person signs in again:
   - the Back button can restore this page from the browser's memory without running any
     of its scripts again, so the check is repeated whenever the page is shown;
   - signing out in another tab clears the shared storage, which every open tab hears. */
function signedOutBounce() {
    if (localStorage.getItem(SESSION_KEY) && localStorage.getItem(TOKEN_KEY)) return;
    document.documentElement.style.visibility = 'hidden';
    window.location.replace('login.html?as=admin');
}
window.addEventListener('pageshow', signedOutBounce);
window.addEventListener('storage', event => {
    if (event.key === null || event.key === TOKEN_KEY || event.key === SESSION_KEY) signedOutBounce();
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) signedOutBounce(); });

function toggleProfileDropdown() {
    document.getElementById('profileDropdown').classList.toggle('open');
}

document.addEventListener('click', (e) => {
    const dd = document.getElementById('profileDropdown');
    const btn = document.getElementById('accountChip');
    if (dd && !dd.contains(e.target) && btn && !btn.contains(e.target)) dd.classList.remove('open');
    const srd = document.getElementById('searchResultsDropdown');
    const search = document.getElementById('globalSearch');
    if (srd && !srd.contains(e.target) && search && !search.contains(e.target)) srd.classList.remove('open');
});

// ===== API / BACKEND =====
// Every request carries the session token issued at sign-in. The server uses it to decide
// who is asking: administrators may write, users may only read.
const TOKEN_KEY = 'rimasToken';
function authToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
function isAdmin() { return currentUser?.role === 'admin'; }

async function apiRequest(path, options = {}) {
    let response;
    try {
        response = await fetch(path, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                ...(authToken() ? { Authorization: `Bearer ${authToken()}` } : {}),
                ...(options.headers || {})
            }
        });
    } catch (error) {
        throw new Error('Cannot reach the RIMAS server. Is start-mandasafe.bat running?');
    }
    let data = null;
    try { data = await response.json(); } catch { /* no body */ }
    if (response.status === 401) {
        // Session expired or was revoked — back to the sign-in page.
        localStorage.removeItem(SESSION_KEY);
        localStorage.removeItem(TOKEN_KEY);
        window.location.replace('login.html?as=admin');
        throw new Error('Your session has expired. Please sign in again.');
    }
    if (response.status === 403) throw new Error((data && data.error) || 'Administrator access is required for this action.');
    if (!response.ok) throw new Error((data && data.error) || `Request failed (${response.status})`);
    return data;
}
const api = {
    getIncidents: () => apiRequest('/api/incidents'),
    createIncident: (body) => apiRequest('/api/incidents', { method: 'POST', body: JSON.stringify(body) }),
    bulkCreateIncidents: (records) => apiRequest('/api/incidents/bulk', { method: 'POST', body: JSON.stringify({ records }) }),
    updateIncident: (id, body) => apiRequest(`/api/incidents/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) }),
    deleteIncident: (id) => apiRequest(`/api/incidents/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    getPredictionInputs: () => apiRequest('/api/prediction-inputs'),
    createPredictionInput: (body) => apiRequest('/api/prediction-inputs', { method: 'POST', body: JSON.stringify(body) }),
    updatePredictionInput: (id, body) => apiRequest(`/api/prediction-inputs/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) }),
    deletePredictionInput: (id) => apiRequest(`/api/prediction-inputs/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    getPredictions: () => apiRequest('/api/predictions'),
    // Server-computed figures shared with the resident pages: monthly/hourly counts, the
    // Safety Index, and which fields are actually recorded.
    getSummary: () => apiRequest('/api/summary'),
    getStats: () => apiRequest('/api/stats'),
    getHotspots: () => apiRequest('/api/hotspots'),
    getMe: () => apiRequest('/api/auth/me'),
    logout: () => apiRequest('/api/auth/logout', { method: 'POST' }),
    getAccounts: () => apiRequest('/api/accounts'),
    createAccount: (body) => apiRequest('/api/accounts', { method: 'POST', body: JSON.stringify(body) }),
    updateAccount: (id, body) => apiRequest(`/api/accounts/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) }),
    deleteAccount: (id) => apiRequest(`/api/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    getNotifications: () => apiRequest('/api/notifications'),
    pollNotifications: (after) => apiRequest(`/api/notifications/poll?after=${encodeURIComponent(after)}`),
    markNotificationRead: (id) => apiRequest(`/api/notifications/${encodeURIComponent(id)}/read`, { method: 'PUT' }),
    markAllNotificationsRead: () => apiRequest('/api/notifications/read-all', { method: 'POST' })
};

// ===== DATA =====
let incidents = [];

let filteredIncidents = incidents.slice();
let editingIndex = -1; // -1 = adding new, otherwise editing incidents[editingIndex]

async function loadIncidentsFromServer() {
    try {
        incidents = await api.getIncidents();
    } catch (error) {
        console.error('Failed to load accidents from server:', error);
        incidents = [];
        showToast('⚠️ ' + error.message);
    }
    filteredIncidents = incidents.slice();
    populateIncidentFilterOptions();
    renderTable();
    updateHomeStats();
    renderDashRecent();
    if (document.getElementById('page-home')?.classList.contains('active')) initDashCharts();
    if (mandaluyongMapReady) renderMandaluyongMapLayers();
    return incidents;
}

// KDE (Kernel Density Estimation) hotspots, recomputed server-side from all incident
// locations whenever this is called — cached here so the map can redraw on filter changes
// without re-fetching.
let hotspotsCache = [];
async function loadHotspotsFromServer() {
    try {
        hotspotsCache = await api.getHotspots();
    } catch (error) {
        console.error('Failed to load hotspots from server:', error);
        hotspotsCache = [];
    }
    if (mandaluyongMapReady) renderMandaluyongMapLayers();
    return hotspotsCache;
}

// ===== ADMIN: PREDICTION DATA MANAGEMENT =====
let predictionInputs = [];
let editingPredictionInputId = null;

async function loadPredictionAdminPage() {
    const tableBody = document.getElementById('predictionInputsTableBody');
    if (!tableBody) return;
    tableBody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--gray-400);padding:24px;"><i class="fas fa-spinner fa-spin"></i> Loading…</td></tr>`;
    try {
        predictionInputs = await api.getPredictionInputs();
    } catch (error) {
        tableBody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:#dc2626;padding:24px;"><i class="fas fa-triangle-exclamation"></i> ${error.message}</td></tr>`;
        return;
    }
    if (!predictionInputs.length) {
        tableBody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--gray-400);padding:24px;">No prediction data yet. Click <strong>Add Data Entry</strong> to enter the first baseline figures.</td></tr>`;
        return;
    }
    tableBody.innerHTML = predictionInputs.map(entry => `
        <tr>
            <td>${escapeMapHtml(entry.barangay)}</td>
            <td>${escapeMapHtml(entry.road || 'All Roads')}</td>
            <td>${escapeMapHtml(entry.month)}</td>
            <td>${entry.incidentCount}</td>
            <td style="font-size:12px;color:var(--gray-500);">${escapeMapHtml(entry.notes || '—')}</td>
            <td style="font-size:12px;color:var(--gray-500);">${new Date(entry.updatedAt).toLocaleString()}</td>
            <td><div style="display:flex;gap:4px;">
                <button class="btn btn-secondary btn-sm" onclick="openPredictionInputModal('${entry.id}')"><i class="fas fa-edit"></i></button>
                <button class="btn btn-sm" style="background:#fef2f2;color:#dc2626;border:1px solid #fecaca;" onclick="deletePredictionInput('${entry.id}')"><i class="fas fa-trash"></i></button>
            </div></td>
        </tr>`).join('');
}

function openPredictionInputModal(id = null) {
    editingPredictionInputId = id;
    const entry = id ? predictionInputs.find(item => item.id === id) : null;
    document.getElementById('predictionInputModalTitle').textContent = entry ? 'Edit Prediction Data' : 'Add Prediction Data';
    document.getElementById('predInputId').value = id || '';
    document.getElementById('predInputBarangay').value = entry?.barangay || '';
    document.getElementById('predInputRoad').value = entry?.road && entry.road !== 'All Roads' ? entry.road : '';
    document.getElementById('predInputMonth').value = entry?.month || '';
    document.getElementById('predInputCount').value = entry ? entry.incidentCount : '';
    document.getElementById('predInputNotes').value = entry?.notes || '';
    document.getElementById('predictionInputModal').classList.add('open');
}
function closePredictionInputModal() { document.getElementById('predictionInputModal').classList.remove('open'); }

async function savePredictionInput() {
    const barangay = document.getElementById('predInputBarangay').value.trim();
    const road = document.getElementById('predInputRoad').value.trim();
    const month = document.getElementById('predInputMonth').value;
    const incidentCount = document.getElementById('predInputCount').value;
    const notes = document.getElementById('predInputNotes').value.trim();

    if (!barangay || !month || incidentCount === '') {
        showToast('⚠️ Barangay, month, and accident count are required.');
        return;
    }

    const payload = { barangay, road: road || 'All Roads', month, incidentCount: Number(incidentCount), notes, updatedBy: currentUser?.name || 'admin' };
    const saveBtn = document.getElementById('predictionInputSaveBtn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.dataset.originalText = saveBtn.innerHTML; saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving…'; }

    try {
        if (editingPredictionInputId) {
            await api.updatePredictionInput(editingPredictionInputId, payload);
            showToast('✅ Prediction data updated.');
        } else {
            await api.createPredictionInput(payload);
            showToast('✅ Prediction data added.');
        }
        closePredictionInputModal();
        await loadPredictionAdminPage();
        refreshPredictionViews();
    } catch (error) {
        showToast('❌ ' + error.message);
    } finally {
        if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = saveBtn.dataset.originalText; }
    }
}

async function deletePredictionInput(id) {
    if (!confirm('Delete this prediction data entry? This will affect future predictions.')) return;
    try {
        await api.deletePredictionInput(id);
        showToast('🗑️ Prediction data deleted.');
        await loadPredictionAdminPage();
        refreshPredictionViews();
    } catch (error) {
        showToast('❌ ' + error.message);
    }
}

function refreshPredictionViews() {
    if (document.getElementById('page-hotspot')?.classList.contains('active')) initHotspotCharts();
    if (document.getElementById('page-safety')?.classList.contains('active')) initSafetyCharts();
    if (document.getElementById('page-predictdata')?.classList.contains('active')) loadPredictionAdminPage();
}

/* Filter choices come from the records themselves, so every option matches something. */
function populateIncidentFilterOptions() {
    const fill = (id, values) => {
        const select = document.getElementById(id);
        if (!select) return;
        const current = select.value;
        select.innerHTML = select.firstElementChild.outerHTML
            + values.map(v => `<option value="${escapeMapHtml(v)}">${escapeMapHtml(v)}</option>`).join('');
        select.value = values.includes(current) ? current : 'all';
    };
    const distinct = key => [...new Set(incidents.map(r => r[key]).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    fill('fltBarangay', distinct('barangay'));
    fill('fltRoad', distinct('road'));
    fill('fltVehicle', distinct('type'));
    fill('mapFltType', distinct('type'));
}

/* "Latest N months" counts back from the newest record, not from today, so the choice
   always has records in it even when the data stops some time ago. */
function latestMonthsCutoff(months) {
    const newest = incidents.reduce((max, r) => (String(r.date || '') > max ? String(r.date) : max), '');
    if (!newest) return '';
    const [y, m] = newest.slice(0, 7).split('-').map(Number);
    const start = new Date(y, m - months, 1);
    return `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-01`;
}

function applyIncidentFilters() {
    const dr = document.getElementById('fltDateRange').value;
    const brgy = document.getElementById('fltBarangay').value;
    const road = document.getElementById('fltRoad').value;
    const sev = document.getElementById('fltSeverity').value;
    const type = document.getElementById('fltVehicle').value;
    const from = dr === 'all' ? '' : latestMonthsCutoff(Number(dr));

    filteredIncidents = incidents.filter(r => {
        if (brgy !== 'all' && r.barangay !== brgy) return false;
        if (road !== 'all' && r.road !== road) return false;
        if (sev !== 'all' && r.sev !== sev) return false;
        if (type !== 'all' && r.type !== type) return false;
        if (from && String(r.date || '') < from) return false;
        return true;
    });
    renderTable();
    showToast(`🔍 Filter applied — ${filteredIncidents.length} result${filteredIncidents.length !== 1 ? 's' : ''}`);
}

function resetIncidentFilters() {
    document.getElementById('fltDateRange').value = 'all';
    document.getElementById('fltBarangay').value = 'all';
    document.getElementById('fltRoad').value = 'all';
    document.getElementById('fltSeverity').value = 'all';
    document.getElementById('fltVehicle').value = 'all';
    filteredIncidents = incidents.slice();
    renderTable();
    showToast('↺ Filters reset');
}

/* ===== ACCIDENT RECORDS TABLE — one scrolling list =====
   No pages: the table scrolls. Drawing all ~8,000 rows at once would freeze the page for a
   moment, so rows are added in batches as the list nears its bottom — it still reads as one
   continuous list. The header row stays pinned while scrolling. */
const TABLE_BATCH = 100;
let tableRendered = 0;       // rows currently in the DOM
let tableIndexOf = new Map(); // record -> its index in `incidents`, for the row buttons

/* The scroll box fills the window below its own top edge. */
function sizeIncidentScroll() {
    const box = document.getElementById('incidentScroll');
    if (!box || !box.offsetParent) return;
    const BOTTOM_GAP = 24;
    const available = window.innerHeight - box.getBoundingClientRect().top - BOTTOM_GAP;
    box.style.maxHeight = Math.max(260, available) + 'px';
}

function incidentRowHtml(r) {
    const realIdx = tableIndexOf.get(r);
    return `
                <tr>
                    <td><span class="incident-id" onclick="openDetailModal(${realIdx})">${r.id}</span></td>
                    <td>${r.date}</td><td>${r.time}</td><td>${r.loc}</td><td>${r.barangay}</td><td>${r.road}</td>
                    <td>${getSevBadge(r.sev)}</td><td style="font-size:12px;">${r.type}</td>
                    <td><div style="display:flex;gap:4px;">
                        <button class="btn btn-secondary btn-sm" onclick="openDetailModal(${realIdx})"><i class="fas fa-eye"></i></button>
                        ${isAdmin() ? `<button class="btn btn-secondary btn-sm" onclick="openEditModal(${realIdx})"><i class="fas fa-edit"></i></button>
                        <button class="btn btn-sm" style="background:#fef2f2;color:#dc2626;border:1px solid #fecaca;" onclick="askDelete(${realIdx})"><i class="fas fa-trash"></i></button>` : ''}
                    </div></td>
                </tr>
            `;
}

function updateTableCountLabel() {
    const countLabel = document.getElementById('incidentCountLabel');
    const total = filteredIncidents.length;
    if (!countLabel) return;
    countLabel.textContent = total > tableRendered
        ? `${total.toLocaleString()} entries · scroll for more`
        : `${total.toLocaleString()} ${total === 1 ? 'entry' : 'entries'}`;
}

/* Adds the next batch of rows, if any are left. */
function appendTableRows() {
    const tbody = document.getElementById('incidentTableBody');
    if (!tbody || tableRendered >= filteredIncidents.length) return;
    const next = filteredIncidents.slice(tableRendered, tableRendered + TABLE_BATCH);
    tbody.insertAdjacentHTML('beforeend', next.map(incidentRowHtml).join(''));
    tableRendered += next.length;
    updateTableCountLabel();
}

/* Redraws from the first row. Pass true to keep the rows already loaded and the scroll
   position (used on resize and when coming back to the page). */
function renderTable(keepPosition = false) {
    const tbody = document.getElementById('incidentTableBody');
    if (!tbody) return;
    const box = document.getElementById('incidentScroll');
    const keepCount = keepPosition ? Math.max(TABLE_BATCH, tableRendered) : TABLE_BATCH;
    const keepTop = keepPosition && box ? box.scrollTop : 0;

    tableIndexOf = new Map(incidents.map((r, i) => [r, i]));
    sizeIncidentScroll();

    const rows = filteredIncidents.slice(0, keepCount);
    tbody.innerHTML = rows.map(incidentRowHtml).join('')
        || `<tr><td colspan="9" style="text-align:center;color:var(--gray-400);padding:24px;">No accidents match your filters.</td></tr>`;
    tableRendered = rows.length;
    if (box) box.scrollTop = keepTop;
    updateTableCountLabel();
    updateHomeStats();
}

(function wireIncidentScroll() {
    const box = document.getElementById('incidentScroll');
    if (!box) return;
    box.addEventListener('scroll', () => {
        // Load the next batch while the reader is still ~600px from the end.
        if (box.scrollTop + box.clientHeight >= box.scrollHeight - 600) appendTableRows();
    }, { passive: true });
})();

let _resizeIncidentTimer = null;
window.addEventListener('resize', () => {
    clearTimeout(_resizeIncidentTimer);
    _resizeIncidentTimer = setTimeout(() => {
        if (document.getElementById('page-incidents')?.classList.contains('active')) sizeIncidentScroll();
    }, 200);
});

function getSevBadge(sev) {
    const map = { 'Fatal': 'sev-fatal', 'Injury': 'sev-injury', 'Minor': 'sev-minor', 'Damage': 'sev-damage' };
    return `<span class="sev ${map[sev] || 'sev-damage'}"><span class="sev-dot"></span>${sev}</span>`;
}

// ===== GLOBAL SEARCH =====
function handleGlobalSearch(q) {
    const dd = document.getElementById('searchResultsDropdown');
    if (!q || !q.trim()) { dd.classList.remove('open'); dd.innerHTML = ''; return; }
    const term = q.trim().toLowerCase();
    const results = incidents.filter(r =>
        r.id.toLowerCase().includes(term) ||
        r.barangay.toLowerCase().includes(term) ||
        r.road.toLowerCase().includes(term) ||
        r.type.toLowerCase().includes(term) ||
        r.sev.toLowerCase().includes(term)
    ).slice(0, 8);
    if (!results.length) {
        dd.innerHTML = `<div class="search-empty">No accidents found for "${q}"</div>`;
    } else {
        dd.innerHTML = results.map(r => {
            const idx = incidents.indexOf(r);
            return `<div class="search-result-item" onclick="jumpToIncident(${idx})"><strong>${r.id}</strong> — ${r.road}, ${r.barangay} <span style="float:right;">${getSevBadge(r.sev)}</span></div>`;
        }).join('');
    }
    dd.classList.add('open');
}
function jumpToIncident(idx) {
    document.getElementById('searchResultsDropdown').classList.remove('open');
    document.getElementById('globalSearch').value = '';
    showPage('incidents');
    setTimeout(() => openDetailModal(idx), 150);
}

// ===== NAVIGATION =====
const pages = ['home', 'incidents', 'map', 'hotspot', 'forecast', 'safety', 'analytics', 'reports', 'users', 'notifications', 'settings', 'predictdata'];
function showPage(page) {
    pages.forEach(p => {
        document.getElementById('page-' + p)?.classList.toggle('active', p === page);
        const sb = document.getElementById('sb-' + p); if (sb) sb.classList.toggle('active', p === page);
        const nav = document.getElementById('nav-' + p); if (nav) nav.classList.toggle('active', p === page);
    });
    if (page === 'analytics') setTimeout(initAnalyticsCharts, 100);
    if (page === 'reports') setTimeout(generateReport, 100);
    if (page === 'hotspot') setTimeout(initHotspotCharts, 100);
    if (page === 'forecast') setTimeout(initForecastPage, 100);
    if (page === 'safety') setTimeout(initSafetyCharts, 100);
    if (page === 'home') { setTimeout(initDashCharts, 100); renderDashRecent(); }
    if (page === 'incidents') renderTable(true);
    if (page === 'users') renderUserTable();
    if (page === 'notifications') renderNotifications();
    if (page === 'settings') populateSettings();
    if (page === 'predictdata') loadPredictionAdminPage();
    if (page === 'map') { setTimeout(initMandaluyongMap, 0); loadIncidentsFromServer(); loadHotspotsFromServer(); }
}

// ===== MODALS =====
function openModal() {
    editingIndex = -1;
    document.getElementById('incidentModalTitle').textContent = 'Add Road Accident';
    document.getElementById('incIdField').value = 'Auto Generated';
    document.getElementById('incDate').value = '2024-04-15';
    document.getElementById('incTime').value = '14:45';
    document.getElementById('incType').value = 'Vehicular Collision';
    document.getElementById('incBarangay').value = 'Plainview';
    document.getElementById('incRoad').value = 'Shaw Blvd';
    document.getElementById('incLat').value = '14.5828';
    document.getElementById('incLng').value = '121.0545';
    resetSeverityUI('injury');
    document.getElementById('addIncidentModal').classList.add('open');
}
function openEditModal(idx) {
    const r = incidents[idx];
    if (!r) return;
    editingIndex = idx;
    document.getElementById('incidentModalTitle').textContent = 'Edit Road Accident — ' + r.id;
    document.getElementById('incIdField').value = r.id;
    document.getElementById('incType').value = r.type;
    document.getElementById('incBarangay').value = r.barangay;
    document.getElementById('incRoad').value = r.road;
    document.getElementById('incDate').value = toDateInputValue(r.date);
    document.getElementById('incTime').value = toTimeInputValue(r.time);
    document.getElementById('incLat').value = Number.isFinite(Number.parseFloat(r.lat)) ? r.lat : '14.5828';
    document.getElementById('incLng').value = Number.isFinite(Number.parseFloat(r.lng)) ? r.lng : '121.0545';
    const sevKeyMap = { Fatal: 'fatal', Injury: 'injury', Minor: 'minor', Damage: 'damage' };
    resetSeverityUI(sevKeyMap[r.sev] || 'injury');
    document.getElementById('addIncidentModal').classList.add('open');
}
function resetSeverityUI(type) {
    const colors = { fatal: '#dc2626', injury: '#eab308', minor: '#16a34a', damage: '#16a34a' };
    document.querySelectorAll('#sevOptionsWrap .sev-option').forEach(o => {
        o.className = 'sev-option';
        const c = o.querySelector('.fa-check'); if (c) c.remove();
    });
    const opts = document.querySelectorAll('#sevOptionsWrap .sev-option');
    const order = ['injury', 'minor', 'damage', 'fatal'];
    const idx = order.indexOf(type);
    const el = opts[idx >= 0 ? idx : 0];
    el.classList.add('selected-' + type);
    const check = document.createElement('i'); check.className = 'fas fa-check'; check.style.marginLeft = 'auto';
    check.style.color = colors[type]; el.appendChild(check);
    el.dataset.sev = type;
}
function closeModal() { document.getElementById('addIncidentModal').classList.remove('open'); }
async function saveIncident() {
    const selectedEl = document.querySelector('#sevOptionsWrap .sev-option[class*="selected-"]');
    let sevType = 'injury';
    if (selectedEl) {
        const m = selectedEl.className.match(/selected-(\w+)/);
        if (m) sevType = m[1];
    }
    const sevLabelMap = { fatal: 'Fatal', injury: 'Injury', minor: 'Minor', damage: 'Damage' };
    const dateVal = document.getElementById('incDate').value;
    const timeVal = document.getElementById('incTime').value;
    const dateFormatted = dateVal ? new Date(dateVal + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Unknown';
    const timeFormatted = timeVal ? new Date('2000-01-01T' + timeVal).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : 'Unknown';

    const payload = {
        date: dateFormatted, time: timeFormatted, loc: 'Mandaluyong',
        barangay: document.getElementById('incBarangay').value,
        road: document.getElementById('incRoad').value,
        sev: sevLabelMap[sevType],
        type: document.getElementById('incType').value,
        lat: Number.parseFloat(document.getElementById('incLat').value),
        lng: Number.parseFloat(document.getElementById('incLng').value),
    };

    const saveBtn = document.getElementById('incidentSaveBtn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.dataset.originalText = saveBtn.innerHTML; saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving…'; }

    try {
        if (editingIndex >= 0) {
            const updated = await api.updateIncident(incidents[editingIndex].id, payload);
            incidents[editingIndex] = updated;
            showToast('✅ Accident updated successfully!');
        } else {
            const created = await api.createIncident(payload);
            incidents.unshift(created);
            showToast('✅ Accident saved successfully!');
        }
        filteredIncidents = incidents.slice();
            closeModal();
        renderTable();
        updateHomeStats();
        renderDashRecent();
        if (mandaluyongMapReady) renderMandaluyongMapLayers();
        refreshPredictionViews();
    } catch (error) {
        showToast('❌ ' + error.message);
    } finally {
        if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = saveBtn.dataset.originalText; }
    }
}
function selectSeverity(el, type) {
    document.querySelectorAll('#sevOptionsWrap .sev-option').forEach(o => { o.className = 'sev-option'; const c = o.querySelector('.fa-check'); if (c) c.remove(); });
    el.classList.add('selected-' + type);
    const check = document.createElement('i'); check.className = 'fas fa-check'; check.style.marginLeft = 'auto';
    const colors = { fatal: '#dc2626', injury: '#eab308', minor: '#16a34a', damage: '#16a34a' };
    check.style.color = colors[type]; el.appendChild(check);
}
function openUserModal() { document.getElementById('addUserModal').classList.add('open'); }
function closeUserModal() { document.getElementById('addUserModal').classList.remove('open'); }
async function saveUser() {
    const first = document.getElementById('newUserFirst').value.trim();
    const last = document.getElementById('newUserLast').value.trim();
    const email = document.getElementById('newUserEmail').value.trim();
    const phone = document.getElementById('newUserPhone').value.trim();
    const password = document.getElementById('newUserPassword').value;
    const role = document.getElementById('newUserRole').value;
    const dept = document.getElementById('newUserDept').value;

    if (!first || !last || !email || !phone) { showToast('⚠️ Please fill in all required fields'); return; }
    if (password.length < 8) { showToast('⚠️ Temporary password must be at least 8 characters'); return; }

    try {
        await api.createAccount({ name: `${first} ${last}`, email, phone, password, role, dept });
        closeUserModal();
        ['newUserFirst', 'newUserLast', 'newUserEmail', 'newUserPhone', 'newUserPassword']
            .forEach(id => { document.getElementById(id).value = ''; });
        renderUserTable();
        showToast('✅ Account created. Share the temporary password with the user.');
    } catch (error) {
        showToast('⚠️ ' + error.message);
    }
}
// A single reusable "are you sure?" modal for actions that shouldn't fire on a stray click,
// centered on screen (unlike the browser's own confirm()) and styled to match the rest of
// the console instead of showing the page's URL in the dialog chrome.
let confirmModalAction = null;
function openConfirmModal({ title = 'Are you sure?', message = '', icon = 'fas fa-triangle-exclamation', danger = true, confirmLabel = 'Confirm', onConfirm }) {
    document.getElementById('confirmModalTitle').textContent = title;
    document.getElementById('confirmModalMessage').textContent = message;
    document.getElementById('confirmModalIcon').className = icon;
    document.getElementById('confirmModalIconWrap').style.cssText = `width:60px;height:60px;border-radius:50%;margin:0 auto 16px;display:flex;align-items:center;justify-content:center;font-size:26px;background:${danger ? '#fef2f2' : '#eff6ff'};color:${danger ? '#dc2626' : '#2563eb'};`;
    const confirmBtn = document.getElementById('confirmModalConfirmBtn');
    confirmBtn.textContent = confirmLabel;
    confirmBtn.className = danger ? 'btn btn-danger' : 'btn btn-primary';
    confirmModalAction = onConfirm;
    document.getElementById('confirmModal').classList.add('open');
}
function closeConfirmModal() {
    document.getElementById('confirmModal').classList.remove('open');
    confirmModalAction = null;
}

/* Sidebar "Sign Out": asks first, so a stray click doesn't end the session. */
function askSignOut() {
    openConfirmModal({
        title: 'Are you sure you want to sign out?',
        message: 'You will need your password and authenticator code to sign in to the admin console again.',
        icon: 'fas fa-sign-out-alt',
        danger: true,
        confirmLabel: 'Sign Out',
        onConfirm: doLogout
    });
}

// Escape or a click on the dimmed background closes the confirmation without acting.
document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.getElementById('confirmModal')?.classList.contains('open')) closeConfirmModal();
});
document.getElementById('confirmModal')?.addEventListener('click', e => {
    if (e.target.id === 'confirmModal') closeConfirmModal();
});
function runConfirmModal() {
    const action = confirmModalAction;
    closeConfirmModal();
    if (action) action();
}

let pendingDeleteIdx = -1;
function askDelete(idx) { pendingDeleteIdx = idx; document.getElementById('deleteModal').classList.add('open'); }
async function confirmDelete() {
    document.getElementById('deleteModal').classList.remove('open');
    if (pendingDeleteIdx < 0) return;
    const record = incidents[pendingDeleteIdx];
    const idx = pendingDeleteIdx;
    pendingDeleteIdx = -1;
    if (!record) return;
    try {
        await api.deleteIncident(record.id);
        incidents.splice(idx, 1);
        filteredIncidents = incidents.slice();
        renderTable();
        updateHomeStats();
        renderDashRecent();
        if (mandaluyongMapReady) renderMandaluyongMapLayers();
        refreshPredictionViews();
        showToast('🗑️ Accident deleted.');
    } catch (error) {
        showToast('❌ ' + error.message);
    }
}
let reportBarangaySelectPopulated = false;
async function populateReportBarangaySelect() {
    if (reportBarangaySelectPopulated) return;
    const select = document.getElementById('reportBarangaySelect');
    if (!select) return;
    await ensureBarangayNames();
    [...knownBarangayNames].sort().forEach(name => {
        const opt = document.createElement('option');
        opt.value = name; opt.textContent = name;
        select.appendChild(opt);
    });
    reportBarangaySelectPopulated = true;
}

async function generateReport() {
    await populateReportBarangaySelect();
    await loadIncidentsFromServer();

    const from = document.getElementById('reportDateFrom')?.value || '';
    const to = document.getElementById('reportDateTo')?.value || '';
    const barangay = document.getElementById('reportBarangaySelect')?.value || 'all';

    const filtered = incidents.filter(record => {
        if (barangay !== 'all' && record.barangay !== barangay) return false;
        if (from || to) {
            const date = parseIncidentDate(record);
            if (!date) return false;
            if (from && date < new Date(from + 'T00:00:00')) return false;
            if (to && date > new Date(to + 'T23:59:59')) return false;
        }
        return true;
    });

    const total = filtered.length;
    const fatal = filtered.filter(r => r.sev === 'Fatal').length;
    const injury = filtered.filter(r => r.sev === 'Injury').length;

    let highRiskRoads = 0;
    try {
        const predictions = await api.getPredictions();
        highRiskRoads = predictions.filter(p => p.riskLevel === 'high' && (barangay === 'all' || p.barangay === barangay)).length;
    } catch { /* leave at 0 if predictions can't be fetched */ }

    const totalEl = document.getElementById('reportStatTotal');
    const fatalEl = document.getElementById('reportStatFatal');
    const injuryEl = document.getElementById('reportStatInjury');
    const highRiskEl = document.getElementById('reportStatHighRisk');
    if (totalEl) totalEl.textContent = total.toLocaleString();
    if (fatalEl) fatalEl.textContent = fatal.toLocaleString();
    if (injuryEl) injuryEl.textContent = injury.toLocaleString();
    if (highRiskEl) highRiskEl.textContent = highRiskRoads.toLocaleString();

    const subtitle = document.getElementById('reportSubtitle');
    if (subtitle) {
        const rangeText = from && to ? `${from} to ${to}` : from ? `From ${from}` : to ? `Through ${to}` : 'All dates on record';
        subtitle.textContent = `Mandaluyong City, ${barangay === 'all' ? 'All Barangays' : barangay} · ${rangeText}`;
    }

    initReportChart(filtered);
    showToast(total ? `📄 Report generated — ${total} accident${total !== 1 ? 's' : ''} in range` : '📄 Report generated — no accidents match these filters');
}
function openDetailModal(idx) {
    const r = incidents[idx];
    if (!r) return;
    editingIndex = idx;
    document.getElementById('detailId').textContent = r.id;
    document.getElementById('detailDateTime').textContent = r.date + ' · ' + r.time;
    document.getElementById('detailType').textContent = r.type;
    document.getElementById('detailBarangay').textContent = r.barangay;
    document.getElementById('detailRoad').textContent = r.road;
    document.getElementById('detailSevBadge').innerHTML = getSevBadge(r.sev);
    document.getElementById('detailFatalities').textContent = r.sev === 'Fatal' ? '1' : '0';
    document.getElementById('detailInjured').textContent = r.sev === 'Injury' ? '2' : '0';
    document.getElementById('incidentDetailModal').classList.add('open');
}
function closeDetailModal() { document.getElementById('incidentDetailModal').classList.remove('open'); }
function editFromDetail() {
    closeDetailModal();
    if (editingIndex >= 0) openEditModal(editingIndex);
}

// ===== MANDALUYONG LEAFLET GIS MAP =====
// Layer groups are intentionally separate so incident markers, heatmaps, and hotspot analysis
// can be introduced without changing the barangay-boundary module.
let mandaluyongMap;
let mandaluyongMapLayers = {};
let mandaluyongBarangayLayers = new Map();
let mandaluyongBarangayCentroids = new Map();
let mandaluyongBoundaryGeoJson;
let mandaluyongMapReady = false;
const MANDALUYONG_GEOJSON_URLS = ['data/mandaluyong-barangays.geojson', './data/mandaluyong-barangays.geojson', '/data/mandaluyong-barangays.geojson', 'mandaluyong-barangays.geojson', 'http://localhost:5500/api/barangays'];
const MANDALUYONG_PALETTE = ['#1a56db', '#0f766e', '#7c3aed', '#c2410c', '#be185d', '#047857', '#0369a1', '#6d28d9', '#b45309'];
const INCIDENT_ROAD_OFFSETS = {
    'shaw blvd': [0.0012, -0.0001],
    edsa: [0.0002, 0.0011],
    'boni ave': [-0.0009, 0.0007],
    'ortigas ave': [0.0007, -0.0011],
    'san francisco st': [-0.0008, -0.0007],
    'san joaquin st': [-0.001, 0.0004],
};

function escapeMapHtml(value) { return String(value).replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]); }
function barangayStyle(index) {
    const color = MANDALUYONG_PALETTE[index % MANDALUYONG_PALETTE.length];
    return { color, weight: 1.5, opacity: .9, fillColor: color, fillOpacity: .18 };
}
function toDateInputValue(value) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
}
function toTimeInputValue(value) {
    const parsed = new Date(`2000-01-01 ${value}`);
    return Number.isNaN(parsed.getTime()) ? '' : parsed.toTimeString().slice(0, 5);
}
function barangayPopup(feature) {
    const name = escapeMapHtml(feature.properties.brgy_name);
    const code = escapeMapHtml(feature.properties.psgc_10d);
    return `<div class="barangay-popup"><div class="barangay-popup-title">${name}</div><div class="barangay-popup-meta">PSGC: ${code}<br>Total accidents: <strong>—</strong><br>Fatal: <strong>—</strong> · Injuries: <strong>—</strong></div></div>`;
}
function getFeatureCentroid(feature) {
    const coords = feature.geometry?.coordinates || [];
    const points = [];
    const walk = (node) => {
        if (!Array.isArray(node)) return;
        if (typeof node[0] === 'number' && typeof node[1] === 'number') {
            points.push(node);
            return;
        }
        node.forEach(walk);
    };
    walk(coords);
    if (!points.length) return null;
    const sum = points.reduce((acc, [lng, lat]) => [acc[0] + lng, acc[1] + lat], [0, 0]);
    return [sum[1] / points.length, sum[0] / points.length];
}
function normalizeText(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function getIncidentPoint(record) {
    const savedLat = Number.parseFloat(record.lat);
    const savedLng = Number.parseFloat(record.lng);
    if (Number.isFinite(savedLat) && Number.isFinite(savedLng)) return { lat: savedLat, lng: savedLng };
    const centroid = mandaluyongBarangayCentroids.get(record.barangay) || mandaluyongBarangayCentroids.get('Plainview');
    if (!centroid) return null;
    const roadKey = Object.keys(INCIDENT_ROAD_OFFSETS).find(key => normalizeText(record.road).includes(key));
    const offset = roadKey ? INCIDENT_ROAD_OFFSETS[roadKey] : [0, 0];
    const sevOffset = record.sev === 'Fatal' ? [0.0007, 0.0007] : record.sev === 'Injury' ? [0.00035, -0.00045] : record.sev === 'Minor' ? [-0.00025, 0.0003] : [0, 0];
    const hashSeed = Array.from(normalizeText(record.id)).reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
    const jitter = ((hashSeed % 7) - 3) / 10000;
    return {
        lat: centroid[0] + offset[0] + sevOffset[0] + jitter,
        lng: centroid[1] + offset[1] + sevOffset[1] - jitter
    };
}
function getSeverityColor(sev) {
    return { Fatal: '#dc2626', Injury: '#eab308', Minor: '#16a34a', Damage: '#16a34a' }[sev] || '#64748b';
}
function buildIncidentTooltip(record) {
    return `<strong>${escapeMapHtml(record.id)}</strong><br>${escapeMapHtml(record.road)}<br>${escapeMapHtml(record.barangay)}<br>${escapeMapHtml(record.sev)} · ${escapeMapHtml(record.type)}`;
}
function renderMandaluyongMapLayers() {
    if (!mandaluyongMap || !mandaluyongMapLayers.barangays) return;
    mandaluyongMapLayers.incidents.clearLayers();
    mandaluyongMapLayers.heatmap.clearLayers();
    mandaluyongMapLayers.hotspots.clearLayers();
    if (mandaluyongBoundaryGeoJson) {
        const bounds = mandaluyongBoundaryGeoJson.getBounds();
        mandaluyongMap.fitBounds(bounds, { padding: [16, 16] });
    }

    const selectedBarangay = document.getElementById('mapFltBarangay')?.value || 'all';
    const selectedType = document.getElementById('mapFltType')?.value || 'all';
    const selectedSev = document.getElementById('mapFltSev')?.value || 'all';
    const normalizedSev = selectedSev === 'Damage Only' ? 'Damage' : selectedSev;
    const from = document.getElementById('mapDateFrom')?.value || '';
    const to = document.getElementById('mapDateTo')?.value || '';

    const visibleIncidents = incidents.filter(record => {
        if (selectedBarangay !== 'all' && record.barangay !== selectedBarangay) return false;
        if (selectedType !== 'all' && record.type !== selectedType) return false;
        if (normalizedSev !== 'all' && record.sev !== normalizedSev) return false;
        if (from || to) {
            const parsed = new Date(record.date);
            if (Number.isNaN(parsed.getTime())) return false;
            if (from && parsed < new Date(from + 'T00:00:00')) return false;
            if (to && parsed > new Date(to + 'T23:59:59')) return false;
        }
        return true;
    });

    const severityCounts = new Map();
    const roadCounts = new Map();
    visibleIncidents.forEach(record => {
        const point = getIncidentPoint(record);
        if (!point) return;
        severityCounts.set(record.barangay, (severityCounts.get(record.barangay) || 0) + 1);
        roadCounts.set(record.road, (roadCounts.get(record.road) || 0) + 1);

        const marker = L.circleMarker([point.lat, point.lng], {
            radius: record.sev === 'Fatal' ? 10 : record.sev === 'Injury' ? 8 : 6,
            color: '#ffffff',
            weight: 2,
            fillColor: getSeverityColor(record.sev),
            fillOpacity: 0.9
        }).bindPopup(`<div style="font-family:inherit"><strong>${escapeMapHtml(record.id)}</strong><br>${escapeMapHtml(record.date)} · ${escapeMapHtml(record.time)}<br>${escapeMapHtml(record.road)}<br>${escapeMapHtml(record.barangay)}<br><strong>${escapeMapHtml(record.sev)}</strong> · ${escapeMapHtml(record.type)}</div>`, { maxWidth: 260 });
        marker.bindTooltip(buildIncidentTooltip(record), { sticky: true, direction: 'top', className: 'incident-tooltip' });
        marker.on('click', () => selectIncident(record.id, record.road, record.barangay, record.type, record.sev, roadCounts.get(record.road) || 1, record));
        marker.addTo(mandaluyongMapLayers.incidents);

        const heat = L.circle([point.lat, point.lng], {
            radius: record.sev === 'Fatal' ? 260 : record.sev === 'Injury' ? 200 : 150,
            color: getSeverityColor(record.sev),
            fillColor: getSeverityColor(record.sev),
            fillOpacity: record.sev === 'Fatal' ? 0.22 : 0.16,
            weight: 0
        });
        heat.addTo(mandaluyongMapLayers.heatmap);
    });

    // Hotspot markers come from the server's KDE (Kernel Density Estimation) surface over all
    // incident locations, not a simple per-road count — so a marker here means "a real spatial
    // density peak," including density contributed by nearby incidents on other roads.
    const visibleHotspots = selectedBarangay === 'all' ? hotspotsCache : hotspotsCache.filter(h => h.barangay === selectedBarangay);
    visibleHotspots.forEach(h => {
        const size = 22 + Math.round(h.intensity * 22);
        const hotspot = L.divIcon({
            className: 'map-hotspot-icon',
            html: `<div style="width:${size + 14}px;height:${size + 14}px;border-radius:50%;background:rgba(220,38,38,.18);border:2px solid rgba(220,38,38,.85);display:flex;align-items:center;justify-content:center;box-shadow:0 8px 18px rgba(220,38,38,.22);"><div style="width:${size}px;height:${size}px;border-radius:50%;background:#dc2626;color:white;font-size:11px;font-weight:800;display:flex;align-items:center;justify-content:center;">${h.incidentCount}</div></div>`,
            iconSize: [size + 14, size + 14],
            iconAnchor: [(size + 14) / 2, (size + 14) / 2]
        });
        L.marker([h.lat, h.lng], { icon: hotspot }).bindPopup(`<strong>${escapeMapHtml(h.road)}</strong><br>${escapeMapHtml(h.barangay)}<br>KDE density: ${Math.round(h.intensity * 100)}% of peak<br>${h.incidentCount} nearby accident${h.incidentCount === 1 ? '' : 's'} · ${h.fatalCount} fatal`).addTo(mandaluyongMapLayers.hotspots);
    });

    const summary = document.getElementById('mapResultSummary');
    if (summary) {
        const fatal = visibleIncidents.filter(record => record.sev === 'Fatal').length;
        const injury = visibleIncidents.filter(record => record.sev === 'Injury').length;
        summary.textContent = `${visibleIncidents.length} accident${visibleIncidents.length === 1 ? '' : 's'} shown · ${fatal} fatal · ${injury} injury`;
    }
    mandaluyongBarangayLayers.forEach((layer, barangay) => {
        const total = severityCounts.get(barangay) || 0;
        const fatal = visibleIncidents.filter(record => record.barangay === barangay && record.sev === 'Fatal').length;
        layer.bindPopup(`<div class="barangay-popup"><div class="barangay-popup-title">${escapeMapHtml(barangay)}</div><div class="barangay-popup-meta">Visible accidents: <strong>${total}</strong><br>Fatal: <strong>${fatal}</strong></div></div>`, { className: 'barangay-popup', maxWidth: 250 });
    });

    mandaluyongMapLayers.incidents.eachLayer(layer => mandaluyongMap.hasLayer(mandaluyongMapLayers.incidents) || mandaluyongMapLayers.incidents.removeLayer(layer));
    mandaluyongMapLayers.heatmap.eachLayer(layer => mandaluyongMap.hasLayer(mandaluyongMapLayers.heatmap) || mandaluyongMapLayers.heatmap.removeLayer(layer));
    mandaluyongMapLayers.hotspots.eachLayer(layer => mandaluyongMap.hasLayer(mandaluyongMapLayers.hotspots) || mandaluyongMapLayers.hotspots.removeLayer(layer));
}
async function initMandaluyongMap() {
    if (mandaluyongMapReady || !window.L) return;
    const container = document.getElementById('mandaluyongLeafletMap');
    if (!container || container.offsetParent === null) return;
    mandaluyongMapReady = true;
    mandaluyongMap = L.map(container, { zoomControl: false, preferCanvas: true, attributionControl: true });
    L.control.zoom({ position: 'bottomright' }).addTo(mandaluyongMap);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(mandaluyongMap);
    mandaluyongMapLayers = { barangays: L.layerGroup().addTo(mandaluyongMap), incidents: L.layerGroup(), heatmap: L.layerGroup(), hotspots: L.layerGroup() };
    try {
        let boundaries;
        let lastError;
        for (const url of MANDALUYONG_GEOJSON_URLS) {
            try {
                const response = await fetch(url, { cache: 'no-store' });
                if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
                const candidate = await response.json();
                if (Array.isArray(candidate.features) && candidate.features.length === 27) { boundaries = candidate; break; }
                throw new Error(`Expected 27 features, received ${candidate.features?.length || 0}`);
            } catch (error) { lastError = error; }
        }
        if (!boundaries) throw new Error(`Boundary data could not be loaded. ${lastError?.message || ''}`.trim());
        if (!Array.isArray(boundaries.features) || boundaries.features.length !== 27) throw new Error('Expected 27 Mandaluyong barangay boundaries.');
        const geoJsonLayer = L.geoJSON(boundaries, {
            style: (feature) => barangayStyle(Number(feature.properties.psgc_10d.slice(-2)) - 1),
            onEachFeature: (feature, layer) => {
                const name = feature.properties.brgy_name;
                const baseStyle = barangayStyle(Number(feature.properties.psgc_10d.slice(-2)) - 1);
                mandaluyongBarangayLayers.set(name, layer);
                const centroid = getFeatureCentroid(feature);
                if (centroid) mandaluyongBarangayCentroids.set(name, centroid);
                layer.bindTooltip(name, { className: 'barangay-tooltip', permanent: true, sticky: true, direction: 'center', opacity: .92 });
                layer.bindPopup(barangayPopup(feature), { className: 'barangay-popup', maxWidth: 250 });
                layer.on({
                    mouseover: () => layer.setStyle({ weight: 3, fillOpacity: .42, color: '#0f1e3c' }),
                    mouseout: () => layer.setStyle(baseStyle),
                    click: () => layer.openPopup()
                });
            }
        }).addTo(mandaluyongMapLayers.barangays);
        mandaluyongBoundaryGeoJson = geoJsonLayer;
        const bounds = geoJsonLayer.getBounds();
        mandaluyongMap.fitBounds(bounds, { padding: [16, 16] });
        mandaluyongMap.setMinZoom(mandaluyongMap.getZoom());
        mandaluyongMap.setMaxBounds(bounds.pad(.05));
        populateMapBarangayFilter(boundaries.features);
        renderMandaluyongMapLayers();
        setTimeout(() => mandaluyongMap.invalidateSize(), 0);
    } catch (error) {
        container.innerHTML = `<div class="map-load-error"><i class="fas fa-triangle-exclamation"></i><strong>Map data unavailable</strong><span>Start the RIMAS server with <code>start-mandasafe.bat</code>, then reload the page.</span><button type="button" class="map-retry-btn" onclick="location.reload()">Retry map</button></div>`;
        console.error('Mandaluyong GIS map:', error);
    }
}
function populateMapBarangayFilter(features) {
    const select = document.getElementById('mapFltBarangay'); if (!select) return;
    select.innerHTML = '<option value="all">All Barangays</option>' + features.map(feature => `<option value="${escapeMapHtml(feature.properties.brgy_name)}">${escapeMapHtml(feature.properties.brgy_name)}</option>`).sort().join('');
}
function selectIncident(id, road, barangay, type, sev, count, record = null) {
    document.getElementById('mapInfoPanel').classList.add('open');
    document.getElementById('mapLayout').style.gridTemplateColumns = '220px 1fr 280px';
    document.getElementById('infoPanelId').textContent = record?.id || id;
    document.getElementById('infoDateTime').textContent = record ? `${record.date} · ${record.time}` : 'Selected map hotspot';
    document.getElementById('infoType').textContent = type;
    document.getElementById('infoRoad').textContent = road;
    document.getElementById('infoBarangay').textContent = barangay;
    // Real counts around the selected accident, not an estimate.
    const nearby = record ? accidentsNear(record, 200) : [];
    document.getElementById('infoInjuries').textContent = record ? nearby.filter(r => r.sev === 'Injury' || r.sev === 'Fatal').length : '—';
    document.getElementById('infoCount').textContent = record ? nearby.length : count;
    document.getElementById('infoSevBadge').innerHTML = getSevBadge(sev);
}
/* Accidents within `meters` of a record (the record itself included). */
function accidentsNear(record, meters) {
    const lat = Number(record.lat), lng = Number(record.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [record];
    const mPerDegLat = 111320, mPerDegLng = 111320 * Math.cos(lat * Math.PI / 180);
    return incidents.filter(r => {
        const la = Number(r.lat), ln = Number(r.lng);
        if (!Number.isFinite(la) || !Number.isFinite(ln)) return false;
        const dy = (la - lat) * mPerDegLat, dx = (ln - lng) * mPerDegLng;
        return dx * dx + dy * dy <= meters * meters;
    });
}
function closeInfoPanel() {
    document.getElementById('mapInfoPanel').classList.remove('open');
    document.getElementById('mapLayout').style.gridTemplateColumns = '220px 1fr 0px';
}
function mapZoom(dir) {
    if (mandaluyongMap) dir > 0 ? mandaluyongMap.zoomIn() : mandaluyongMap.zoomOut();
}
function toggleMapLayer(layer, btn) {
    btn.classList.toggle('active');
    const layerName = layer === 'boundary' ? 'barangays' : layer;
    const targetLayer = mandaluyongMapLayers[layerName];
    if (!mandaluyongMap || !targetLayer) return;
    if (mandaluyongMap.hasLayer(targetLayer)) mandaluyongMap.removeLayer(targetLayer);
    else mandaluyongMap.addLayer(targetLayer);
}
function applyMapFilters() {
    renderMandaluyongMapLayers();
    const selectedBarangay = document.getElementById('mapFltBarangay').value;
    if (selectedBarangay !== 'all') {
        const barangayLayer = mandaluyongBarangayLayers.get(selectedBarangay);
        if (barangayLayer) {
            mandaluyongMap.fitBounds(barangayLayer.getBounds(), { padding: [30, 30], maxZoom: 16 });
            barangayLayer.openPopup();
        }
    }
    showToast(selectedBarangay === 'all' ? '🔍 Map filters applied' : `🔍 Showing ${selectedBarangay}`);
}
function resetMapFilters() {
    document.getElementById('mapDateFrom').value = '';
    document.getElementById('mapDateTo').value = '';
    document.getElementById('mapFltType').value = 'all';
    document.getElementById('mapFltSev').value = 'all';
    document.getElementById('mapFltBarangay').value = 'all';
    if (mandaluyongBoundaryGeoJson) mandaluyongMap.fitBounds(mandaluyongBoundaryGeoJson.getBounds(), { padding: [16, 16] });
    renderMandaluyongMapLayers();
    showToast('↺ Map filters reset');
}

// ===== TOAST =====
function showToast(msg) {
    const t = document.getElementById('toast');
    document.getElementById('toastMsg').textContent = msg;
    t.classList.add('show');
    clearTimeout(window._toastTimer);
    window._toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}

// ===== CHARTS =====
const chartDefaults = { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } };
let chartsInit = {};
function safeChart(id, config) {
    if (chartsInit[id]) { chartsInit[id].destroy(); }
    const ctx = document.getElementById(id); if (!ctx) return;
    chartsInit[id] = new Chart(ctx, config);
}

// ===== REAL-DATA CHART HELPERS (shared by Analytics + Reports) =====
// Dates are read as local calendar dates ("2026-06-30" is June 30 here, not the UTC
// instant), and times from their HH:MM text, so no timezone can move a record.
function parseIncidentDate(record) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(record.date || ''));
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return Number.isNaN(d.getTime()) ? null : d;
}
function parseIncidentHour(record) {
    const m = /^(\d{1,2}):\d{2}/.exec(String(record.time || ''));
    const h = m ? Number(m[1]) : NaN;
    return h >= 0 && h < 24 ? h : null;
}
function monthBucketKey(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`; }
function monthBucketLabel(key) {
    const [y, m] = key.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'short', year: 'numeric' });
}
// Groups incidents into monthly buckets so the trend line scales to any date range —
// a handful of rows or several years' worth of an imported spreadsheet alike.
function buildMonthlySeries(list, monthsBack = 12) {
    const byMonth = new Map();
    list.forEach(record => {
        const date = parseIncidentDate(record);
        if (!date) return;
        const key = monthBucketKey(date);
        if (!byMonth.has(key)) byMonth.set(key, { total: 0, injuries: 0 });
        const bucket = byMonth.get(key);
        bucket.total += 1;
        if (record.sev === 'Injury' || record.sev === 'Fatal') bucket.injuries += 1;
    });
    const present = [...byMonth.keys()].sort();
    if (!present.length) return { labels: [], totals: [], injuries: [] };
    // Fill the gaps: a month with no accidents is a 0 on the chart, not a missing point.
    const keys = [];
    let [y, m] = present[0].split('-').map(Number);
    const last = present[present.length - 1];
    for (;;) {
        const key = `${y}-${String(m).padStart(2, '0')}`;
        keys.push(key);
        if (key >= last) break;
        if (++m > 12) { m = 1; y += 1; }
    }
    const shown = keys.slice(-monthsBack);
    const at = k => byMonth.get(k) || { total: 0, injuries: 0 };
    return { labels: shown.map(monthBucketLabel), totals: shown.map(k => at(k).total), injuries: shown.map(k => at(k).injuries) };
}
function topGroupCounts(list, key, limit) {
    const counts = new Map();
    list.forEach(record => { const value = record[key] || 'Unknown'; counts.set(value, (counts.get(value) || 0) + 1); });
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}
function buildDayPeriodMatrix(list) {
    const matrix = { Morning: new Array(7).fill(0), Afternoon: new Array(7).fill(0), Evening: new Array(7).fill(0), Night: new Array(7).fill(0) };
    list.forEach(record => {
        const date = parseIncidentDate(record);
        const hour = parseIncidentHour(record);
        if (!date || hour === null) return;
        const dayIndex = (date.getDay() + 6) % 7; // 0=Mon..6=Sun, matching the chart's label order
        const period = hour >= 6 && hour < 12 ? 'Morning' : hour >= 12 && hour < 18 ? 'Afternoon' : hour >= 18 && hour < 22 ? 'Evening' : 'Night';
        matrix[period][dayIndex] += 1;
    });
    return matrix;
}

// Analytics, Reports, and the GIS Map all read from the same `incidents` array — refreshing
// it here means anything just imported shows up here without a separate wiring step.
let analyticsPredictions = [];

function populateAnalyticsFilterOptions() {
    const fill = (id, values) => {
        const select = document.getElementById(id);
        if (!select) return;
        const current = select.value;
        select.innerHTML = select.firstElementChild.outerHTML + values.map(v => `<option value="${escapeMapHtml(v)}">${escapeMapHtml(v)}</option>`).join('');
        select.value = values.includes(current) ? current : 'all';
    };
    fill('anaFltBarangay', [...new Set(incidents.map(r => r.barangay).filter(Boolean))].sort());
    fill('anaFltRoad', [...new Set(incidents.map(r => r.road).filter(Boolean))].sort());
    fill('anaFltVehicle', [...new Set(incidents.map(r => r.type).filter(Boolean))].sort());
}

function analyticsDateMatches(record, { from, to }) {
    if (!from && !to) return true;
    const date = parseIncidentDate(record);
    if (!date) return false;
    if (from && date < new Date(from + 'T00:00:00')) return false;
    if (to && date > new Date(to + 'T23:59:59')) return false;
    return true;
}

function applyAnalyticsFilters() {
    const dateFrom = document.getElementById('anaFltDateFrom').value;
    const dateTo = document.getElementById('anaFltDateTo').value;
    const brgy = document.getElementById('anaFltBarangay').value;
    const road = document.getElementById('anaFltRoad').value;
    const sev = document.getElementById('anaFltSeverity').value;
    const type = document.getElementById('anaFltVehicle').value;

    if (dateFrom && dateTo && dateFrom > dateTo) {
        showToast('⚠️ "From" date must be before "To" date');
        return;
    }

    const filtered = incidents.filter(r => {
        if (brgy !== 'all' && r.barangay !== brgy) return false;
        if (road !== 'all' && r.road !== road) return false;
        if (sev !== 'all' && r.sev !== sev) return false;
        if (type !== 'all' && r.type !== type) return false;
        if (!analyticsDateMatches(r, { from: dateFrom, to: dateTo })) return false;
        return true;
    });
    renderAnalyticsCharts(filtered, { barangay: brgy, road });
    showToast(`🔍 Filter applied — ${filtered.length} result${filtered.length === 1 ? '' : 's'}`);
}

function resetAnalyticsFilters() {
    ['anaFltBarangay', 'anaFltRoad', 'anaFltSeverity', 'anaFltVehicle'].forEach(id => {
        const el = document.getElementById(id); if (el) el.value = 'all';
    });
    ['anaFltDateFrom', 'anaFltDateTo'].forEach(id => {
        const el = document.getElementById(id); if (el) el.value = '';
    });
    renderAnalyticsCharts(incidents, {});
    showToast('↺ Filters reset');
}

function renderAnalyticsCharts(list, predictionFilter = {}) {
    const fatal = list.filter(r => r.sev === 'Fatal').length;
    const injury = list.filter(r => r.sev === 'Injury').length;
    const highRisk = analyticsPredictions.filter(p =>
        p.riskLevel === 'high' &&
        (!predictionFilter.barangay || predictionFilter.barangay === 'all' || p.barangay === predictionFilter.barangay) &&
        (!predictionFilter.road || predictionFilter.road === 'all' || p.road === predictionFilter.road)
    ).length;
    const setStat = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
    setStat('anaStatTotal', list.length);
    setStat('anaStatFatal', fatal);
    setStat('anaStatInjury', injury);
    setStat('anaStatHighRisk', highRisk);

    const monthly = buildMonthlySeries(list);
    safeChart('analyticsTimeChart', { type: 'line', data: { labels: monthly.labels, datasets: [{ label: 'Accidents', data: monthly.totals, borderColor: '#1a56db', backgroundColor: 'rgba(26,86,219,.12)', fill: true, tension: .4, pointRadius: 5, pointBackgroundColor: '#1a56db', pointBorderColor: 'white', pointBorderWidth: 2 }, { label: 'Injuries', data: monthly.injuries, borderColor: '#eab308', backgroundColor: 'rgba(234,179,8,.1)', fill: true, tension: .4, pointRadius: 5, pointBackgroundColor: '#f59e0b', pointBorderColor: 'white', pointBorderWidth: 2 }] }, options: { ...chartDefaults, plugins: { legend: { display: true, position: 'top', labels: { usePointStyle: true, boxWidth: 8, font: { size: 11 } } } }, scales: { y: { grid: { color: '#f1f5f9' } }, x: { grid: { display: false }, ticks: { font: { size: 10 } } } } } });

    const topBarangays = topGroupCounts(list, 'barangay', 6);
    safeChart('barangayChart', { type: 'bar', data: { labels: topBarangays.map(([b]) => b), datasets: [{ data: topBarangays.map(([, c]) => c), backgroundColor: ['#1a56db', '#3b82f6', '#f59e0b', '#22c55e', '#94a3b8', '#f87171'], borderRadius: 5 }] }, options: { ...chartDefaults, indexAxis: 'y', scales: { x: { grid: { color: '#f1f5f9' }, ticks: { font: { size: 10 } } }, y: { grid: { display: false }, ticks: { font: { size: 10 } } } } } });

    const topTypes = topGroupCounts(list, 'type', 4);
    const otherCount = list.length - topTypes.reduce((a, [, c]) => a + c, 0);
    const typeLabels = topTypes.map(([t]) => t).concat(otherCount > 0 ? ['Other'] : []);
    const typeCounts = topTypes.map(([, c]) => c).concat(otherCount > 0 ? [otherCount] : []);
    safeChart('typeDonut', { type: 'doughnut', data: { labels: typeLabels, datasets: [{ data: typeCounts, backgroundColor: ['#1a56db', '#f59e0b', '#fbbf24', '#94a3b8', '#c4b5fd'], borderWidth: 3, borderColor: 'white', hoverOffset: 6 }] }, options: { ...chartDefaults, cutout: '72%' } });

    renderAnalyticsInsights(list, topBarangays, typeLabels, typeCounts);

    const dayPeriods = buildDayPeriodMatrix(list);
    safeChart('heatmapChart', { type: 'bar', data: { labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], datasets: [{ label: 'Morning', data: dayPeriods.Morning, backgroundColor: 'rgba(34,197,94,.6)', borderRadius: 4 }, { label: 'Afternoon', data: dayPeriods.Afternoon, backgroundColor: 'rgba(245,158,11,.7)', borderRadius: 4 }, { label: 'Evening', data: dayPeriods.Evening, backgroundColor: 'rgba(239,68,68,.8)', borderRadius: 4 }, { label: 'Night', data: dayPeriods.Night, backgroundColor: 'rgba(17,24,39,.7)', borderRadius: 4 }] }, options: { ...chartDefaults, plugins: { legend: { display: true, position: 'bottom', labels: { usePointStyle: true, boxWidth: 8, font: { size: 10 }, padding: 10 } } }, scales: { x: { stacked: true, grid: { display: false }, ticks: { font: { size: 10 } } }, y: { stacked: true, grid: { color: '#f1f5f9' } } } } });
}

/* Text beside the Analytics charts — every sentence is worked out from `list`, the same
   (filtered) records the charts show. */
const TYPE_COLORS = ['#1a56db', '#f59e0b', '#fbbf24', '#94a3b8', '#c4b5fd'];

function peakTwoHourWindow(list) {
    const hours = new Array(24).fill(0);
    list.forEach(r => { const h = parseIncidentHour(r); if (h !== null) hours[h] += 1; });
    let best = -1, bestCount = -1;
    for (let h = 0; h < 24; h++) {
        const c = hours[h] + hours[(h + 1) % 24];
        if (c > bestCount) { bestCount = c; best = h; }
    }
    const withTime = hours.reduce((a, b) => a + b, 0);
    return { start: best, count: bestCount, share: withTime ? bestCount / withTime : 0, hours };
}

function hourLabel(h) {
    const hr = h % 12 === 0 ? 12 : h % 12;
    return `${hr} ${h < 12 ? 'AM' : 'PM'}`;
}

/* Barangays whose last 3 months (of `list`) average at least one more accident a month
   than the 6 months before them. */
function risingBarangays(list) {
    const dated = list.map(r => ({ r, d: parseIncidentDate(r) })).filter(x => x.d);
    if (!dated.length) return { rows: [], window: '' };
    const lastMonth = dated.reduce((m, x) => { const k = monthBucketKey(x.d); return k > m ? k : m; }, '');
    const [ly, lm] = lastMonth.split('-').map(Number);
    const monthsAgo = d => (ly - d.getFullYear()) * 12 + (lm - 1 - d.getMonth());
    const stats = new Map();
    dated.forEach(({ r, d }) => {
        const ago = monthsAgo(d);
        if (ago < 0 || ago > 8) return;
        const b = r.barangay || 'Unknown';
        if (!stats.has(b)) stats.set(b, { recent: 0, earlier: 0 });
        if (ago <= 2) stats.get(b).recent += 1; else stats.get(b).earlier += 1;
    });
    const rows = [...stats.entries()].map(([barangay, s]) => ({
        barangay, recent: s.recent / 3, earlier: s.earlier / 6
    })).filter(x => x.recent - x.earlier >= 1)
      .sort((a, b) => (b.recent - b.earlier) - (a.recent - a.earlier));
    const label = key => monthBucketLabel(key);
    const shift = n => { const d = new Date(ly, lm - 1 - n, 1); return monthBucketKey(d); };
    return { rows, window: `${label(shift(2))} – ${label(lastMonth)} vs the 6 months before` };
}

function renderAnalyticsInsights(list, topBarangays, typeLabels, typeCounts) {
    const set = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
    const total = list.length;

    if (!total) {
        set('anaInsightPeak', '<strong>Peak Accidents</strong>no records match these filters');
        set('anaInsightTop', '<strong>Most Frequent</strong>—');
        set('anaInsightRisk', '<strong>Highest Risk</strong>—');
        set('typeLegend', '');
        set('risingList', '<div style="font-size:12px;color:var(--gray-400);">No records match these filters.</div>');
        set('anaRecommendations', '<li>Widen the filters to see recommendations.</li>');
        return;
    }

    const peak = peakTwoHourWindow(list);
    set('anaInsightPeak', `<strong>Peak Accidents</strong>occur between ${hourLabel(peak.start)} and ${hourLabel((peak.start + 2) % 24)} — ${Math.round(peak.share * 100)}% of accidents in just 2 hours of the day`);

    const [topName, topCount] = topBarangays[0] || ['—', 0];
    set('anaInsightTop', `<strong>Most Frequent</strong>in Barangay ${escapeMapHtml(topName)} — ${topCount.toLocaleString()} accidents (${Math.round(topCount / total * 100)}%)`);

    const topRisk = analyticsPredictions[0];
    set('anaInsightRisk', topRisk
        ? `<strong>Highest Risk</strong>${escapeMapHtml(topRisk.barangay)} — risk ${topRisk.riskScore.toFixed(1)}/10, ${topRisk.predictedNextMonth} accidents forecast next month`
        : '<strong>Highest Risk</strong>no forecast available yet');

    set('typeLegend', typeLabels.map((label, i) => `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
            <div style="width:12px;height:12px;border-radius:3px;background:${TYPE_COLORS[i % TYPE_COLORS.length]};flex-shrink:0;"></div>
            <span>${escapeMapHtml(label)}</span><span style="margin-left:auto;font-weight:700;">${Math.round(typeCounts[i] / total * 100)}%</span>
        </div>`).join(''));

    const rising = risingBarangays(list);
    set('risingWindow', rising.window);
    const maxRise = Math.max(1, ...rising.rows.map(r => r.recent - r.earlier));
    set('risingList', rising.rows.length ? rising.rows.slice(0, 6).map(r => {
        const rise = r.recent - r.earlier;
        const pct = r.earlier > 0 ? `+${Math.round(rise / r.earlier * 100)}%` : 'new';
        return `<div class="risk-bar-item" title="${r.earlier.toFixed(1)} → ${r.recent.toFixed(1)} accidents a month">
            <div class="risk-bar-label">${escapeMapHtml(r.barangay)}</div>
            <div class="risk-bar-track"><div class="risk-bar-fill" style="width:${Math.max(6, rise / maxRise * 100)}%;background:#ef4444;"></div></div>
            <div class="risk-count" style="color:#ef4444;min-width:130px;text-align:right;">${r.earlier.toFixed(1)} → ${r.recent.toFixed(1)}/mo (${pct})</div>
        </div>`;
    }).join('') : '<div style="font-size:12px;color:#16a34a;"><i class="fas fa-check-circle"></i> No barangay rose by one or more accidents a month in this period.</div>');

    const recs = [];
    recs.push(`Schedule enforcement for ${hourLabel(peak.start)}–${hourLabel((peak.start + 2) % 24)}, the busiest 2 hours (${Math.round(peak.share * 100)}% of accidents).`);
    if (topName !== '—') recs.push(`Prioritise Barangay ${escapeMapHtml(topName)}, which accounts for ${Math.round(topCount / total * 100)}% of the accidents shown.`);
    if (rising.rows.length) recs.push(`Look into ${rising.rows.slice(0, 2).map(r => escapeMapHtml(r.barangay)).join(' and ')}, where accidents are rising.`);
    else recs.push('Keep current measures: no barangay shows a meaningful rise in the latest 3 months.');
    set('anaRecommendations', recs.map(r => `<li>${r}</li>`).join(''));
}

async function initAnalyticsCharts() {
    await loadIncidentsFromServer();
    try { analyticsPredictions = await api.getPredictions(); } catch (error) { console.error('Failed to load predictions for analytics:', error); analyticsPredictions = []; }

    populateAnalyticsFilterOptions();
    renderAnalyticsCharts(incidents, {});
}

function initReportChart(list) {
    const monthly = buildMonthlySeries(list || incidents);
    safeChart('reportChart', { type: 'line', data: { labels: monthly.labels, datasets: [{ label: 'Accidents', data: monthly.totals, borderColor: '#1a56db', backgroundColor: 'rgba(26,86,219,.1)', fill: true, tension: .4, borderWidth: 2 }] }, options: { ...chartDefaults, plugins: { legend: { display: true, position: 'top', labels: { usePointStyle: true, boxWidth: 8, font: { size: 11 } } } }, scales: { y: { grid: { color: '#f1f5f9' } }, x: { grid: { display: false }, ticks: { font: { size: 10 } } } } } });
}

// ===== SHARED SUMMARY (server-computed, same numbers as the resident pages) =====
let summaryCache = null;
async function loadSummary() {
    try { summaryCache = await api.getSummary(); }
    catch (error) { console.error('Failed to load summary:', error); }
    return summaryCache;
}
function monthKeyLabel(key, long = false) {
    if (!key) return '—';
    const [y, m] = String(key).split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: long ? 'long' : 'short', year: 'numeric' });
}
function safetyColor(score) { return score >= 75 ? '#16a34a' : score >= 50 ? '#f59e0b' : '#dc2626'; }
function safetyPill(level) { return level === 'Good' ? 'risk-low' : level === 'Fair' ? 'risk-med' : 'risk-high'; }

// ===== FORECAST (next-month predictions from the Python Random Forest) =====
let forecastRows = [];

function forecastMonthLabel(key) {
    if (!key) return '—';
    const [y, m] = String(key).split('-');
    return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

async function initForecastPage() {
    const tableBody = document.getElementById('fcTableBody');
    let predictions = [];
    try {
        predictions = await api.getPredictions();
    } catch (error) {
        if (tableBody) tableBody.innerHTML = `<tr><td colspan="10" style="text-align:center;color:#dc2626;padding:24px;"><i class="fas fa-triangle-exclamation"></i> ${escapeMapHtml(error.message)}</td></tr>`;
        return;
    }

    const first = predictions[0] || {};
    const usingForest = predictions.length && predictions.every(p => p.forecastModel === 'random-forest');

    // The newest month any area has history for is "last month"; the forecast is the one after.
    const lastMonth = predictions.reduce((latest, p) => {
        const m = p.history && p.history.length ? p.history[p.history.length - 1].month : '';
        return m > latest ? m : latest;
    }, '');
    const countIn = (p, month) => (p.history || []).find(h => h.month === month)?.count || 0;

    forecastRows = predictions
        .map(p => {
            const last = countIn(p, lastMonth);
            const change = last > 0 ? (p.predictedNextMonth - last) / last * 100 : null;
            return { ...p, lastMonthCount: last, changePct: change };
        })
        .sort((a, b) => b.predictedNextMonth - a.predictedNextMonth);

    // --- stat cards ---
    const total = forecastRows.reduce((sum, p) => sum + p.predictedNextMonth, 0);
    const lastTotal = forecastRows.reduce((sum, p) => sum + p.lastMonthCount, 0);
    document.getElementById('fcStatMonth').textContent = forecastMonthLabel(first.forecastMonth);
    document.getElementById('fcStatTotal').textContent = total.toLocaleString();
    document.getElementById('fcStatUp').textContent = `${forecastRows.filter(p => p.trend === 'up').length} / ${forecastRows.length}`;
    const bt = usingForest ? first.forecastBacktest : null;
    document.getElementById('fcStatAccuracy').textContent = bt ? `±${bt.maeForest}` : '—';
    document.getElementById('fcStatAccuracyLabel').textContent = bt
        ? `Avg error per area (straight line: ±${bt.maeLinear})`
        : 'Forecast error (not tested yet)';

    document.getElementById('fcModelTag').textContent = usingForest ? 'Model: Random Forest (Python)' : 'Model: linear trend (heuristic)';
    document.getElementById('fcModelNote').innerHTML = usingForest
        ? `<i class="fas fa-diagram-project" style="color:var(--blue);"></i> Predictions for <b>${forecastMonthLabel(first.forecastMonth)}</b> come from a Random Forest (Python / scikit-learn) trained on every barangay's monthly history — the last three months, the 3-, 6- and 12-month averages and the time of year.`
          + (bt ? ` Tested on ${forecastMonthLabel(bt.month)}, which it had not seen, it was off by <b>${bt.maeForest}</b> accidents per area on average; a straight-line trend was off by ${bt.maeLinear}.` : '')
          + ` Last month the city recorded <b>${lastTotal.toLocaleString()}</b>; the forecast is <b>${total.toLocaleString()}</b>.`
        : '<i class="fas fa-triangle-exclamation" style="color:#d97706;"></i> Not enough monthly history to train the forecast model yet — predictions use a straight-line trend per area.';

    // --- table ---
    const trendIcon = { up: '▲', down: '▼', stable: '■' };
    const trendColor = { up: '#dc2626', down: '#16a34a', stable: '#64748b' };
    const levelClass = { high: 'risk-high', medium: 'risk-med', low: 'risk-low' };
    tableBody.innerHTML = forecastRows.map((p, n) => {
        const change = p.changePct === null ? '—'
            : `<span style="color:${p.changePct > 0 ? '#dc2626' : p.changePct < 0 ? '#16a34a' : '#64748b'};font-weight:600;">${p.changePct > 0 ? '+' : ''}${p.changePct.toFixed(0)}%</span>`;
        return `<tr>
            <td>${n + 1}</td>
            <td style="font-weight:600;">${escapeMapHtml(p.barangay)}</td>
            <td>${escapeMapHtml(p.road)}</td>
            <td>${p.totalIncidents.toLocaleString()}</td>
            <td>${p.lastMonthCount.toLocaleString()}</td>
            <td style="font-weight:700;">${p.predictedNextMonth.toLocaleString()}</td>
            <td>${change}</td>
            <td style="color:${trendColor[p.trend]};font-weight:700;">${trendIcon[p.trend] || '■'} ${escapeMapHtml(p.trend)}</td>
            <td>${p.riskScore.toFixed(1)} / 10</td>
            <td><span class="risk-pill ${levelClass[p.riskLevel] || 'risk-low'}">${escapeMapHtml(p.riskLevel)}</span></td>
        </tr>`;
    }).join('') || `<tr><td colspan="10" style="text-align:center;color:var(--gray-400);padding:24px;">No forecasts yet. Record accidents on the <strong>Accident Records</strong> page to build the forecast.</td></tr>`;

    // --- city trend: every area's history summed per month, then next month's forecast ---
    const byMonth = {};
    forecastRows.forEach(p => (p.history || []).forEach(h => { byMonth[h.month] = (byMonth[h.month] || 0) + h.count; }));
    const months = Object.keys(byMonth).sort().slice(-18);
    const labels = months.map(m => forecastMonthLabel(m).replace(/ (\d{2})(\d{2})$/, " '$2"));
    const actual = months.map(m => byMonth[m]);
    if (first.forecastMonth) {
        labels.push(forecastMonthLabel(first.forecastMonth).replace(/ (\d{2})(\d{2})$/, " '$2") + ' (forecast)');
    }
    // The forecast line starts at the last real month so the two lines join up.
    const forecastLine = months.map((m, i) => (i === months.length - 1 ? actual[i] : null));
    if (first.forecastMonth) { actual.push(null); forecastLine.push(total); }

    safeChart('fcCityChart', {
        type: 'line',
        data: {
            labels,
            datasets: [
                { label: 'Recorded', data: actual, borderColor: '#1a56db', backgroundColor: 'rgba(26,86,219,.12)', fill: true, tension: .35, pointRadius: 2 },
                { label: 'Forecast', data: forecastLine, borderColor: '#7c3aed', borderDash: [6, 4], pointRadius: 5, pointBackgroundColor: '#7c3aed', fill: false, spanGaps: false }
            ]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } } }, scales: { y: { beginAtZero: true } } }
    });

    safeChart('fcBarangayChart', {
        type: 'bar',
        data: {
            labels: forecastRows.map(p => p.barangay),
            datasets: [
                { label: `Last month (${forecastMonthLabel(lastMonth)})`, data: forecastRows.map(p => p.lastMonthCount), backgroundColor: 'rgba(148,163,184,.7)', borderRadius: 3 },
                { label: `Predicted (${forecastMonthLabel(first.forecastMonth)})`, data: forecastRows.map(p => p.predictedNextMonth), backgroundColor: 'rgba(124,58,237,.8)', borderRadius: 3 }
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } } },
            scales: { x: { ticks: { autoSkip: false, maxRotation: 70, minRotation: 50, font: { size: 9 } } }, y: { beginAtZero: true } }
        }
    });
}

function exportForecastCsv() {
    if (!forecastRows.length) { showToast('⚠️ Open the forecast first — nothing to export yet.'); return; }
    const month = forecastRows[0].forecastMonth || '';
    const header = ['Barangay', 'Road', 'Recorded', 'Last Month', `Predicted ${month}`, 'Change %', 'Trend', 'Risk Score', 'Level', 'Model'];
    const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [header.map(cell).join(',')].concat(forecastRows.map(p => [
        p.barangay, p.road, p.totalIncidents, p.lastMonthCount, p.predictedNextMonth,
        p.changePct === null ? '' : p.changePct.toFixed(1), p.trend, p.riskScore.toFixed(1), p.riskLevel,
        p.forecastModel === 'random-forest' ? 'Random Forest' : 'Linear trend'
    ].map(cell).join(',')));
    const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `RIMAS_Forecast_${month || today()}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('📄 Forecast exported');
}

async function initHotspotCharts() {
    const statCritical = document.getElementById('hsStatCritical');
    const statMedium = document.getElementById('hsStatMedium');
    const statLow = document.getElementById('hsStatLow');
    const statAvg = document.getElementById('hsStatAvg');
    const tableBody = document.getElementById('hotspotTableBody');
    if (tableBody) tableBody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--gray-400);padding:24px;"><i class="fas fa-spinner fa-spin"></i> Loading predictions…</td></tr>`;

    let predictions = [];
    try {
        predictions = await api.getPredictions();
    } catch (error) {
        if (tableBody) tableBody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:#dc2626;padding:24px;"><i class="fas fa-triangle-exclamation"></i> ${error.message}</td></tr>`;
        return;
    }

    const high = predictions.filter(p => p.riskLevel === 'high').length;
    const medium = predictions.filter(p => p.riskLevel === 'medium').length;
    const low = predictions.filter(p => p.riskLevel === 'low').length;
    const avgScore = predictions.length ? (predictions.reduce((a, p) => a + p.riskScore, 0) / predictions.length) : 0;
    if (statCritical) statCritical.textContent = high;
    if (statMedium) statMedium.textContent = medium;
    if (statLow) statLow.textContent = low;
    if (statAvg) statAvg.textContent = avgScore.toFixed(1);

    const modelBadge = document.getElementById('hsModelBadge');
    if (modelBadge) {
        // Two Python models: the forecast forest (next month's count) and the severity forest
        // (how serious a place's accidents tend to be). Each is reported on its own.
        const first = predictions[0] || {};
        const forecastForest = predictions.length && predictions.every(p => p.forecastModel === 'random-forest');
        const severityForest = predictions.length && predictions.every(p => p.mlModel === 'random-forest');
        const bt = first.forecastBacktest;
        const forecastLine = forecastForest
            ? `<i class="fas fa-diagram-project" style="color:var(--blue);"></i> Next-month counts come from a Random Forest trained on every barangay's monthly history (Python / scikit-learn).`
              + (bt ? ` Tested on ${escapeMapHtml(bt.month)}: off by ${bt.maeForest} accidents per area on average, vs ${bt.maeLinear} for a straight-line trend.` : '')
            : '<i class="fas fa-triangle-exclamation" style="color:#d97706;"></i> Not enough monthly history to train the forecast model yet — using a straight-line trend.';
        const severityLine = severityForest
            ? ' Risk is also adjusted by a Random Forest severity model.'
            : ' The severity model is waiting for records with mixed severities (Fatal / Injury / Minor / Damage).';
        modelBadge.innerHTML = predictions.length ? forecastLine + severityLine : '';
    }

    if (tableBody) {
        if (!predictions.length) {
            tableBody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--gray-400);padding:24px;">No prediction data yet. Record accidents on the <strong>Accident Records</strong> page to build the forecast.</td></tr>`;
        } else {
            const pillClass = { high: 'risk-high', medium: 'risk-med', low: 'risk-low' };
            tableBody.innerHTML = predictions.slice(0, 8).map((p, i) => `
                <tr>
                    <td><strong>${i + 1}</strong></td>
                    <td>${p.road && p.road !== 'Unknown' && p.road !== 'All Roads' ? `${escapeMapHtml(p.road)} <span style="color:var(--gray-400);">— ${escapeMapHtml(p.barangay)}</span>` : escapeMapHtml(p.barangay)}</td>
                    <td>${p.totalIncidents.toLocaleString()}</td>
                    <td>${p.riskScore.toFixed(1)}</td>
                    <td><span class="risk-pill ${pillClass[p.riskLevel]}">${p.riskLevel.toUpperCase()}</span></td>
                </tr>`).join('');
        }
    }

    const topRoads = predictions.slice(0, 6);
    const levelColor = { high: '#dc2626', medium: '#f59e0b', low: '#22c55e' };
    const placeName = p => (p.road && p.road !== 'Unknown' && p.road !== 'All Roads') ? `${p.road} (${p.barangay})` : p.barangay;
    safeChart('hotspotChart', { type: 'bar', data: { labels: topRoads.map(placeName), datasets: [{ data: topRoads.map(p => p.totalIncidents), backgroundColor: topRoads.map(p => levelColor[p.riskLevel]), borderRadius: 6 }] }, options: { ...chartDefaults, indexAxis: 'y', scales: { x: { grid: { color: '#f1f5f9' } }, y: { grid: { display: false }, ticks: { font: { size: 10 } } } } } });
    safeChart('riskDonut', { type: 'doughnut', data: { labels: ['High', 'Medium', 'Low'], datasets: [{ data: [high, medium, low], backgroundColor: ['#dc2626', '#f59e0b', '#22c55e'], borderWidth: 3, borderColor: 'white' }] }, options: { ...chartDefaults, cutout: '65%', plugins: { legend: { display: true, position: 'bottom', labels: { usePointStyle: true, boxWidth: 8, font: { size: 10 } } } } } });

    const hourBuckets = new Array(12).fill(0);
    incidents.forEach(record => {
        const h = parseIncidentHour(record);
        if (h !== null) hourBuckets[Math.floor(h / 2)] += 1;
    });
    const hourPeak = Math.max(1, ...hourBuckets);
    safeChart('peakHoursChart', { type: 'bar', data: { labels: ['12AM', '2AM', '4AM', '6AM', '8AM', '10AM', '12PM', '2PM', '4PM', '6PM', '8PM', '10PM'], datasets: [{ data: hourBuckets, backgroundColor: (ctx) => { const v = ctx.raw / hourPeak; return v > 0.85 ? '#dc2626' : v > 0.65 ? '#f59e0b' : v > 0.4 ? '#fbbf24' : '#22c55e'; }, borderRadius: 5 }] }, options: { ...chartDefaults, scales: { y: { grid: { color: '#f1f5f9' } }, x: { grid: { display: false }, ticks: { font: { size: 9 } } } } } });
}

async function initSafetyCharts() {
    // The Safety Index is computed once on the server (SafetyIndexService) — the admin
    // console and the resident Safety Index page show the same score.
    const gaugeArc = document.getElementById('safetyGaugeArc');
    const gaugeScore = document.getElementById('safetyGaugeScore');
    const gaugeBadge = document.getElementById('safetyGaugeBadge');
    const categoriesEl = document.getElementById('safetyCategories');
    const barangayList = document.getElementById('safetyBarangayList');
    const recsEl = document.getElementById('safetyRecommendations');

    const summary = await loadSummary();
    const safety = summary?.safety;
    if (!safety || safety.overall === null) {
        if (barangayList) barangayList.innerHTML = '<div style="text-align:center;color:var(--gray-400);font-size:12px;padding:12px;">No data yet.</div>';
        if (recsEl) recsEl.innerHTML = '';
        if (gaugeBadge) gaugeBadge.textContent = 'NO DATA';
        return;
    }

    const overall = safety.overall;
    const color = safetyColor(overall);
    if (gaugeArc) { gaugeArc.setAttribute('stroke', color); gaugeArc.setAttribute('stroke-dasharray', `${(overall / 100) * 314} 314`); }
    if (gaugeScore) { gaugeScore.textContent = overall; gaugeScore.style.color = color; }
    if (gaugeBadge) { gaugeBadge.textContent = safety.level.toUpperCase(); gaugeBadge.className = `risk-pill ${safetyPill(safety.level)}`; }

    if (categoriesEl) {
        categoriesEl.innerHTML = safety.categories.map(c => `
            <div title="${escapeMapHtml(c.why)}">
                <div style="display:flex;justify-content:space-between;font-size:11.5px;"><span style="font-weight:600;">${escapeMapHtml(c.name)}</span><strong style="color:${safetyColor(c.score)};">${c.score}</strong></div>
                <div style="font-size:10.5px;color:var(--gray-400);line-height:1.35;">${escapeMapHtml(c.detail || c.why)}</div>
            </div>`).join('')
            + safety.excluded.map(e => `<div style="font-size:10.5px;color:var(--gray-400);line-height:1.35;"><i class="fas fa-circle-info"></i> <b>${escapeMapHtml(e.name)}</b> not scored — ${escapeMapHtml(e.reason)}</div>`).join('');
    }

    if (barangayList) {
        barangayList.innerHTML = safety.byBarangay.map(b => {
            const c = safetyColor(b.score);
            return `<div class="risk-bar-item" title="${b.earlierAvg} → ${b.recentAvg} accidents a month">
                <div class="risk-bar-label">${escapeMapHtml(b.barangay)}</div>
                <div class="risk-bar-track"><div class="risk-bar-fill" style="width:${b.score}%;background:${c};"></div></div>
                <div class="risk-count" style="color:${c};">${b.score}</div>
            </div>`;
        }).join('');
    }

    if (recsEl) {
        const cards = [];
        const card = (bg, fg, border, title, text) => `<div style="background:${bg};border-radius:8px;padding:12px;font-size:12px;color:${fg};border-left:3px solid ${border};"><strong>${title}</strong> ${text}</div>`;
        (safety.rising || []).slice(0, 2).forEach(b => cards.push(card('#fef2f2', '#dc2626', '#dc2626', '🚨 Rising:',
            `${escapeMapHtml(b.barangay)} went from ${b.earlierAvg} to ${b.recentAvg} accidents a month — review enforcement and road conditions there.`)));
        const worst = safety.byBarangay[0];
        if (worst && !(safety.rising || []).some(r => r.barangay === worst.barangay)) cards.push(card('#fff7ed', '#ea580c', '#f59e0b', '⚠️ Lowest score:',
            `${escapeMapHtml(worst.barangay)} (${worst.score}/100) averages ${worst.recentAvg} accidents a month.`));
        const hours = summary.byHour || [];
        if (hours.length === 24) {
            let best = 0;
            for (let h = 0; h < 24; h++) if (hours[h] + hours[(h + 1) % 24] > hours[best] + hours[(best + 1) % 24]) best = h;
            cards.push(card('#eff6ff', '#1d4ed8', '#3b82f6', '🕒 Peak hours:',
                `Most accidents happen ${hourLabel(best)}–${hourLabel((best + 2) % 24)}; schedule enforcement then.`));
        }
        const spread = safety.categories.find(c => c.key === 'spread');
        if (spread && spread.score < 50) cards.push(card('#f8fafc', '#334155', '#94a3b8', '📍 Concentration:', escapeMapHtml(spread.detail) + '.'));
        recsEl.innerHTML = cards.join('') || card('#f0fdf4', '#16a34a', '#22c55e', '✅', 'No barangay shows a meaningful rise.');
    }

    const note = document.getElementById('safetyTrendNote');
    if (note) note.textContent = safety.trend.length ? `Each point scores the 9 months up to that month · ${monthKeyLabel(safety.trend[0].month)} – ${monthKeyLabel(safety.trend[safety.trend.length - 1].month)}` : '';
    safeChart('safetyTrendChart', { type: 'line', data: { labels: safety.trend.map(t => monthKeyLabel(t.month)), datasets: [{ label: 'Safety Index', data: safety.trend.map(t => t.score), borderColor: '#22c55e', backgroundColor: 'rgba(34,197,94,.1)', fill: true, tension: .35, pointRadius: 4, pointBackgroundColor: '#22c55e', pointBorderColor: 'white', pointBorderWidth: 2 }, { label: 'Good (75)', data: safety.trend.map(() => 75), borderColor: '#94a3b8', borderDash: [5, 5], borderWidth: 1.5, pointRadius: 0, fill: false }] }, options: { ...chartDefaults, plugins: { legend: { display: true, position: 'top', labels: { usePointStyle: true, boxWidth: 8, font: { size: 11 } } } }, scales: { y: { min: 0, max: 100, grid: { color: '#f1f5f9' } }, x: { grid: { display: false }, ticks: { font: { size: 10 } } } } } });
}

async function initDashCharts() {
    // Every figure on Home comes from the records: the charts from `incidents`, the alerts
    // and barangay tiles from the server's Safety Index (the same one residents see).
    const monthly = buildMonthlySeries(incidents, 12);
    safeChart('dashTrendChart', { type: 'line', data: { labels: monthly.labels, datasets: [{ label: 'Accidents', data: monthly.totals, borderColor: '#1a56db', backgroundColor: 'rgba(26,86,219,.1)', fill: true, tension: .4, pointRadius: 3, borderWidth: 2 }, { label: 'Injury / Fatal', data: monthly.injuries, borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,.06)', fill: true, tension: .4, pointRadius: 3, borderWidth: 2 }] }, options: { ...chartDefaults, plugins: { legend: { display: true, position: 'top', labels: { usePointStyle: true, boxWidth: 8, font: { size: 11 } } } }, scales: { y: { beginAtZero: true, grid: { color: '#f1f5f9' } }, x: { grid: { display: false }, ticks: { font: { size: 10 } } } } } });

    const SEV = [['Fatal', '#dc2626'], ['Injury', '#eab308'], ['Minor', '#16a34a']];
    const sevCounts = SEV.map(([sev]) => incidents.filter(r => r.sev === sev || (sev === 'Minor' && r.sev === 'Damage')).length);
    safeChart('dashSevDonut', { type: 'doughnut', data: { labels: SEV.map(([s]) => s), datasets: [{ data: sevCounts, backgroundColor: SEV.map(([, c]) => c), borderWidth: 3, borderColor: 'white', hoverOffset: 4 }] }, options: { ...chartDefaults, cutout: '72%' } });
    const legend = document.getElementById('dashSevLegend');
    if (legend) {
        const used = sevCounts.filter(c => c > 0).length;
        legend.innerHTML = SEV.map(([sev, color], i) => `
            <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
                <span style="display:flex;align-items:center;gap:5px;"><span style="width:8px;height:8px;border-radius:50%;background:${color};display:inline-block;"></span>${sev}</span>
                <strong>${sevCounts[i].toLocaleString()}</strong></div>`).join('')
            + (incidents.length && used <= 1 ? `<div style="margin-top:6px;color:var(--gray-400);line-height:1.4;">Every record has the same severity — severity isn't being recorded yet.</div>` : '');
    }

    const [summary, predictions] = await Promise.all([
        loadSummary(),
        api.getPredictions().catch(() => [])
    ]);
    updateHomeStats(predictions);
    renderDashAlerts(summary, predictions);
    renderDashBarangayTiles(summary);
}

function renderDashAlerts(summary, predictions) {
    const box = document.getElementById('dashAlerts');
    if (!box) return;
    const safety = summary?.safety;
    const latest = summary?.latestMonth;
    const when = document.getElementById('dashAlertsWhen');
    if (when) when.textContent = latest ? `Latest month: ${monthKeyLabel(latest.month)}` : '';

    const alerts = [];
    (safety?.rising || []).slice(0, 2).forEach(b => alerts.push({
        color: 'var(--red)', title: `Rising – ${b.barangay}`,
        text: `${b.earlierAvg} → ${b.recentAvg} accidents a month${b.changePct !== null ? ` (+${b.changePct}%)` : ''}, last 3 months vs the 6 before`
    }));
    const busiest = [...(safety?.byBarangay || [])].sort((a, b) => b.latestMonth - a.latestMonth)[0];
    if (busiest && latest) alerts.push({
        color: 'var(--orange)', title: `Most accidents – ${busiest.barangay}`,
        text: `${busiest.latestMonth.toLocaleString()} of ${latest.count.toLocaleString()} accidents in ${monthKeyLabel(latest.month)}`
    });
    const top = predictions[0];
    if (top && alerts.length < 3) alerts.push({
        color: 'var(--orange)', title: `Highest forecast – ${top.barangay}`,
        text: `${top.predictedNextMonth} accidents predicted for ${monthKeyLabel(top.forecastMonth)}`
    });

    box.innerHTML = alerts.length ? alerts.map((a, i) => `
        <div style="padding:10px 16px;${i < alerts.length - 1 ? 'border-bottom:1px solid var(--gray-100);' : ''}font-size:12px;">
            <div style="color:${a.color};font-weight:700;margin-bottom:2px;"><i class="fas fa-circle" style="font-size:7px;margin-right:5px;"></i>${escapeMapHtml(a.title)}</div>
            <div style="color:var(--gray-500);">${escapeMapHtml(a.text)}</div>
        </div>`).join('')
        : '<div style="padding:10px 16px;font-size:12px;color:#16a34a;"><i class="fas fa-check-circle"></i> No barangay shows a meaningful rise.</div>';
}

function renderDashBarangayTiles(summary) {
    const box = document.getElementById('dashBarangayTiles');
    if (!box) return;
    const list = summary?.safety?.byBarangay || [];
    const gradient = { 'Needs attention': '#dc2626,#b91c1c', Fair: '#f59e0b,#d97706', Good: '#22c55e,#15803d' };
    box.innerHTML = list.slice(0, 4).map(b => `
        <div style="background:linear-gradient(135deg,${gradient[b.level] || '#3b82f6,#1d4ed8'});border-radius:10px;padding:14px;color:white;text-align:center;cursor:pointer;" onclick="showPage('safety')" title="${b.earlierAvg} → ${b.recentAvg} accidents a month">
            <div style="font-size:22px;font-weight:800;">${b.score}<span style="font-size:12px;opacity:.7;"> / 100</span></div>
            <div style="font-size:11px;opacity:.9;margin-top:2px;">${escapeMapHtml(b.barangay)}</div>
            <div style="font-size:10px;opacity:.7;text-transform:uppercase;">${escapeMapHtml(b.level)}</div>
        </div>`).join('') || '<div style="grid-column:1/-1;font-size:12px;color:var(--gray-400);">No barangay data yet.</div>';
}

function renderDashRecent() {
    const tbody = document.getElementById('dashRecentBody');
    if (!tbody) return;
    const rows = incidents.slice(0, 4);
    tbody.innerHTML = rows.map(r => {
        const idx = incidents.indexOf(r);
        return `<tr>
                    <td><span class="incident-id" onclick="showPage('incidents');setTimeout(()=>openDetailModal(${idx}),100)">${r.id}</span></td>
                    <td style="font-size:12px;">${r.date} · ${r.time}</td>
                    <td style="font-size:12px;">${r.road}</td>
                    <td>${getSevBadge(r.sev)}</td>
                    <td style="font-size:12px;">${r.type}</td>
                </tr>`;
    }).join('');
}

function updateHomeStats(predictions) {
    const total = incidents.length;
    const fatal = incidents.filter(r => r.sev === 'Fatal').length;
    const injury = incidents.filter(r => r.sev === 'Injury').length;
    const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
    set('homeStatTotal', total.toLocaleString());
    set('homeStatFatal', fatal.toLocaleString());
    set('homeStatInjury', injury.toLocaleString());

    // Latest month against the one before it.
    const monthly = buildMonthlySeries(incidents, 2);
    const [prev, last] = monthly.totals.length === 2 ? monthly.totals : [null, monthly.totals[0]];
    if (monthly.labels.length) {
        const change = prev ? Math.round((last - prev) / prev * 100) : null;
        set('homeFootTotal', `${monthly.labels[monthly.labels.length - 1]}: ${last.toLocaleString()}` + (change === null ? '' : ` (${change > 0 ? '+' : ''}${change}% vs month before)`));
    } else set('homeFootTotal', 'No records yet');

    const severityRecorded = new Set(incidents.map(r => r.sev)).size > 1;
    const share = n => total ? `${(n / total * 100).toFixed(1)}% of all accidents` : '—';
    set('homeFootFatal', severityRecorded ? share(fatal) : 'Severity not recorded yet');
    set('homeFootInjury', severityRecorded ? share(injury) : 'Severity not recorded yet');

    if (Array.isArray(predictions)) {
        const high = predictions.filter(p => p.riskLevel === 'high').length;
        set('homeStatRisk', high.toLocaleString());
        set('homeFootRisk', predictions.length ? `of ${predictions.length} areas — risk 7/10 or higher` : 'No forecast yet');
    }
}

// ===== SETTINGS =====
function populateSettings() {
    if (!currentUser) return;
    const parts = currentUser.name.split(' ');
    const el = id => document.getElementById(id);
    if (el('settingsGoogleAvatar')) { el('settingsGoogleAvatar').textContent = currentUser.avatar; el('settingsGoogleAvatar').style.background = currentUser.color; }
    if (el('settingsName')) el('settingsName').textContent = currentUser.name;
    if (el('settingsEmail2')) el('settingsEmail2').textContent = currentUser.email;
    if (el('settingsFirst')) el('settingsFirst').value = parts[0] || '';
    if (el('settingsLast')) el('settingsLast').value = parts.slice(1).join(' ') || '';
    if (el('settingsEmailInput')) el('settingsEmailInput').value = currentUser.email;
    if (el('settingsDept')) el('settingsDept').value = currentUser.dept || '';
    if (el('settingsRoleBadge')) el('settingsRoleBadge').innerHTML = currentUser.role === 'admin'
        ? '<span class="admin-badge"><i class="fas fa-shield-alt"></i> Administrator</span>'
        : '<span class="user-badge"><i class="fas fa-user"></i> User</span>';
    ['settingsSystemNav'].forEach(id => { const navEl = el(id); if (navEl) navEl.style.display = currentUser.role === 'admin' ? 'flex' : 'none'; });
}

function saveSettings() {
    if (currentUser) {
        const first = document.getElementById('settingsFirst').value.trim();
        const last = document.getElementById('settingsLast').value.trim();
        if (first || last) currentUser.name = `${first} ${last}`.trim();
        currentUser.dept = document.getElementById('settingsDept').value;
        document.getElementById('profileName').textContent = currentUser.name;
        const dw = document.getElementById('dashWelcome');
        if (dw) dw.textContent = `Welcome, ${currentUser.name.split(' ')[0]} 👋`;
    }
    showToast('✅ Settings saved successfully!');
}

function showSettingsTab(tab) {
    document.querySelectorAll('.settings-nav-item').forEach(i => i.classList.remove('active'));
    document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
    event.currentTarget.classList.add('active');
    const tabEl = document.getElementById('stab-' + tab); if (tabEl) tabEl.classList.add('active');
}

function toggleSwitch(checkbox) {
    const track = checkbox.nextElementSibling; const thumb = track?.nextElementSibling; if (!track || !thumb) return;
    if (checkbox.checked) { track.style.background = 'var(--blue)'; thumb.style.left = '21px'; }
    else { track.style.background = 'var(--gray-300)'; thumb.style.left = '3px'; }
}

// ===== USER TABLE (server-backed) =====
// Accounts come from the same database as the incidents, so every administrator sees the
// same user list and a role change takes effect for that person on any device.
let accountList = [];

async function renderUserTable() {
    const tbody = document.getElementById('userTableBody');
    if (!tbody) return;

    if (!isAdmin()) {
        tbody.innerHTML = '<tr><td colspan="6" style="padding:26px;text-align:center;color:var(--gray-400);">Administrator access is required to view user accounts.</td></tr>';
        return;
    }

    tbody.innerHTML = '<tr><td colspan="6" style="padding:26px;text-align:center;color:var(--gray-400);"><i class="fas fa-spinner fa-spin"></i> Loading users…</td></tr>';
    try {
        accountList = await api.getAccounts();
    } catch (error) {
        tbody.innerHTML = `<tr><td colspan="6" style="padding:26px;text-align:center;color:#dc2626;">${error.message}</td></tr>`;
        return;
    }

    if (!accountList.length) {
        tbody.innerHTML = '<tr><td colspan="6" style="padding:26px;text-align:center;color:var(--gray-400);">No accounts yet.</td></tr>';
        return;
    }

    tbody.innerHTML = accountList.map(u => {
        const lastLogin = u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : 'Never signed in';
        const isSelf = currentUser && u.id === currentUser.id;
        return `
                <tr>
                    <td><div style="display:flex;align-items:center;gap:10px;"><div style="width:32px;height:32px;border-radius:50%;background:${u.color};display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:white;">${u.avatar}</div><div><div style="font-weight:600;font-size:13px;">${u.name}${isSelf ? ' <span style="font-size:10px;color:var(--gray-400);">(you)</span>' : ''}</div><div style="font-size:10px;color:var(--gray-400);">${u.dept || ''}</div></div></div></td>
                    <td style="font-size:12px;color:var(--gray-500);">${u.email}<div style="font-size:10px;">${u.phone || ''}</div></td>
                    <td>${u.role === 'admin' ? '<span class="admin-badge"><i class="fas fa-shield-alt"></i> Admin</span>' : '<span class="user-badge"><i class="fas fa-user"></i> User</span>'}</td>
                    <td><span class="status-badge status-${u.status}">${u.status === 'active' ? '● Active' : '○ Inactive'}</span></td>
                    <td style="font-size:12px;color:var(--gray-500);">${lastLogin}</td>
                    <td><div style="display:flex;gap:5px;">
                        <button class="btn btn-sm" style="background:${u.status === 'active' ? '#fef2f2' : '#f0fdf4'};color:${u.status === 'active' ? '#dc2626' : '#16a34a'};border:1px solid ${u.status === 'active' ? '#fecaca' : '#bbf7d0'};" title="${u.status === 'active' ? 'Deactivate' : 'Reactivate'}" onclick="toggleUserStatus('${u.id}')"><i class="fas ${u.status === 'active' ? 'fa-ban' : 'fa-check'}"></i></button>
                        ${isSelf ? '' : `<button class="btn btn-sm" style="background:#fef2f2;color:#dc2626;border:1px solid #fecaca;" title="Remove account" onclick="deleteUserAccount('${u.id}')"><i class="fas fa-trash-alt"></i></button>`}
                    </div></td>
                </tr>
            `;
    }).join('');
}

function toggleUserStatus(id) {
    const account = accountList.find(a => a.id === id);
    if (!account) return;
    const status = account.status === 'active' ? 'inactive' : 'active';
    const apply = () => applyUserStatus(id, status);

    if (status === 'inactive') {
        openConfirmModal({
            title: 'Deactivate account?',
            message: `${account.name} will not be able to sign in until reactivated.`,
            icon: 'fas fa-ban',
            danger: true,
            confirmLabel: 'Deactivate',
            onConfirm: apply
        });
    } else {
        openConfirmModal({
            title: 'Reactivate account?',
            message: `${account.name} will be able to sign in again.`,
            icon: 'fas fa-check',
            danger: false,
            confirmLabel: 'Reactivate',
            onConfirm: apply
        });
    }
}

async function applyUserStatus(id, status) {
    try {
        await api.updateAccount(id, { status });
        showToast(status === 'active' ? '✅ User reactivated' : '🚫 User deactivated');
        renderUserTable();
    } catch (error) {
        showToast('⚠️ ' + error.message);
    }
}

function deleteUserAccount(id) {
    const account = accountList.find(a => a.id === id);
    if (!account) return;
    openConfirmModal({
        title: 'Remove account?',
        message: `This permanently deletes ${account.name}'s account. This action cannot be undone.`,
        icon: 'fas fa-trash-alt',
        danger: true,
        confirmLabel: 'Remove',
        onConfirm: async () => {
            try {
                await api.deleteAccount(id);
                showToast('🗑️ Account removed');
                renderUserTable();
            } catch (error) {
                showToast('⚠️ ' + error.message);
            }
        }
    });
}

// ===== NOTIFICATIONS =====
// The admin console's shared inbox — every administrator reads the same rows from the
// server, so a new resident sign-up shows up here (and on the bell) for all of them.
let notifications = [];
const NOTIF_STYLES = {
    account_created: { cssType: 'success', icon: 'fas fa-user-plus', iconBg: '#dcfce7', iconColor: '#16a34a' },
    account_removed: { cssType: 'alert', icon: 'fas fa-user-slash', iconBg: '#fee2e2', iconColor: '#dc2626' },
    incident_created: { cssType: 'warning', icon: 'fas fa-triangle-exclamation', iconBg: '#ffedd5', iconColor: '#ea580c' },
    incident_updated: { cssType: 'info', icon: 'fas fa-pen', iconBg: '#dbeafe', iconColor: '#2563eb' },
    profile_updated: { cssType: 'info', icon: 'fas fa-id-badge', iconBg: '#ede9fe', iconColor: '#7c3aed' },
    password_changed: { cssType: 'warning', icon: 'fas fa-key', iconBg: '#fef3c7', iconColor: '#d97706' }
};
const NOTIF_STYLE_DEFAULT = { cssType: 'info', icon: 'fas fa-bell', iconBg: '#dbeafe', iconColor: '#2563eb' };

function notifTimeAgo(iso) {
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return '';
    const diffSec = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (diffSec < 60) return 'just now';
    const diffMin = Math.round(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.round(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.round(diffHr / 24);
    return `${diffDay}d ago`;
}

// Highest `seq` this page has seen; the live check asks the server for anything after it.
let notifLatestSeq = null;
let notifPollBusy = false;
const NOTIF_POLL_MS = 4000;

async function loadNotifications() {
    try {
        notifications = await api.getNotifications();
        notifLatestSeq = notifications.reduce((max, n) => Math.max(max, n.seq || 0), 0);
    } catch (error) {
        console.error('Failed to load notifications:', error);
    }
    updateNotifBadges();
    if (document.getElementById('page-notifications')?.classList.contains('active')) paintNotifications();
}

/* Live updates. The server is PHP's single-threaded development server, so a connection
   held open for pushes would block every other request; instead the console asks a tiny
   "anything after seq N?" question every few seconds, and only while the tab is visible. */
async function pollNotifications() {
    if (notifPollBusy || notifLatestSeq === null || document.hidden) return;
    notifPollBusy = true;
    try {
        const change = await api.pollNotifications(notifLatestSeq);
        const fresh = (change.items || []).filter(item => !notifications.some(n => n.id === item.id));

        if (fresh.length) {
            notifications = [...fresh, ...notifications];
            const newest = fresh[0];
            showToast(fresh.length === 1 ? `🔔 ${newest.title}: ${newest.desc || ''}` : `🔔 ${fresh.length} new notifications`);
        }
        notifLatestSeq = Math.max(notifLatestSeq, change.latest || 0);

        // Another administrator read (or cleared) some: resync the whole list once.
        if (change.unread !== notifications.filter(n => n.unread).length) {
            await loadNotifications();
        } else if (fresh.length) {
            updateNotifBadges();
            if (document.getElementById('page-notifications')?.classList.contains('active')) paintNotifications();
        }
    } catch (error) {
        console.error('Notification check failed:', error);
    } finally {
        notifPollBusy = false;
    }
}

function startNotificationPolling() {
    setInterval(pollNotifications, NOTIF_POLL_MS);
    // Coming back to the tab catches up at once instead of waiting for the next tick.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) pollNotifications(); });
    window.addEventListener('focus', pollNotifications);
}

async function renderNotifications() {
    await loadNotifications();
    paintNotifications();
}

function paintNotifications() {
    const el = document.getElementById('notifList'); if (!el) return;
    if (notifications.length === 0) {
        el.innerHTML = '<div style="text-align:center;color:var(--gray-400);font-size:12px;padding:24px;">No notifications yet.</div>';
        return;
    }
    el.innerHTML = notifications.map(n => {
        const style = NOTIF_STYLES[n.type] || NOTIF_STYLE_DEFAULT;
        return `
                <div class="notif-item ${style.cssType} ${n.unread ? 'unread' : ''}" onclick="markOneRead('${n.id}')">
                    <div class="notif-icon" style="background:${style.iconBg};color:${style.iconColor};"><i class="${style.icon}"></i></div>
                    <div class="notif-body"><div class="notif-title">${escapeMapHtml(n.title)}</div><div class="notif-desc">${escapeMapHtml(n.desc || '')}</div><div class="notif-time"><i class="fas fa-clock" style="margin-right:4px;opacity:.6;"></i>${notifTimeAgo(n.createdAt)}</div></div>
                    ${n.unread ? '<div class="notif-unread-dot"></div>' : ''}
                </div>`;
    }).join('');
}

function updateNotifBadges() {
    const count = notifications.filter(n => n.unread).length;
    const bell = document.getElementById('bellBadge');
    const sb = document.getElementById('sbNotifCount');
    if (bell) bell.textContent = count;
    if (bell) bell.style.display = count ? 'flex' : 'none';
    if (sb) sb.textContent = count;
    if (sb) sb.style.display = count ? 'inline-block' : 'none';
}
async function markOneRead(id) {
    const n = notifications.find(x => x.id === id);
    if (!n || !n.unread) return;
    n.unread = false;
    paintNotifications();
    updateNotifBadges();
    try { await api.markNotificationRead(id); } catch (error) { console.error('markNotificationRead failed:', error); }
}
async function markAllRead() {
    if (notifications.every(n => !n.unread)) return;
    notifications.forEach(n => n.unread = false);
    paintNotifications();
    updateNotifBadges();
    try {
        await api.markAllNotificationsRead();
        showToast('All notifications marked as read');
    } catch (error) {
        console.error('markAllNotificationsRead failed:', error);
    }
}

document.querySelectorAll('.report-type-item').forEach(item => {
    item.addEventListener('click', () => { document.querySelectorAll('.report-type-item').forEach(i => i.classList.remove('active')); item.classList.add('active'); });
});

// ===== IMPORT / EXPORT SYSTEM =====
let importedRows = [];
let currentExportFmt = 'csv';
let currentReportFmt = 'pdf';

const COL_HEADERS = {
    id: 'Accident ID', date: 'Date', time: 'Time', loc: 'Municipality',
    barangay: 'Barangay', road: 'Road / Intersection', sev: 'Severity', type: 'Accident Type'
};

const MAX_IMPORT_BYTES = 25 * 1024 * 1024;
// Ordered so a more specific/less ambiguous field claims a header before a broader one gets
// a chance at it (e.g. "id" alone is too generic to test first, or it would grab any header
// that merely contains "id" as a substring, like "Residential Area").
const IMPORT_FIELD_MATCHERS = {
    date: h => h.includes('date') || h === 'occurred' || h.includes('dateoccurred') || h.includes('dateoccured'),
    time: h => h.includes('time') || h.includes('hour'),
    barangay: h => h.includes('barangay') || h.includes('brgy') || h.includes('district'),
    lat: h => h.includes('lat') || h.includes('latitude'),
    lng: h => h.includes('lng') || h.includes('lon') || h.includes('longitude'),
    road: h => h.includes('road') || h.includes('street') || h.includes('intersection') || h.includes('address')
        || h.includes('place') || h.includes('site') || h.includes('vicinity') || h.includes('corner')
        || (h.includes('location') && !h.includes('barangay')),
    sev: h => h.includes('sev') || h.includes('extent') || h.includes('gravity') || h.includes('casualty'),
    type: h => h.includes('type') || h.includes('category') || h.includes('nature') || h.includes('classification')
        || h.includes('cause') || h.includes('involvement') || h.includes('collision'),
    id: h => h === 'id' || h === 'no' || h.includes('caseno') || h.includes('caseid')
        || h.includes('referenceno') || h.includes('refno') || h.includes('recordid') || h.includes('reportno')
        || h.includes('incidentid') || h.includes('incidentno'),
};
// Real-world severity labels are almost never the literal words "Fatal"/"Injury"/"Minor"/
// "Damage" — spreadsheets use phrases like "Physical Injury", "Property Damage Only", "PDO",
// "Slight Injury". Match by keyword instead of requiring an exact value, ordered from the
// most specific bucket to the least so e.g. "minor injury" lands in Minor, not Injury.
const SEVERITY_KEYWORD_BUCKETS = [
    { bucket: 'Fatal', keywords: ['fatal', 'death', 'died', 'killed'] },
    { bucket: 'Minor', keywords: ['minor', 'slight', 'light'] },
    { bucket: 'Injury', keywords: ['injur', 'serious', 'hurt', 'wounded', 'casualty'] },
    { bucket: 'Damage', keywords: ['damage', 'pdo', 'property'] },
];
function classifySeverity(raw) {
    // Compare on a letters-only string so spacing/punctuation/case never matter, and check
    // negated phrases first — a naive substring match on the bare keyword would misread
    // "Non-Fatal" (contains "fatal") or "No Injury" (contains "injur") as the opposite of
    // what they mean.
    const compact = String(raw || '').toLowerCase().replace(/[^a-z]/g, '');
    if (!compact) return null;
    if (compact.includes('nonfatal') || compact.includes('notfatal')) return 'Injury';
    if (compact.includes('noinjury') || compact.includes('nocasualty') || compact.includes('nocasualties')) return 'Damage';
    const hit = SEVERITY_KEYWORD_BUCKETS.find(({ keywords }) => keywords.some(k => compact.includes(k)));
    return hit ? hit.bucket : null;
}
let knownBarangayNames = [];

function triggerImport() {
    document.getElementById('importModal').classList.add('open');
    setTimeout(() => document.getElementById('csvFileInput').click(), 100);
}

// Loads the 27 canonical Mandaluyong barangay names (reusing the GIS boundary data already
// used by the map) so imported rows can be auto-corrected against real names/typos.
async function ensureBarangayNames() {
    if (knownBarangayNames.length) return knownBarangayNames;
    if (mandaluyongBarangayCentroids.size) { knownBarangayNames = [...mandaluyongBarangayCentroids.keys()]; return knownBarangayNames; }
    for (const url of MANDALUYONG_GEOJSON_URLS) {
        try {
            const response = await fetch(url, { cache: 'no-store' });
            if (!response.ok) continue;
            const data = await response.json();
            if (Array.isArray(data.features) && data.features.length) {
                knownBarangayNames = data.features.map(f => f.properties?.brgy_name).filter(Boolean);
                break;
            }
        } catch { /* try next source */ }
    }
    return knownBarangayNames;
}

function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = 0; i <= a.length; i++) dp[i][0] = i;
    for (let j = 0; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
        }
    }
    return dp[a.length][b.length];
}

// Fuzzy-matches a spreadsheet's free-text barangay value against the real barangay list,
// tolerating case/spacing differences and small typos.
function matchBarangay(raw) {
    if (!raw || !knownBarangayNames.length) return null;
    const target = normalizeText(raw);
    if (!target) return null;
    const exact = knownBarangayNames.find(name => normalizeText(name) === target);
    if (exact) return exact;
    const contains = knownBarangayNames.find(name => normalizeText(name).includes(target) || target.includes(normalizeText(name)));
    if (contains) return contains;
    let best = null, bestDist = Infinity;
    knownBarangayNames.forEach(name => {
        const dist = levenshtein(normalizeText(name), target);
        if (dist < bestDist) { bestDist = dist; best = name; }
    });
    return bestDist <= 2 ? best : null;
}

function mapImportColumns(rawHeaders) {
    const colMap = {};
    Object.entries(IMPORT_FIELD_MATCHERS).forEach(([field, test]) => { colMap[field] = rawHeaders.findIndex(test); });
    return colMap;
}

const IMPORT_FIELD_LABELS = { date: 'Date', time: 'Time', barangay: 'Barangay', road: 'Road', sev: 'Severity', type: 'Type', lat: 'Latitude', lng: 'Longitude', id: 'ID' };
// Surfaces exactly which spreadsheet column each field was matched to (or that none was
// found) so a bad match — or the whole file defaulting silently — is visible before you
// commit the import, not discovered afterward in Analytics/Reports.
function summarizeColumnMapping(headerCells, colMap) {
    return Object.entries(IMPORT_FIELD_LABELS).map(([key, label]) => ({
        key, label,
        header: colMap[key] >= 0 ? headerCells[colMap[key]] : null
    }));
}

function buildImportRow(cols, colMap, rowIndex) {
    const get = key => colMap[key] >= 0 ? String(cols[colMap[key]] ?? '').trim() : '';
    const sevRaw = get('sev');
    const sevClassified = classifySeverity(sevRaw);
    const barangayRaw = get('barangay') || 'Unknown';
    const barangayMatch = matchBarangay(barangayRaw);
    const latRaw = get('lat'), lngRaw = get('lng');

    const warnings = [];
    if (!sevClassified && sevRaw) warnings.push(`Severity "${sevRaw}" unrecognized — set to Minor`);
    if (barangayMatch && normalizeText(barangayMatch) !== normalizeText(barangayRaw)) warnings.push(`Barangay "${barangayRaw}" auto-matched to "${barangayMatch}"`);

    return {
        id: get('id') || `#IMP-${String(rowIndex).padStart(4, '0')}`,
        date: get('date') || 'Unknown',
        time: get('time') || '',
        loc: 'Mandaluyong',
        barangay: barangayMatch || barangayRaw,
        road: get('road') || 'Unknown',
        sev: sevClassified || 'Minor',
        type: get('type') || 'Vehicular Collision',
        lat: latRaw ? Number.parseFloat(latRaw) : null,
        lng: lngRaw ? Number.parseFloat(lngRaw) : null,
        _warn: warnings.length ? warnings.join('; ') : null,
    };
}

function parseDelimitedRows(text) {
    const lines = text.trim().split('\n').map(l => l.replace(/\r/g, ''));
    if (lines.length < 2) return null;
    const headerCells = lines[0].split(',').map(h => h.trim());
    const dataRows = lines.slice(1).filter(l => l.trim()).map(l => l.split(',').map(c => c.trim().replace(/^"|"$/g, '')));
    return { headerCells, dataRows };
}

function parseWorkbookRows(arrayBuffer) {
    const wb = XLSX.read(arrayBuffer, { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
    if (aoa.length < 2) return null;
    const headerCells = aoa[0].map(h => String(h ?? '').trim());
    const dataRows = aoa.slice(1)
        .filter(row => row.some(cell => String(cell ?? '').trim() !== ''))
        .map(row => row.map(cell => String(cell ?? '').trim()));
    return { headerCells, dataRows };
}

// Auto-maps arbitrary column headers, corrects known-barangay typos, and flags likely
// duplicates against both the current import batch and what's already in the database.
async function processImportRows(headerCells, dataRows) {
    await ensureBarangayNames();
    const rawHeaders = headerCells.map(h => h.toLowerCase().replace(/[^a-z]/g, ''));
    const colMap = mapImportColumns(rawHeaders);
    const columnSummary = summarizeColumnMapping(headerCells, colMap);
    const seenKeys = new Set();
    const rows = [];
    const warnings = [];

    dataRows.forEach((cols, i) => {
        const row = buildImportRow(cols, colMap, i + 1);
        const dupKey = `${row.date}||${row.time}||${row.barangay}||${row.road}||${row.type}`.toLowerCase();
        const isDup = seenKeys.has(dupKey) || incidents.some(inc =>
            `${inc.date}||${inc.time}||${inc.barangay}||${inc.road}||${inc.type}`.toLowerCase() === dupKey);
        if (isDup) row._warn = row._warn ? `${row._warn}; Possible duplicate` : 'Possible duplicate of an existing accident';
        seenKeys.add(dupKey);
        if (row._warn) warnings.push(`Row ${i + 1}: ${row._warn}`);
        rows.push(row);
    });

    importedRows = rows;
    renderImportPreview(rows, warnings, columnSummary);
}

function importFile(file) {
    const name = file.name.toLowerCase();
    const isCsv = name.endsWith('.csv');
    const isExcel = name.endsWith('.xlsx') || name.endsWith('.xls');
    if (!isCsv && !isExcel) { showToast('⚠️ Please select a .csv, .xlsx, or .xls file'); return; }
    if (file.size > MAX_IMPORT_BYTES) { showToast(`⚠️ File is too large (max ${Math.round(MAX_IMPORT_BYTES / 1024 / 1024)}MB)`); return; }

    showToast(`⏳ Reading ${file.name}…`);
    const reader = new FileReader();
    reader.onerror = () => showToast('⚠️ Could not read the file');
    reader.onload = async (ev) => {
        try {
            const parsed = isCsv ? parseDelimitedRows(ev.target.result) : parseWorkbookRows(ev.target.result);
            if (!parsed) { showToast('⚠️ File is empty or has no data rows'); return; }
            await processImportRows(parsed.headerCells, parsed.dataRows);
        } catch (error) {
            console.error(error);
            showToast('⚠️ Could not parse the file: ' + error.message);
        }
    };
    if (isCsv) reader.readAsText(file); else reader.readAsArrayBuffer(file);
}

function handleCSVImport(e) {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) importFile(file);
}

function renderImportPreview(rows, warnings, columnSummary) {
    document.getElementById('importDropZone').style.display = 'none';
    const wrap = document.getElementById('importPreviewWrap');
    wrap.style.display = 'block';

    const summaryEl = document.getElementById('importColumnSummary');
    if (summaryEl && columnSummary) {
        summaryEl.innerHTML = columnSummary.map(c => c.header
            ? `<span style="display:inline-flex;align-items:center;gap:4px;background:#f0fdf4;color:#16a34a;border-radius:5px;padding:3px 8px;margin:0 6px 6px 0;font-size:11px;font-weight:600;">✓ ${c.label}: "${escapeMapHtml(c.header)}"</span>`
            : `<span style="display:inline-flex;align-items:center;gap:4px;background:#fef2f2;color:#dc2626;border-radius:5px;padding:3px 8px;margin:0 6px 6px 0;font-size:11px;font-weight:600;">✗ ${c.label}: not found</span>`
        ).join('');
    }

    document.getElementById('importPreviewCount').textContent = `${rows.length} row${rows.length !== 1 ? 's' : ''} ready to import`;
    document.getElementById('importErrorCount').textContent = warnings.length ? `⚠️ ${warnings.length} warning${warnings.length > 1 ? 's' : ''}` : '';
    document.getElementById('importConfirmBtn').style.display = 'flex';
    document.getElementById('importBtnCount').textContent = rows.length;

    const tbody = document.getElementById('importPreviewBody');
    tbody.innerHTML = rows.map(r => `
                <tr>
                    <td>${r._warn
            ? `<span title="${r._warn.replace(/"/g, '&quot;')}" style="color:#d97706;font-size:11px;font-weight:700;cursor:help;">⚠️ WARN</span>`
            : `<span style="color:#16a34a;font-size:11px;font-weight:700;">✅ OK</span>`}
                    </td>
                    <td style="font-size:12px;font-weight:600;color:var(--blue);">${r.id}</td>
                    <td style="font-size:12px;">${r.date}</td>
                    <td style="font-size:12px;">${r.time}</td>
                    <td style="font-size:12px;">${r.barangay}</td>
                    <td style="font-size:12px;">${r.road}</td>
                    <td>${getSevBadge(r.sev)}</td>
                    <td style="font-size:12px;">${r.type}</td>
                </tr>
            `).join('');
}

async function confirmImport() {
    if (!importedRows.length) return;
    const clean = importedRows.map(r => { const c = { ...r }; delete c._warn; return c; });
    const btn = document.getElementById('importConfirmBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Importing…'; }
    try {
        const result = await api.bulkCreateIncidents(clean);
        closeImportModal();
        await loadIncidentsFromServer();
        loadHotspotsFromServer();
        const skippedMsg = result.skippedCount ? `, ${result.skippedCount} skipped (duplicate/invalid)` : '';
        showToast(`✅ ${result.createdCount} accident${result.createdCount !== 1 ? 's' : ''} imported and saved${skippedMsg}`);
    } catch (error) {
        showToast('⚠️ Import failed: ' + error.message);
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = `<i class="fas fa-check"></i> Import <span id="importBtnCount">${clean.length}</span> Records`; }
    }
}

function closeImportModal() {
    document.getElementById('importModal').classList.remove('open');
    document.getElementById('importDropZone').style.display = 'block';
    document.getElementById('importPreviewWrap').style.display = 'none';
    document.getElementById('importConfirmBtn').style.display = 'none';
    importedRows = [];
}

function dragOver(e) { e.preventDefault(); e.currentTarget.style.borderColor = 'var(--blue)'; e.currentTarget.style.background = '#f0f7ff'; }
function dragLeave(e) { e.currentTarget.style.borderColor = ''; e.currentTarget.style.background = ''; }
function dropCSV(e) {
    e.preventDefault(); dragLeave(e);
    const file = e.dataTransfer.files[0];
    if (file) importFile(file);
}

function downloadTemplate() {
    const header = 'id,date,time,barangay,road,severity,type,latitude,longitude';
    const rows = [
        '#A06001,Apr 20 2024,08:30 AM,Plainview,Shaw Blvd near EDSA,Injury,Vehicular Collision',
        '#A06002,Apr 20 2024,02:15 PM,Highway Hills,Boni Ave,Fatal,Pedestrian Involved',
        '#A06003,Apr 21 2024,11:00 AM,Wack-Wack,EDSA,Minor,Single Vehicle',
    ];
    const csv = [header, ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'RIMAS_Import_Template.csv'; a.click();
    URL.revokeObjectURL(url);
    showToast('📥 Template downloaded!');
}

function openExportModal() {
    const sevF = document.getElementById('exportSevFilter').value;
    const filtered = sevF === 'all' ? incidents : incidents.filter(r => r.sev === sevF);
    document.getElementById('exportRowCount').innerHTML = `Exporting <strong>${filtered.length}</strong> accident records`;
    document.getElementById('exportModal').classList.add('open');
}
function closeExportModal() { document.getElementById('exportModal').classList.remove('open'); }

function setExportFmt(fmt) {
    currentExportFmt = fmt;
    ['csv', 'excel', 'pdf'].forEach(f => document.getElementById('efmt-' + f).classList.toggle('selected', f === fmt));
}

function getSelectedCols() {
    return [...document.querySelectorAll('.export-col:checked')].map(c => c.value);
}

function getExportData() {
    const sevF = document.getElementById('exportSevFilter').value;
    return sevF === 'all' ? [...incidents] : incidents.filter(r => r.sev === sevF);
}

function doExportNow() {
    const fmt = currentExportFmt;
    if (fmt === 'csv') exportCSV();
    else if (fmt === 'excel') exportExcel();
    else if (fmt === 'pdf') exportPDF();
    closeExportModal();
}

function exportCSV(data, filename) {
    const rows = data || getExportData();
    const cols = getSelectedCols();
    const headers = cols.map(c => COL_HEADERS[c] || c);
    const lines = [
        headers.join(','),
        ...rows.map(r => cols.map(c => `"${(r[c] || '').toString().replace(/"/g, '""')}"`).join(','))
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename || `RIMAS_Accidents_${today()}.csv`; a.click();
    URL.revokeObjectURL(url);
    showToast('✅ CSV exported successfully!');
}

function exportExcel(data, filename) {
    const rows = data || getExportData();
    const cols = getSelectedCols();
    const wsData = [
        cols.map(c => COL_HEADERS[c] || c),
        ...rows.map(r => cols.map(c => r[c] || ''))
    ];
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(wsData);

    ws['!cols'] = cols.map(() => ({ wch: 22 }));

    const range = XLSX.utils.decode_range(ws['!ref']);
    for (let C = range.s.c; C <= range.e.c; C++) {
        const cell = ws[XLSX.utils.encode_cell({ r: 0, c: C })];
        if (cell) cell.s = { font: { bold: true }, fill: { fgColor: { rgb: '0F1E3C' } }, font: { color: { rgb: 'FFFFFF' }, bold: true } };
    }

    XLSX.utils.book_append_sheet(wb, ws, 'Accidents');

    const summaryData = [
        ['RIMAS Export Summary', ''],
        ['Generated', new Date().toLocaleString()],
        ['Total Records', rows.length],
        ['Fatal', rows.filter(r => r.sev === 'Fatal').length],
        ['Injury', rows.filter(r => r.sev === 'Injury').length],
        ['Minor', rows.filter(r => r.sev === 'Minor').length],
        ['Damage Only', rows.filter(r => r.sev === 'Damage').length],
    ];
    const wsSummary = XLSX.utils.aoa_to_sheet(summaryData);
    wsSummary['!cols'] = [{ wch: 24 }, { wch: 20 }];
    XLSX.utils.book_append_sheet(wb, wsSummary, 'Summary');

    XLSX.writeFile(wb, filename || `RIMAS_Accidents_${today()}.xlsx`);
    showToast('✅ Excel file exported successfully!');
}

function exportPDF(data, filename) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const rows = data || getExportData();
    const cols = getSelectedCols();

    doc.setFillColor(15, 30, 60);
    doc.rect(0, 0, 297, 22, 'F');
    doc.setFontSize(13); doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold');
    doc.text('Mandaluyong Road Accident Mapping & Analytics System', 14, 10);
    doc.setFontSize(8); doc.setFont('helvetica', 'normal');
    doc.text('RIMAS — Accident Export Report', 14, 16);
    doc.text(`Generated: ${new Date().toLocaleString()}`, 200, 16);

    const total = rows.length;
    const fatal = rows.filter(r => r.sev === 'Fatal').length;
    const injury = rows.filter(r => r.sev === 'Injury').length;
    const minor = rows.filter(r => r.sev === 'Minor').length;

    const boxes = [
        { label: 'Total Records', val: total, color: [26, 86, 219] },
        { label: 'Fatal', val: fatal, color: [220, 38, 38] },
        { label: 'Injury', val: injury, color: [234, 179, 8] },
        { label: 'Minor / Damage', val: minor + rows.filter(r => r.sev === 'Damage').length, color: [22, 163, 74] },
    ];
    boxes.forEach((b, i) => {
        const x = 14 + i * 68;
        doc.setFillColor(...b.color);
        doc.roundedRect(x, 26, 62, 18, 2, 2, 'F');
        doc.setTextColor(255, 255, 255); doc.setFontSize(16); doc.setFont('helvetica', 'bold');
        doc.text(String(b.val), x + 31, 36, { align: 'center' });
        doc.setFontSize(7); doc.setFont('helvetica', 'normal');
        doc.text(b.label, x + 31, 41, { align: 'center' });
    });

    const headers = cols.map(c => COL_HEADERS[c] || c);
    const tableRows = rows.map(r => cols.map(c => r[c] || ''));

    const sevColors = { Fatal: [220, 38, 38], Injury: [234, 179, 8], Minor: [22, 163, 74], Damage: [22, 163, 74] };

    doc.autoTable({
        head: [headers],
        body: tableRows,
        startY: 48,
        margin: { left: 14, right: 14 },
        styles: { fontSize: 8, cellPadding: 3, lineColor: [226, 232, 240], lineWidth: 0.3 },
        headStyles: { fillColor: [15, 30, 60], textColor: 255, fontStyle: 'bold', fontSize: 8 },
        alternateRowStyles: { fillColor: [248, 250, 252] },
        didParseCell(data) {
            if (data.section === 'body') {
                const sevIdx = cols.indexOf('sev');
                if (sevIdx >= 0 && data.column.index === sevIdx) {
                    const sev = data.cell.raw;
                    const c = sevColors[sev] || [100, 116, 139];
                    data.cell.styles.textColor = c;
                    data.cell.styles.fontStyle = 'bold';
                }
            }
        },
        foot: [[...Array(cols.length - 1).fill(''), `Total: ${total} records`]],
        footStyles: { fillColor: [241, 245, 249], textColor: [71, 85, 105], fontStyle: 'bold', fontSize: 7 },
    });

    const pageCount = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
        doc.setPage(i);
        doc.setFontSize(7); doc.setTextColor(148, 163, 184);
        doc.text('Mandaluyong City TPMO — Confidential', 14, doc.internal.pageSize.height - 5);
        doc.text(`Page ${i} of ${pageCount}`, 280, doc.internal.pageSize.height - 5, { align: 'right' });
    }

    doc.save(filename || `RIMAS_Accidents_${today()}.pdf`);
    showToast('✅ PDF exported successfully!');
}

function exportReport(fmt) {
    fmt = fmt || currentReportFmt;
    if (fmt === 'pdf') exportPDF(incidents, `RIMAS_Report_${today()}.pdf`);
    else if (fmt === 'excel') exportExcel(incidents, `RIMAS_Report_${today()}.xlsx`);
    else exportCSV(incidents, `RIMAS_Report_${today()}.csv`);
}

function printReport() {
    window.print();
}

function selectFmt(btn, fmt) {
    currentReportFmt = fmt;
    document.querySelectorAll('.format-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
}

async function exportHotspot() {
    let predictions = [];
    try { predictions = await api.getPredictions(); } catch (error) { showToast('⚠️ ' + error.message); return; }
    if (!predictions.length) { showToast('⚠️ No prediction data yet to export'); return; }
    // Real columns: an area's risk is not an accident severity, so it is not written as one.
    const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = ['Rank', 'Barangay', 'Road', 'Recorded Accidents', `Predicted ${predictions[0].forecastMonth || 'next month'}`, 'Trend', 'Risk Score (0-10)', 'Risk Level'];
    const lines = [header.map(cell).join(',')].concat(predictions.map((p, i) => [
        i + 1, p.barangay, p.road, p.totalIncidents, p.predictedNextMonth, p.trend, p.riskScore.toFixed(1), p.riskLevel
    ].map(cell).join(',')));
    const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `RIMAS_Hotspots_${today()}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('📄 Hotspot risk table exported');
}

async function exportSafety() {
    const summary = await loadSummary();
    const safety = summary?.safety;
    if (!safety || !safety.byBarangay.length) { showToast('⚠️ No safety data yet to export'); return; }
    const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const w = safety.window || {};
    const lines = [
        ['Mandaluyong City Safety Index', `${safety.overall} / 100`, safety.level].map(cell).join(','),
        ...safety.categories.map(c => [c.name, c.score, c.detail || c.why].map(cell).join(',')),
        ...safety.excluded.map(e => [e.name, 'not scored', e.reason].map(cell).join(',')),
        '',
        ['Barangay', 'Safety Score (0-100)', 'Level', `Accidents/month ${w.recentFrom || ''} to ${w.recentTo || ''}`, `Accidents/month ${w.earlierFrom || ''} to ${w.earlierTo || ''}`, 'Change %', `Accidents in ${w.recentTo || 'latest month'}`].map(cell).join(','),
        ...safety.byBarangay.map(b => [b.barangay, b.score, b.level, b.recentAvg, b.earlierAvg, b.changePct ?? '', b.latestMonth].map(cell).join(','))
    ];
    const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `RIMAS_SafetyIndex_${today()}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('📄 Safety Index exported');
}

function today() {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

// ===== INIT =====
renderTable();
restoreDashboardSession();
