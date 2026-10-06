let currentUser = null;
const SESSION_KEY = 'rimasCurrentUser';

function applyDashboardUser(acc) {
    const avatar = document.getElementById('avatarBtn');
    if (avatar) avatar.textContent = acc.avatar;
    const chipName = document.getElementById('chipName');
    const chipRole = document.getElementById('chipRole');
    if (chipName) chipName.textContent = acc.name;
    if (chipRole) chipRole.textContent = acc.role === 'admin' ? 'Administrator' : 'Resident';
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

document.addEventListener('click', (e) => {
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
        throw new Error(['localhost', '127.0.0.1'].includes(location.hostname)
            ? 'Cannot reach the RIMAS server. Is start-mandasafe.bat running?'
            : 'The server is not responding right now. Please check your connection and try again in a moment.');
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
    bulkDeleteIncidents: (ids) => apiRequest('/api/incidents/bulk-delete', { method: 'POST', body: JSON.stringify({ ids }) }),
    updateIncident: (id, body) => apiRequest(`/api/incidents/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) }),
    deleteIncident: (id) => apiRequest(`/api/incidents/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    getPredictionInputs: () => apiRequest('/api/prediction-inputs'),
    createPredictionInput: (body) => apiRequest('/api/prediction-inputs', { method: 'POST', body: JSON.stringify(body) }),
    updatePredictionInput: (id, body) => apiRequest(`/api/prediction-inputs/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) }),
    deletePredictionInput: (id) => apiRequest(`/api/prediction-inputs/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    getPredictions: () => apiRequest('/api/predictions'),
    getProneAreas: () => apiRequest('/api/prone-areas'),
    getSeverity: () => apiRequest('/api/severity'),
    // Server-computed figures shared with the resident pages: monthly/hourly counts, the
    // Safety Index, and which fields are actually recorded.
    getSummary: () => apiRequest('/api/summary'),
    getStats: () => apiRequest('/api/stats'),
    getMe: () => apiRequest('/api/auth/me'),
    logout: () => apiRequest('/api/auth/logout', { method: 'POST' }),
    getAccounts: () => apiRequest('/api/accounts'),
    getAccountDetails: (id) => apiRequest(`/api/accounts/${encodeURIComponent(id)}`),
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
    populateIncidentFilterOptions();
    filteredIncidents = filterIncidentRecords();
    renderTable();
    syncIncidentSelection();
    updateHomeStats();
    renderDashRecent();
    if (document.getElementById('page-home')?.classList.contains('active')) initDashCharts();
    if (mandaluyongMapReady) renderMandaluyongMapLayers();
    return incidents;
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
    syncMapFilterOptions();
}

/* The records filters as they stand in the bar — the table, the count and the row selection
   all read these. */
function incidentFilterValues() {
    const value = id => document.getElementById(id)?.value || '';
    return {
        from: value('fltDateFrom'),
        to: value('fltDateTo'),
        barangay: value('fltBarangay') || 'all',
        road: value('fltRoad') || 'all',
        sev: value('fltSeverity') || 'all',
        type: value('fltVehicle') || 'all'
    };
}
function filterIncidentRecords() {
    const f = incidentFilterValues();
    return incidents.filter(r => {
        const d = String(r.date || '').slice(0, 10);
        if (f.barangay !== 'all' && r.barangay !== f.barangay) return false;
        if (f.road !== 'all' && r.road !== f.road) return false;
        if (f.sev !== 'all' && r.sev !== f.sev) return false;
        if (f.type !== 'all' && r.type !== f.type) return false;
        // ISO dates compare correctly as strings; one date alone means "from" or "up to" it.
        if (f.from && d < f.from) return false;
        if (f.to && d > f.to) return false;
        return true;
    });
}
/* ---- Row selection: tick rows (or "select all" for everything the filter lists), then
   "Delete selected". Only rows in the current filtered list can stay selected, so a filter
   change never leaves hidden rows queued for deletion. */
const selectedIncidentIds = new Set();

function syncIncidentSelection() {
    const visible = new Set(filteredIncidents.map(r => r.id));
    [...selectedIncidentIds].forEach(id => { if (!visible.has(id)) selectedIncidentIds.delete(id); });

    const count = selectedIncidentIds.size;
    const btn = document.getElementById('bulkDeleteBtn');
    if (btn) {
        btn.style.display = count ? '' : 'none';
        document.getElementById('bulkDeleteLabel').textContent = `Delete ${count.toLocaleString()} selected`;
    }
    const clearBtn = document.getElementById('clearSelectionBtn');
    if (clearBtn) clearBtn.style.display = count ? '' : 'none';

    const all = document.getElementById('selectAllIncidents');
    if (all) {
        all.checked = count > 0 && count === filteredIncidents.length;
        all.indeterminate = count > 0 && count < filteredIncidents.length;
        all.disabled = !filteredIncidents.length;
    }
    document.querySelectorAll('#incidentTableBody .row-select').forEach(box => {
        box.checked = selectedIncidentIds.has(box.dataset.id);
        box.closest('tr').classList.toggle('row-selected', box.checked);
    });
}
function toggleIncidentSelection(box) {
    if (box.checked) selectedIncidentIds.add(box.dataset.id); else selectedIncidentIds.delete(box.dataset.id);
    syncIncidentSelection();
}
function toggleSelectAllIncidents(checked) {
    filteredIncidents.forEach(r => { if (checked) selectedIncidentIds.add(r.id); else selectedIncidentIds.delete(r.id); });
    syncIncidentSelection();
}
function clearIncidentSelection() {
    selectedIncidentIds.clear();
    syncIncidentSelection();
}

function applyIncidentFilters() {
    // Keep the range the right way round.
    const fromInput = document.getElementById('fltDateFrom');
    const toInput = document.getElementById('fltDateTo');
    if (fromInput.value && toInput.value && fromInput.value > toInput.value) [fromInput.value, toInput.value] = [toInput.value, fromInput.value];
    filteredIncidents = filterIncidentRecords();
    renderTable();
    syncIncidentSelection();
    showToast(`🔍 Filter applied — ${filteredIncidents.length} result${filteredIncidents.length !== 1 ? 's' : ''}`);
}

function resetIncidentFilters() {
    ['fltBarangay','fltRoad', 'fltSeverity', 'fltVehicle'].forEach(id => { document.getElementById(id).value = 'all'; });
    document.getElementById('fltDateFrom').value = '';
    document.getElementById('fltDateTo').value = '';
    filteredIncidents = incidents.slice();
    renderTable();
    syncIncidentSelection();
    showToast('↺ Filters reset');
}

function askDeleteSelected() {
    const targets = filteredIncidents.filter(r => selectedIncidentIds.has(r.id));
    if (!targets.length) return;
    const count = targets.length.toLocaleString();
    const sample = targets.slice(0, 3).map(r => `${r.id} (${r.date})`).join(', ');
    openConfirmModal({
        title: `Delete ${count} selected accident${targets.length === 1 ? '' : 's'}?`,
        message: `This permanently deletes ${targets.length === 1 ? sample : `${sample}${targets.length > 3 ? ` and ${(targets.length - 3).toLocaleString()} more` : ''}`}. This cannot be undone.`,
        icon: 'fas fa-trash',
        danger: true,
        confirmLabel: `Delete ${count}`,
        onConfirm: () => deleteSelectedIncidents(targets)
    });
}

async function deleteSelectedIncidents(targets) {
    const btn = document.getElementById('bulkDeleteBtn');
    if (btn) btn.disabled = true;
    try {
        const result = await api.bulkDeleteIncidents(targets.map(r => r.id));
        const gone = new Set(targets.map(r => r.id));
        incidents = incidents.filter(r => !gone.has(r.id));
        gone.forEach(id => selectedIncidentIds.delete(id));
        populateIncidentFilterOptions();
        filteredIncidents = filterIncidentRecords();
        renderTable();
        syncIncidentSelection();
        updateHomeStats();
        renderDashRecent();
        if (mandaluyongMapReady) renderMandaluyongMapLayers();
        refreshPredictionViews();
        showToast(`🗑️ ${result.deletedCount.toLocaleString()} accident${result.deletedCount === 1 ? '' : 's'} deleted.`);
    } catch (error) {
        showToast('❌ ' + error.message);
    } finally {
        if (btn) btn.disabled = false;
    }
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
    const selected = selectedIncidentIds.has(r.id);
    return `
                <tr${selected ? ' class="row-selected"' : ''}>
                    <td><input type="checkbox" class="row-select" data-id="${escapeMapHtml(r.id)}" ${selected ? 'checked' : ''} onchange="toggleIncidentSelection(this)" aria-label="Select ${escapeMapHtml(r.id)}"></td>
                    <td><span class="incident-id" onclick="openDetailModal(${realIdx})">${escapeMapHtml(r.id ?? '')}</span></td>
                    <td style="white-space:nowrap;">${escapeMapHtml(r.date ?? '')}</td><td style="white-space:nowrap;">${escapeMapHtml(r.time ?? '')}</td><td>${escapeMapHtml(r.loc ?? '')}</td><td>${escapeMapHtml(r.barangay ?? '')}</td><td>${escapeMapHtml(r.road ?? '')}</td>
                    <td>${getSevBadge(r.sev)}</td><td style="font-size:12px;">${escapeMapHtml(r.type ?? '')}</td>
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
        || `<tr><td colspan="10" style="text-align:center;color:var(--gray-400);padding:24px;">No accidents match your filters.</td></tr>`;
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
    return `<span class="sev ${map[sev] || 'sev-damage'}"><span class="sev-dot"></span>${escapeMapHtml(sev ?? '')}</span>`;
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
            return `<div class="search-result-item" onclick="jumpToIncident(${idx})"><strong>${escapeMapHtml(r.id ?? '')}</strong> — ${escapeMapHtml(r.road ?? '')}, ${escapeMapHtml(r.barangay ?? '')} <span style="float:right;">${getSevBadge(r.sev)}</span></div>`;
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
    if (page === 'map') { setTimeout(initMandaluyongMap, 0); loadIncidentsFromServer(); }
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
        filteredIncidents = filterIncidentRecords();
            closeModal();
        renderTable();
        syncIncidentSelection();
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
        filteredIncidents = filterIncidentRecords();
        renderTable();
        syncIncidentSelection();
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

/* The Reports page parameters, and the rows/preview they produced last (what Download uses). */
let lastReport = null;
function readReportFilters() {
    return {
        from: document.getElementById('reportDateFrom')?.value || '',
        to: document.getElementById('reportDateTo')?.value || '',
        barangay: document.getElementById('reportBarangaySelect')?.value || 'all'
    };
}
function sameReportFilters(a, b) { return a.from === b.from && a.to === b.to && a.barangay === b.barangay; }
function validReportFilters(f) {
    if (f.from && f.to && f.from > f.to) {
        showToast('⚠️ The start date is after the end date — fix the date range first.');
        return false;
    }
    return true;
}
function reportScopeText(f) {
    const rangeText = f.from && f.to ? `${f.from} to ${f.to}` : f.from ? `From ${f.from}` : f.to ? `Through ${f.to}` : 'All dates on record';
    return `${f.barangay === 'all' ? 'All Barangays' : f.barangay} · ${rangeText}`;
}

async function generateReport() {
    await populateReportBarangaySelect();
    const filters = readReportFilters();
    if (!validReportFilters(filters)) return false;
    await loadIncidentsFromServer();
    const { from, to, barangay } = filters;

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
    if (subtitle) subtitle.textContent = `Mandaluyong City, ${reportScopeText(filters)}`;

    initReportChart(filtered);
    lastReport = { filters, rows: filtered };
    showToast(total ? `📄 Report generated — ${total} accident${total !== 1 ? 's' : ''} in range` : '📄 Report generated — no accidents match these filters');
    return true;
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
// Mirrors the resident Accident Map (incident-map.html + js/map.js): the same boundary file,
// the same city mask, the same drop pins and the same risk-level heatmap, so both sides of
// the system read one set of records the same way. Layer groups stay separate so markers
// and heatmap can be toggled without redrawing the barangay boundaries.
let mandaluyongMap;
let mandaluyongMapLayers = {};
let mandaluyongBarangayLayers = new Map();
let mandaluyongBarangayCentroids = new Map();
let mandaluyongBoundaryGeoJson;
let mandaluyongCityBounds = null;
let mandaluyongFocusLayer = null;
let mandaluyongMapReady = false;
const MANDALUYONG_GEOJSON_URLS = ['data/mandaluyong-barangays.geojson', './data/mandaluyong-barangays.geojson', '/data/mandaluyong-barangays.geojson', 'mandaluyong-barangays.geojson', '/api/barangays'];
const MANDALUYONG_PALETTE = ['#1a56db', '#0f766e', '#7c3aed', '#c2410c', '#be185d', '#047857', '#0369a1', '#6d28d9', '#b45309'];
const MAP_WORLD_RING = [[-90, -180], [-90, 180], [90, 180], [90, -180]];
const MAP_SEVERITY_ORDER = ['Fatal', 'Injury', 'Minor', 'Damage'];
const MAP_SEVERITY_LABEL = { Damage: 'Damage Only' };
const MAP_FOCUS_STYLE = { color: '#ea580c', weight: 4, opacity: 1, fillColor: '#f97316', fillOpacity: 0.25, interactive: false };

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
/* The accident's recorded coordinates, or null. Records without a location are left off the
   map and counted in the pin note rather than placed at a guessed spot. */
function getIncidentPoint(record) {
    const lat = Number.parseFloat(record.lat);
    const lng = Number.parseFloat(record.lng);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}
function mapNum(value) { return Number(value || 0).toLocaleString(); }

/* Every outer ring of every barangay as Leaflet [lat, lng] pairs — the mask holes and the
   city outline, exactly as js/map.js builds them. */
function mapOuterRings(geo) {
    const rings = [];
    (geo.features || []).forEach(feature => {
        const g = feature.geometry || {};
        if (g.type === 'Polygon') rings.push(g.coordinates[0]);
        if (g.type === 'MultiPolygon') g.coordinates.forEach(poly => rings.push(poly[0]));
    });
    return rings.map(ring => ring.map(([lng, lat]) => [lat, lng]));
}

/* The same canvas drop pin the resident map draws: a teardrop with a white hole whose tip
   sits exactly on the accident's location, so thousands of pins stay smooth. */
const MAP_PIN_TIP = 1.47;
const MAP_PIN_HOLE = 0.5;
const MapPin = L.CircleMarker.extend({
    _updatePath() { this._renderer._updateMapPin(this); },
    _updateBounds() {
        const r = this._radius, w = this._clickTolerance() + this.options.weight;
        this._pxBounds = new L.Bounds(
            this._point.subtract([r + w, r * (1 + MAP_PIN_TIP) + w]),
            this._point.add([r + w, w]));
    },
    _containsPoint(p) { return this._pxBounds.contains(p); }
});
L.Canvas.include({
    _updateMapPin(layer) {
        if (!this._drawing || layer._empty()) return;
        const ctx = this._ctx, o = layer.options, r = layer._radius;
        const tip = layer._point, cx = tip.x, cy = tip.y - r * MAP_PIN_TIP;
        const a = Math.acos(1 / MAP_PIN_TIP);
        ctx.beginPath();
        ctx.arc(cx, cy, r, Math.PI / 2 + a, Math.PI * 2.5 - a);
        ctx.lineTo(tip.x, tip.y);
        ctx.closePath();
        ctx.lineJoin = 'round';
        ctx.globalAlpha = o.fillOpacity; ctx.fillStyle = o.fillColor; ctx.fill();
        ctx.globalAlpha = 1; ctx.lineWidth = o.weight; ctx.strokeStyle = o.color; ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx, cy, r * MAP_PIN_HOLE, 0, Math.PI * 2);
        ctx.fillStyle = '#fff'; ctx.fill(); ctx.stroke();
    }
});
function mapCanvas() {
    if (!mandaluyongMap._msCanvas) mandaluyongMap._msCanvas = L.canvas({ padding: 0.5 });
    return mandaluyongMap._msCanvas;
}

/* Barangay risk level from accident counts, measured against the city's own numbers — more
   than the average barangay is High, more than the median is Moderate, the rest Low. Same
   rule as riskLevels() in js/map.js. `counts` lists every barangay, zeros included. */
const MAP_RISK_LEVELS = {
    high: { key: 'high', label: 'High', color: '#dc2626' },
    medium: { key: 'medium', label: 'Moderate', color: '#eab308' },
    low: { key: 'low', label: 'Low', color: '#16a34a' }
};
function mapRiskLevels(counts) {
    const values = Object.values(counts).map(v => v || 0).sort((a, b) => a - b);
    const mid = Math.floor(values.length / 2);
    const average = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
    const median = !values.length ? 0 : values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
    const forCount = c => MAP_RISK_LEVELS[(c || 0) > average ? 'high' : (c || 0) > median ? 'medium' : 'low'];
    const tally = { high: 0, medium: 0, low: 0 };
    values.forEach(v => tally[forCount(v).key]++);
    return { average, median, tally, forBarangay: name => forCount(counts[name]) };
}
function fillMapRiskLegend(risk) {
    const legend = document.getElementById('mapHeatLegend');
    if (!legend) return;
    const [high, medium, low] = legend.querySelectorAll('.legend-item span');
    const avg = Math.floor(risk.average), med = Math.floor(risk.median);
    high.textContent = `High — over ${mapNum(avg)} accidents (${risk.tally.high})`;
    medium.textContent = `Moderate — ${mapNum(med + 1)}–${mapNum(avg)} (${risk.tally.medium})`;
    low.textContent = `Low — ${mapNum(med)} or fewer (${risk.tally.low})`;
}

/* ---- Filters ----
   Dates are ISO strings (YYYY-MM-DD), so plain string comparison orders them correctly and
   no time zone can shift a record across a day boundary. ignoreBarangay applies every other
   filter — used to rank a barangay against the whole city. */
const MAP_NO_FILTERS = { barangay: 'all', type: 'all', sev: 'all', from: '', to: '' };
// What the map draws: the filters as of the last "Apply Filter", not whatever is currently
// half-chosen in the sidebar, so a background data reload never applies them early.
let appliedMapFilters = { ...MAP_NO_FILTERS };
function mapFilterValues() {
    return appliedMapFilters;
}
function mapFilterInputs() {
    const value = id => document.getElementById(id)?.value || '';
    return {
        barangay: value('mapFltBarangay') || 'all',
        type: value('mapFltType') || 'all',
        sev: value('mapFltSev') || 'all',
        from: value('mapDateFrom'),
        to: value('mapDateTo')
    };
}
function mapFilteredIncidents(ignoreBarangay) {
    const f = mapFilterValues();
    return incidents.filter(record => {
        if (!ignoreBarangay && f.barangay !== 'all' && record.barangay !== f.barangay) return false;
        if (f.type !== 'all' && record.type !== f.type) return false;
        if (f.sev !== 'all' && record.sev !== f.sev) return false;
        const d = String(record.date || '').slice(0, 10);
        if (f.from && (!d || d < f.from)) return false;
        if (f.to && (!d || d > f.to)) return false;
        return true;
    });
}
function mapDateRange() {
    const dates = incidents.map(r => String(r.date || '').slice(0, 10)).filter(Boolean).sort();
    return { oldest: dates[0] || '', newest: dates[dates.length - 1] || '' };
}
/* Called whenever the records reload: the date bounds and the severity list come from the
   data itself, so every option matches something on the map. */
function syncMapFilterOptions() {
    const range = mapDateRange();
    ['mapDateFrom', 'mapDateTo'].forEach(id => {
        const input = document.getElementById(id);
        if (input) { input.min = range.oldest; input.max = range.newest; }
    });

    const sevSelect = document.getElementById('mapFltSev');
    if (sevSelect) {
        const present = new Set(incidents.map(r => r.sev).filter(Boolean));
        const values = [...MAP_SEVERITY_ORDER.filter(s => present.has(s)), ...[...present].filter(s => !MAP_SEVERITY_ORDER.includes(s)).sort()];
        const current = sevSelect.value;
        sevSelect.innerHTML = '<option value="all">All Severities</option>'
            + values.map(v => `<option value="${escapeMapHtml(v)}">${escapeMapHtml(MAP_SEVERITY_LABEL[v] || v)}</option>`).join('');
        sevSelect.value = values.includes(current) ? current : 'all';
    }
}
/* "Apply Filter": takes the sidebar's choices, flies to a newly picked barangay (or back to
   the city when it is cleared), then redraws counts, pins, heatmap and popups. */
function applyMapFilters() {
    const fromInput = document.getElementById('mapDateFrom');
    const toInput = document.getElementById('mapDateTo');
    // Keep the range the right way round.
    if (fromInput.value && toInput.value && fromInput.value > toInput.value) [fromInput.value, toInput.value] = [toInput.value, fromInput.value];

    const next = mapFilterInputs();
    if (next.barangay !== appliedMapFilters.barangay) {
        if (next.barangay !== 'all') focusMapBarangay(next.barangay); else clearMapBarangayFocus();
    }
    appliedMapFilters = next;
    renderMandaluyongMapLayers();
    applyMapLayers();
    showToast(next.barangay === 'all' ? '🔍 Map filters applied' : `🔍 Showing ${next.barangay}`);
}

/* Flies to one barangay and outlines it in its own layer, so the outline survives hover
   restyles and stays visible with Barangay Boundaries switched off. */
function focusMapBarangay(name) {
    if (!mandaluyongMap) return;
    const layer = mandaluyongBarangayLayers.get(name);
    if (mandaluyongFocusLayer) mandaluyongMap.removeLayer(mandaluyongFocusLayer);
    mandaluyongFocusLayer = null;
    if (!layer) return;
    mandaluyongFocusLayer = L.geoJSON(layer.feature, { style: () => MAP_FOCUS_STYLE, interactive: false }).addTo(mandaluyongMap);
    mandaluyongFocusLayer.bringToFront();
    mandaluyongMap.flyToBounds(mandaluyongFocusLayer.getBounds(), { padding: [40, 40], maxZoom: 17, duration: 0.9 });
}
function clearMapBarangayFocus() {
    const wasFocused = !!mandaluyongFocusLayer;
    if (mandaluyongFocusLayer && mandaluyongMap) mandaluyongMap.removeLayer(mandaluyongFocusLayer);
    mandaluyongFocusLayer = null;
    if (wasFocused && mandaluyongMap && mandaluyongCityBounds) mandaluyongMap.flyToBounds(mandaluyongCityBounds, { padding: [10, 10], duration: 0.8 });
}

function incidentPopupHtml(record) {
    return `<div style="font-family:inherit"><strong>${escapeMapHtml(record.id)}</strong><br>${escapeMapHtml(record.barangay)}${record.road && record.road !== 'Unknown' ? ' · ' + escapeMapHtml(record.road) : ''}`
        + `<div style="margin-top:6px">${getSevBadge(record.sev)}</div>`
        + `<div style="margin-top:6px;font-size:11.5px;color:#64748b">${escapeMapHtml(record.type)}<br>${escapeMapHtml(record.date)} · ${escapeMapHtml(record.time)}</div></div>`;
}

/* Counts, pins, heatmap and popups are all drawn here from the filtered set. The view is
   not refitted — only picking or clearing a barangay moves the map. */
function renderMandaluyongMapLayers() {
    if (!mandaluyongMap || !mandaluyongMapLayers.barangays) return;
    mandaluyongMapLayers.incidents.clearLayers();
    mandaluyongMapLayers.heatmap.clearLayers();

    const filters = mapFilterValues();
    const visibleIncidents = mapFilteredIncidents();
    const renderer = mapCanvas();

    // Every accident with a recorded location, oldest drawn first so the newest sit on top.
    const oldestFirst = [...visibleIncidents].sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
    const stats = new Map();
    oldestFirst.forEach(record => {
        const s = stats.get(record.barangay) || { total: 0, fatal: 0, injury: 0 };
        s.total++;
        if (record.sev === 'Fatal') s.fatal++;
        if (record.sev === 'Injury') s.injury++;
        stats.set(record.barangay, s);

        const point = getIncidentPoint(record);
        if (!point) return;
        new MapPin([point.lat, point.lng], {
            renderer,
            radius: record.sev === 'Fatal' ? 8 : record.sev === 'Injury' ? 7 : 6,
            color: '#000', weight: 1.2, fillColor: '#dc2626', fillOpacity: 1
        }).bindPopup(() => incidentPopupHtml(record), { maxWidth: 260 })
            .on('click', () => selectIncident(record.id, record.road, record.barangay, record.type, record.sev, 1, record))
            .addTo(mandaluyongMapLayers.incidents);
    });

    // Heatmap colour is the barangay's risk level for the chosen filters, ranked against
    // every barangay in the city even while one barangay is picked.
    const cityCounts = Object.fromEntries([...mandaluyongBarangayLayers.keys()].map(name => [name, 0]));
    mapFilteredIncidents(true).forEach(record => { cityCounts[record.barangay] = (cityCounts[record.barangay] || 0) + 1; });
    const risk = mapRiskLevels(cityCounts);
    fillMapRiskLegend(risk);
    visibleIncidents.forEach(record => {
        const point = getIncidentPoint(record);
        if (!point) return;
        const color = risk.forBarangay(record.barangay).color;
        L.circle([point.lat, point.lng], {
            renderer,
            radius: record.sev === 'Fatal' ? 260 : record.sev === 'Injury' ? 200 : 150,
            color, fillColor: color,
            fillOpacity: record.sev === 'Fatal' ? 0.22 : 0.16,
            weight: 0, interactive: false
        }).addTo(mandaluyongMapLayers.heatmap);
    });

    const fatal = visibleIncidents.filter(record => record.sev === 'Fatal').length;
    const injury = visibleIncidents.filter(record => record.sev === 'Injury').length;
    const summary = document.getElementById('mapResultSummary');
    if (summary) summary.textContent = `${mapNum(visibleIncidents.length)} accident${visibleIncidents.length === 1 ? '' : 's'} shown · ${mapNum(fatal)} fatal · ${mapNum(injury)} injury`;

    mandaluyongBarangayLayers.forEach((layer, barangay) => {
        const s = stats.get(barangay) || { total: 0, fatal: 0, injury: 0 };
        const level = risk.forBarangay(barangay);
        layer.setPopupContent(`<div class="barangay-popup-title">${escapeMapHtml(barangay)}</div><div class="barangay-popup-meta">Accidents: <strong>${mapNum(s.total)}</strong><br>Fatal: <strong>${mapNum(s.fatal)}</strong> · Injury: <strong>${mapNum(s.injury)}</strong><br>Risk level: <strong style="color:${level.color}">${level.label}</strong></div>`);
    });

    const focusMsg = document.getElementById('mapFocusMsg');
    if (focusMsg) {
        const s = stats.get(filters.barangay);
        focusMsg.textContent = filters.barangay === 'all' ? '' : `Showing ${filters.barangay} — ${mapNum(s ? s.total : 0)} accident${s && s.total === 1 ? '' : 's'} in the selected filters.`;
    }
}
async function initMandaluyongMap() {
    if (mandaluyongMapReady || !window.L) return;
    const container = document.getElementById('mandaluyongLeafletMap');
    if (!container || container.offsetParent === null) return;
    mandaluyongMapReady = true;
    try {
        let boundaries;
        let lastError;
        for (const url of MANDALUYONG_GEOJSON_URLS) {
            try {
                const response = await fetch(url, { cache: 'force-cache' });
                if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
                const candidate = await response.json();
                if (Array.isArray(candidate.features) && candidate.features.length === 27) { boundaries = candidate; break; }
                throw new Error(`Expected 27 features, received ${candidate.features?.length || 0}`);
            } catch (error) { lastError = error; }
        }
        if (!boundaries) throw new Error(`Boundary data could not be loaded. ${lastError?.message || ''}`.trim());

        const rings = mapOuterRings(boundaries);
        mandaluyongCityBounds = L.latLngBounds(rings.flat());
        mandaluyongMap = L.map(container, {
            zoomControl: false,
            preferCanvas: true,
            attributionControl: true,
            minZoom: 12,
            maxZoom: 18,
            maxBounds: mandaluyongCityBounds.pad(0.25),
            maxBoundsViscosity: 0.9
        }).fitBounds(mandaluyongCityBounds, { padding: [10, 10] });
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors | Mandaluyong City TPMO'
        }).addTo(mandaluyongMap);

        // Dim everything outside the city: one polygon with every barangay as a hole.
        L.polygon([MAP_WORLD_RING, ...rings], { stroke: false, fillColor: '#0b2f6d', fillOpacity: 0.35, interactive: false }).addTo(mandaluyongMap);

        mandaluyongMapLayers = { barangays: L.layerGroup().addTo(mandaluyongMap), incidents: L.layerGroup(), heatmap: L.layerGroup() };
        const geoJsonLayer = L.geoJSON(boundaries, {
            style: (feature) => barangayStyle(Number(feature.properties.psgc_10d.slice(-2)) - 1),
            onEachFeature: (feature, layer) => {
                const name = feature.properties.brgy_name;
                mandaluyongBarangayLayers.set(name, layer);
                const centroid = getFeatureCentroid(feature);
                if (centroid) mandaluyongBarangayCentroids.set(name, centroid);
                layer.bindTooltip(name, { className: 'barangay-tooltip', permanent: true, direction: 'center', opacity: .92 });
                layer.bindPopup(`<div class="barangay-popup-title">${escapeMapHtml(name)}</div>`, { className: 'barangay-popup', maxWidth: 250 });
                layer.on({
                    mouseover: e => e.target.setStyle({ weight: 3, color: '#f97316' }),
                    mouseout: e => geoJsonLayer.resetStyle(e.target)
                });
            }
        }).addTo(mandaluyongMapLayers.barangays);
        mandaluyongBoundaryGeoJson = geoJsonLayer;

        // City outline drawn on top so the municipal border stays readable.
        L.polygon(rings, { color: '#0b2f6d', weight: 3, opacity: 0.9, fill: false, interactive: false }).addTo(mandaluyongMap);

        populateMapBarangayFilter(boundaries.features);
        syncMapFilterOptions();
        renderMandaluyongMapLayers();
        syncMapLayerPending(); // layer buttons clicked while the map was loading show as pending
        setTimeout(() => mandaluyongMap.invalidateSize(), 0);
    } catch (error) {
        container.innerHTML = `<div class="map-load-error"><i class="fas fa-triangle-exclamation"></i><strong>Map data unavailable</strong><span>${['localhost', '127.0.0.1'].includes(location.hostname) ? 'Start the RIMAS server with <code>start-mandasafe.bat</code>, then reload the page.' : 'The map boundaries could not be loaded. Check your connection, then try again.'}</span><button type="button" class="map-retry-btn" onclick="location.reload()">Retry map</button></div>`;
        console.error('Mandaluyong GIS map:', error);
    }
}
function populateMapBarangayFilter(features) {
    const select = document.getElementById('mapFltBarangay'); if (!select) return;
    const names = features.map(feature => feature.properties.brgy_name).sort((a, b) => a.localeCompare(b));
    select.innerHTML = '<option value="all">All Barangays</option>' + names.map(name => `<option value="${escapeMapHtml(name)}">${escapeMapHtml(name)}</option>`).join('');
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
/* Layer buttons only mark a choice; "Apply Filter" switches the map. A button whose choice
   differs from what the map shows gets a dashed outline until then. */
const MAP_LAYER_BUTTONS = { boundary: 'layerBoundary', incidents: 'layerIncidents', heatmap: 'layerHeatmap' };
const MAP_DEFAULT_LAYERS = { boundary: true, incidents: false, heatmap: false };

function mapLayerGroup(layer) {
    return mandaluyongMapLayers[layer === 'boundary' ? 'barangays' : layer];
}
function mapLayerShown(layer) {
    const group = mapLayerGroup(layer);
    return !!(mandaluyongMap && group && mandaluyongMap.hasLayer(group));
}
function syncMapLayerPending() {
    Object.entries(MAP_LAYER_BUTTONS).forEach(([layer, id]) => {
        const btn = document.getElementById(id);
        if (btn) btn.classList.toggle('is-pending', mandaluyongMap ? btn.classList.contains('active') !== mapLayerShown(layer) : false);
    });
}
function toggleMapLayer(layer, btn) {
    btn.classList.toggle('active');
    syncMapLayerPending();
}
function applyMapLayers() {
    if (!mandaluyongMap) return;
    Object.entries(MAP_LAYER_BUTTONS).forEach(([layer, id]) => {
        const group = mapLayerGroup(layer);
        const want = document.getElementById(id)?.classList.contains('active');
        if (!group) return;
        if (want && !mandaluyongMap.hasLayer(group)) mandaluyongMap.addLayer(group);
        if (!want && mandaluyongMap.hasLayer(group)) mandaluyongMap.removeLayer(group);
    });
    document.getElementById('mapHeatLegend').hidden = !mapLayerShown('heatmap');
    syncMapLayerPending();
}
function resetMapLayerButtons() {
    Object.entries(MAP_LAYER_BUTTONS).forEach(([layer, id]) => {
        document.getElementById(id)?.classList.toggle('active', MAP_DEFAULT_LAYERS[layer]);
    });
}
function resetMapFilters() {
    document.getElementById('mapDateFrom').value = '';
    document.getElementById('mapDateTo').value = '';
    document.getElementById('mapFltType').value = 'all';
    document.getElementById('mapFltSev').value = 'all';
    document.getElementById('mapFltBarangay').value = 'all';
    if (appliedMapFilters.barangay !== 'all') clearMapBarangayFocus();
    appliedMapFilters = { ...MAP_NO_FILTERS };
    resetMapLayerButtons();
    renderMandaluyongMapLayers();
    applyMapLayers();
    showToast('↺ Map filters cleared');
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
/* Share of `total`, to one decimal place — the percentage distribution the analytics charts show. */
function sharePercent(count, total) { return total ? Math.round(count / total * 1000) / 10 : 0; }
/* Bar-chart tooltip that reads "142 accidents (18.4% of 772)". */
function shareTooltip(total) {
    return { callbacks: { label: ctx => ` ${ctx.raw.toLocaleString()} accidents (${sharePercent(ctx.raw, total)}% of ${total.toLocaleString()})` } };
}
/* Risk-level palette shared by every chart: red = high, yellow = moderate, green = low (same as the map). */
const RISK_COLORS = { high: '#dc2626', medium: '#eab308', moderate: '#eab308', low: '#16a34a' };
const RISK_LABELS = { high: 'High', medium: 'Moderate', moderate: 'Moderate', low: 'Low' };
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

    // Percentage distribution across barangays: each bar is labelled with its share of
    // every accident in the current filter.
    const total = list.length;
    const shareBarOptions = { ...chartDefaults, indexAxis: 'y', plugins: { ...chartDefaults.plugins, tooltip: shareTooltip(total) }, scales: { x: { grid: { color: '#f1f5f9' }, ticks: { font: { size: 10 } } }, y: { grid: { display: false }, ticks: { font: { size: 10 } } } } };
    const shareLabel = ([name, count]) => `${name} (${sharePercent(count, total)}%)`;

    const topBarangays = topGroupCounts(list, 'barangay', 6);
    safeChart('barangayChart', { type: 'bar', data: { labels: topBarangays.map(shareLabel), datasets: [{ data: topBarangays.map(([, c]) => c), backgroundColor: ['#1a56db', '#3b82f6', '#60a5fa', '#93c5fd', '#94a3b8', '#cbd5e1'], borderRadius: 5 }] }, options: shareBarOptions });

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
    renderSeverityClassification();
}

// ===== SEVERITY CLASSIFICATION (records by severity + the Random Forest severity classifier) =====
const SEVERITY_BAR_COLORS = { Fatal: '#dc2626', Injury: '#eab308', Minor: '#16a34a', Damage: '#0ea5e9' };
async function renderSeverityClassification() {
    const dist = document.getElementById('sevDistribution');
    const note = document.getElementById('sevModelNote');
    const tag = document.getElementById('sevModelTag');
    const list = document.getElementById('sevBarangays');
    if (!dist) return;
    let data;
    try { data = await api.getSeverity(); }
    catch (error) { dist.innerHTML = `<span style="color:#dc2626;">${escapeMapHtml(error.message)}</span>`; return; }

    dist.innerHTML = data.distribution.map(d => `
        <div class="sev-bar-row">
            <span style="font-weight:600;">${escapeMapHtml(d.sev === 'Damage' ? 'Damage Only' : d.sev)}</span>
            <div class="sev-bar-track"><div class="sev-bar-fill" style="width:${Math.max(1, d.percent)}%;background:${SEVERITY_BAR_COLORS[d.sev] || '#64748b'};"></div></div>
            <span style="text-align:right;">${d.count.toLocaleString()} · <strong>${d.percent}%</strong></span>
        </div>`).join('') || '<span style="color:var(--gray-400);">No accidents recorded yet.</span>';

    const model = data.model || {};
    if (model.trained) {
        tag.textContent = 'Model: Random Forest (Python)';
        const kde = (model.featureImportances || []).find(f => f.feature === 'KDE density at the location');
        note.innerHTML = `<i class="fas fa-diagram-project" style="color:var(--blue);"></i> Trained on <b>${model.trainedOn.toLocaleString()}</b> records to tell ${model.classes.map(escapeMapHtml).join(' / ')} apart from barangay, road, accident type, time and the <b>KDE accident density</b> at the location. `
            // Plain accuracy would mislead: always guessing the commonest severity scores higher.
            // ROC AUC says how well it ranks serious accidents above damage-only ones.
            + (model.severeRocAuc != null
                ? `Checked on records each tree did not see, it ranks serious (injury/fatal) accidents above damage-only ones with ROC AUC <b>${model.severeRocAuc.toFixed(2)}</b> (0.5 = guessing, 1 = perfect)`
                  + (model.balancedAccuracy != null ? `, balanced accuracy ${Math.round(model.balancedAccuracy * 100)}% (chance ${Math.round(100 / model.classes.length)}%)` : '')
                  + `. It is a modest signal, so it only nudges each area's risk score (±30%) rather than deciding it.`
                : `Out-of-bag accuracy (checked on records each tree did not see): <b>${Math.round(model.oobAccuracy * 100)}%</b>.`)
            + (kde ? ` KDE density carries ${Math.round(kde.importance * 100)}% of the model's weight.` : '');
    } else {
        tag.textContent = 'Model: waiting for data';
        note.innerHTML = `<i class="fas fa-triangle-exclamation" style="color:#d97706;"></i> ${escapeMapHtml(model.reason || 'The severity model has not been trained.')} `
            + 'It trains automatically once records carry Fatal, Injury, Minor or Damage — encode the severity MTPMO reports on the <strong>Accident Records</strong> page or in the import file.';
    }

    const withSevere = data.byBarangay.filter(b => b.severePercent > 0).slice(0, 6);
    list.innerHTML = withSevere.length
        ? '<div class="form-label" style="margin:4px 0 8px;">Barangays with the highest share of fatal / injury accidents</div>'
          + withSevere.map(b => `<div class="sev-bar-row"><span>${escapeMapHtml(b.barangay)}</span><div class="sev-bar-track"><div class="sev-bar-fill" style="width:${b.severePercent}%;background:#dc2626;"></div></div><span style="text-align:right;">${b.severePercent}% of ${b.total.toLocaleString()}</span></div>`).join('')
        : '';
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

// ===== FORECAST (Random Forest predictions; window, filters and explanations in js/forecast-core.js) =====
let forecastModel = null;
let forecastState = null;
let forecastView = null;
let forecastFilters = null;

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
    if (!window.ForecastCore) {
        if (tableBody) tableBody.innerHTML = `<tr><td colspan="10" style="text-align:center;color:#dc2626;padding:24px;">The forecast script (js/forecast-core.js) did not load.</td></tr>`;
        return;
    }

    // Re-created on every visit so the page reflects new records; the chosen dates and
    // barangay are remembered per admin browser.
    forecastModel = ForecastCore.create(predictions);
    forecastState = forecastModel.restoreState('ms-admin-forecast-filter');
    forecastFilters = ForecastCore.mountFilters(document.getElementById('fcFilters'), forecastModel, forecastState, renderForecastPage);
    ForecastCore.bindRows(tableBody, forecastModel, () => forecastView, {
        actions: [
            { label: '⬇ Download PDF', onClick: exportForecastAreaPdf },
            { label: '⬇ Download CSV', onClick: exportForecastAreaCsv }
        ]
    });
    renderForecastPage();
}

function renderForecastPage() {
    const FC = ForecastCore;
    const model = forecastModel;
    const state = forecastState;
    const v = model.view(state);
    const t = v.text;
    const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };

    // --- headings, stat cards, notes ---
    set('fcSubtitle', t.subtitle);
    forecastFilters.setHint(t.hint);
    set('fcCityTitle', t.cityTitle);
    set('fcBrgyTitle', t.brgyTitle);
    set('fcTableTitle', `${t.tableTitle}${state.barangay ? '' : ' — All Areas'}`);
    set('fcPredHead', t.predHead);
    set('fcCompareHead', t.compareHead);
    set('fcStatMonth', t.monthValue);
    set('fcStatMonthLabel', t.monthLabel);
    set('fcStatTotal', t.totalValue);
    set('fcStatTotalLabel', t.totalLabel);
    set('fcStatTotalDelta', t.delta.text);
    const delta = document.getElementById('fcStatTotalDelta');
    if (delta) delta.style.color = { up: '#dc2626', down: '#16a34a', muted: 'var(--gray-500)' }[t.delta.tone];
    set('fcStatUp', t.upValue);
    set('fcStatUpLabel', t.upLabel);
    set('fcStatAccuracy', t.errValue);
    set('fcStatAccuracyLabel', t.errLabel);
    set('fcStatAccuracyNote', t.errNote);
    set('fcModelTag', t.modelTag);
    const note = document.getElementById('fcModelNote');
    if (note) {
        note.innerHTML = model.usingForest
            ? `<i class="fas fa-diagram-project" style="color:var(--blue);"></i> ${escapeMapHtml(t.modelNote)}`
            : `<i class="fas fa-triangle-exclamation" style="color:#d97706;"></i> ${escapeMapHtml(t.modelNote)}`;
    }

    // --- table (click a row for the explanation) ---
    v.list = v.scoped.slice().sort((a, b) => b.predicted - a.predicted);
    forecastView = v;
    const levelClass = { high: 'risk-high', medium: 'risk-med', low: 'risk-low' };
    const tableBody = document.getElementById('fcTableBody');
    tableBody.innerHTML = v.list.map((p, n) => {
        const change = p.changePct === null ? '—'
            : `<span style="color:${p.changePct > 0 ? '#dc2626' : p.changePct < 0 ? '#16a34a' : '#64748b'};font-weight:600;">${p.changePct > 0 ? '+' : ''}${p.changePct.toFixed(0)}%</span>`;
        return `<tr ${FC.rowAttrs(n)}>
            <td>${n + 1}</td>
            <td style="font-weight:600;">${escapeMapHtml(p.barangay)}</td>
            <td>${escapeMapHtml(p.road)}</td>
            <td>${p.totalIncidents.toLocaleString()}</td>
            <td>${v.pastComplete ? Math.round(p.recorded).toLocaleString() : '<span style="color:var(--gray-400);">not recorded yet</span>'}</td>
            <td style="font-weight:700;">${Math.round(p.predicted).toLocaleString()}${v.H > 1 ? `<div style="font-weight:500;font-size:10.5px;color:var(--gray-500);">${p.path.map(x => Math.round(x).toLocaleString()).join(' · ')}</div>` : ''}</td>
            <td>${change}</td>
            <td style="color:${FC.TREND_COLOR[p.periodTrend]};font-weight:700;">${FC.TREND_ICON[p.periodTrend] || '■'} ${escapeMapHtml(p.periodTrend)}</td>
            <td>${p.riskScore.toFixed(1)} / 10</td>
            <td><span class="risk-pill ${levelClass[p.riskLevel] || 'risk-low'}">${escapeMapHtml(RISK_LABELS[p.riskLevel] || p.riskLevel)}</span></td>
        </tr>`;
    }).join('') || `<tr><td colspan="10" style="text-align:center;color:var(--gray-400);padding:24px;">No forecasts yet. Record accidents on the <strong>Accident Records</strong> page to build the forecast.</td></tr>`;
    if (v.list.length) set('fcModelTag', `${t.modelTag} · click a row for details`);

    // --- charts ---
    const legend = { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } };
    const c = model.cityTrend(v);
    safeChart('fcCityChart', {
        type: 'line',
        data: {
            labels: c.labels,
            datasets: [
                { label: 'Recorded', data: c.actual, borderColor: '#1a56db', backgroundColor: 'rgba(26,86,219,.12)', fill: true, tension: .35, pointRadius: 2 },
                { label: c.forecastLabel, data: c.forecast, borderColor: '#7c3aed', borderDash: [6, 4], pointRadius: c.pointSizes, pointBackgroundColor: '#7c3aed', fill: false, tension: .25 }
            ]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend }, scales: { y: { beginAtZero: true }, x: { ticks: { maxRotation: 50, font: { size: 10 } } } } }
    });

    // A chosen barangay stays highlighted and the rest are dimmed; clicking a bar picks it.
    const b = model.byBarangay(v);
    const dim = name => state.barangay && name !== state.barangay;
    safeChart('fcBarangayChart', {
        type: 'bar',
        data: {
            labels: b.names,
            datasets: [
                ...(b.recorded ? [{ label: b.recordedLabel, data: b.recorded, backgroundColor: b.names.map(n => dim(n) ? 'rgba(148,163,184,.25)' : 'rgba(148,163,184,.7)'), borderRadius: 3 }] : []),
                { label: b.predictedLabel, data: b.predicted, backgroundColor: b.names.map(n => dim(n) ? 'rgba(124,58,237,.2)' : 'rgba(124,58,237,.8)'), borderRadius: 3 }
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend },
            onClick: (evt, items) => {
                if (!items.length) return;
                const name = b.names[items[0].index];
                state.barangay = state.barangay === name ? '' : name;
                forecastFilters.sync();
                renderForecastPage();
            },
            scales: { x: { ticks: { autoSkip: false, maxRotation: 70, minRotation: 50, font: { size: 9 } } }, y: { beginAtZero: true } }
        }
    });
}

/* Exports what the page shows: the selected dates and barangay, one column per month. */
function exportForecastCsv() {
    const v = forecastView;
    if (!v || !v.list || !v.list.length) { showToast('⚠️ Open the forecast first — nothing to export yet.'); return; }
    const monthCols = v.months.map((m, j) => `${forecastMonthLabel(m)}${v.share[j] < 1 ? ` (${Math.round(v.share[j] * 100)}% of month)` : ''}`);
    const header = ['Barangay', 'Road', 'Recorded (all time)', `${v.text.compareHead}${v.pastComplete ? ` (${v.compareName})` : ''}`,
        `Predicted ${v.periodLabel}`, ...monthCols, 'Change %', 'Trend', 'Risk Score (next month)', 'Level', 'Model'];
    const cell = val => `"${String(val ?? '').replace(/"/g, '""')}"`;
    const r1 = x => Math.round(x * 10) / 10;
    const lines = [header.map(cell).join(',')].concat(v.list.map(p => [
        p.barangay, p.road, p.totalIncidents, v.pastComplete ? r1(p.recorded) : '', r1(p.predicted), ...p.path.map(r1),
        p.changePct === null ? '' : p.changePct.toFixed(1), p.periodTrend, p.riskScore.toFixed(1), p.riskLevel,
        p.forecastModel === 'random-forest' ? 'Random Forest' : 'Linear trend'
    ].map(cell).join(',')));
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const st = v.state;
    a.href = url; a.download = `RIMAS_Forecast_${st.from}_to_${st.to}${st.barangay ? '_' + st.barangay.replace(/[^\w-]+/g, '-') : ''}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('📄 Forecast exported');
}

/* ----- one area's forecast report, from its detail dialog ----- */
function forecastAreaFileName(p, v, ext) {
    const slug = s => String(s || '').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '');
    const road = p.road && p.road !== 'Unknown' && p.road !== 'All Roads' ? `_${slug(p.road)}` : '';
    return `RIMAS_Forecast_${slug(p.barangay)}${road}_${v.state.from}_to_${v.state.to}.${ext}`;
}

/* The PDF is built from the open dialog itself (its summary, chart, month table and
   explanations), so the download says exactly what the admin is looking at. */
async function exportForecastAreaPdf(p, v, dialog) {
    if (!(await loadExportLibrary('pdf'))) return;
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const W = 210, M = 14, CW = W - M * 2;
    const pageH = doc.internal.pageSize.height;
    // The built-in PDF fonts only cover Latin-1, so swap the symbols the dialog uses.
    const clean = text => String(text || '')
        .replace(/[▲]/g, '').replace(/[▼]/g, '').replace(/[■]/g, '')
        .replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[–—]/g, '-').replace(/→/g, '->').replace(/−/g, '-')
        .replace(/[^\x09\x0A\x0D\x20-\xFF]/g, '').replace(/\s+/g, ' ').trim();
    const q = sel => dialog.querySelector(sel);

    // Header bar (same as the accident export)
    doc.setFillColor(15, 30, 60);
    doc.rect(0, 0, W, 22, 'F');
    doc.setFontSize(12); doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold');
    doc.text('Mandaluyong Road Accident Mapping & Analytics System', M, 10);
    doc.setFontSize(8); doc.setFont('helvetica', 'normal');
    doc.text('RIMAS - Accident Forecast Report', M, 16);
    doc.text(`Generated: ${new Date().toLocaleString()}`, W - M, 16, { align: 'right' });

    let y = 32;
    const ensure = h => { if (y + h > pageH - 14) { doc.addPage(); y = 18; } };

    doc.setTextColor(15, 23, 42); doc.setFont('helvetica', 'bold'); doc.setFontSize(16);
    doc.text(clean(q('#fcxTitle').textContent), M, y);
    y += 6;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(100, 116, 139);
    doc.text(clean(`${q('.fcx-sub').textContent} · Selected dates: ${v.state.from} to ${v.state.to}`), M, y);
    y += 7;

    // Summary boxes
    const kpis = [...dialog.querySelectorAll('.fcx-kpi')];
    const colors = [[26, 86, 219], [124, 58, 237], [100, 116, 139], [220, 38, 38]];
    const trendRgb = { up: [220, 38, 38], down: [22, 163, 74], stable: [100, 116, 139] };
    const boxW = (CW - 9) / 4;
    kpis.forEach((k, i) => {
        const x = M + i * (boxW + 3);
        doc.setFillColor(...(i === 2 ? (trendRgb[p.periodTrend] || colors[2]) : colors[i] || colors[0]));
        doc.roundedRect(x, y, boxW, 20, 2, 2, 'F');
        doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(13);
        doc.text(clean(k.querySelector('b').textContent), x + boxW / 2, y + 8, { align: 'center' });
        doc.setFont('helvetica', 'normal'); doc.setFontSize(6.5);
        doc.text(doc.splitTextToSize(clean(k.querySelector('span').textContent), boxW - 4).slice(0, 2), x + boxW / 2, y + 13, { align: 'center' });
    });
    y += 25;

    // Chart, copied from the dialog's canvas
    const canvas = q('.fcx-chart');
    if (canvas && canvas.width && canvas.parentElement.style.display !== 'none') {
        try {
            const h = Math.min(70, CW * canvas.height / canvas.width);
            doc.addImage(canvas.toDataURL('image/png'), 'PNG', M, y, CW, h);
            y += h + 4;
        } catch (e) { /* chart is optional */ }
    }

    // Sections: headings, paragraphs, bullet lists and the month-by-month table
    dialog.querySelectorAll('.fcx-sec').forEach(sec => {
        ensure(14);
        doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(15, 23, 42);
        doc.text(clean(sec.querySelector('h4').textContent).toUpperCase(), M, y);
        y += 5;
        const table = sec.querySelector('table');
        if (table) {
            const cellText = c => clean(c.textContent);
            doc.autoTable({
                head: [[...table.querySelectorAll('thead th')].map(cellText)],
                body: [...table.querySelectorAll('tbody tr')].map(tr => [...tr.children].map(cellText)),
                startY: y,
                margin: { left: M, right: M },
                styles: { fontSize: 8, cellPadding: 2.2, lineColor: [226, 232, 240], lineWidth: 0.3 },
                headStyles: { fillColor: [15, 30, 60], textColor: 255, fontStyle: 'bold', fontSize: 7.5 },
                alternateRowStyles: { fillColor: [248, 250, 252] },
                columnStyles: { 1: { halign: 'right', fontStyle: 'bold' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' } }
            });
            y = doc.lastAutoTable.finalY + 6;
            return;
        }
        doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(51, 65, 85);
        sec.querySelectorAll('p, li').forEach(el => {
            const bullet = el.tagName === 'LI';
            const lines = doc.splitTextToSize(clean(el.textContent), CW - (bullet ? 5 : 0));
            lines.forEach((line, i) => {
                ensure(5);
                if (bullet && i === 0) doc.text('-', M + 1, y);
                doc.text(line, M + (bullet ? 5 : 0), y);
                y += 4.3;
            });
            y += 1.5;
        });
        y += 2;
    });

    const note = [...dialog.querySelectorAll('.fcx-body > .fcx-note')].map(n => clean(n.textContent)).join(' ');
    if (note) {
        doc.setFont('helvetica', 'italic'); doc.setFontSize(8); doc.setTextColor(100, 116, 139);
        doc.splitTextToSize(note, CW).forEach(line => { ensure(4); doc.text(line, M, y); y += 3.8; });
    }

    const pageCount = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
        doc.setPage(i);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(148, 163, 184);
        doc.text('Mandaluyong City TPMO - Confidential', M, pageH - 5);
        doc.text(`Page ${i} of ${pageCount}`, W - M, pageH - 5, { align: 'right' });
    }

    doc.save(forecastAreaFileName(p, v, 'pdf'));
    showToast('✅ Forecast report downloaded');
}

/* The same area's numbers as a spreadsheet: a summary block, then one row per month. */
function exportForecastAreaCsv(p, v) {
    const model = forecastModel;
    const r1 = x => Math.round(x * 10) / 10;
    const cell = val => `"${String(val ?? '').replace(/"/g, '""')}"`;
    const isForest = p.forecastModel === 'random-forest';
    const lines = [
        ['Barangay', p.barangay], ['Road', p.road],
        ['Selected dates', `${v.state.from} to ${v.state.to}`],
        ['Model', isForest ? 'Random Forest' : 'Linear trend'],
        ['Predicted accidents (selection)', r1(p.predicted)],
        ['Per month (average)', r1(p.predicted / v.monthsCovered)],
        ['Compared with', v.pastComplete ? `${v.compareName}: ${r1(p.recorded)}` : 'not recorded yet'],
        ['Change %', p.changePct === null ? '' : p.changePct.toFixed(1)],
        ['Trend', p.periodTrend],
        ['Risk score (next month)', `${p.riskScore.toFixed(1)} / 10 (${p.riskLevel})`],
        ['Recorded accidents (all time)', p.totalIncidents],
        [],
        ['Month', 'Days selected', 'Predicted (selection)', 'Full-month forecast', 'Same month last year', 'Months ahead', 'Typical error (per area)']
    ];
    v.months.forEach((m, j) => {
        const full = model.pathOf(p)[v.S + j];
        const prev = (() => { const [y, mo] = m.split('-').map(Number); return `${y - 1}-${String(mo).padStart(2, '0')}`; })();
        const days = new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0).getDate();
        const err = isForest ? model.errorAt(v.S + j + 1) : null;
        lines.push([
            forecastMonthLabel(m), `${Math.round(v.share[j] * days)} of ${days}`, r1(full * v.share[j]), full,
            prev <= model.lastMonth ? model.countIn(p, prev) : 'not recorded yet', v.S + j + 1,
            err != null ? err : isForest ? 'not tested' : ''
        ]);
    });
    const blob = new Blob(['﻿' + lines.map(l => l.map(cell).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = forecastAreaFileName(p, v, 'csv'); a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('📄 Forecast data downloaded');
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
            ? `<i class="fas fa-diagram-project" style="color:var(--blue);"></i> Next-month counts average a Random Forest trained on every barangay's monthly history (Python / scikit-learn) with each area's 3-month average.`
              + (bt ? ` Tested on ${escapeMapHtml(bt.from && bt.from !== bt.month ? bt.from + ' to ' + bt.month : bt.month)}: off by ${bt.maeForest} accidents per area on average`
                  + (bt.maeAverage3 != null ? `, vs ${bt.maeAverage3} for the 3-month average alone` : '')
                  + ` and ${bt.maeLinear} for a straight-line trend.` : '')
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
                    <td><span class="risk-pill ${pillClass[p.riskLevel]}">${(RISK_LABELS[p.riskLevel] || p.riskLevel).toUpperCase()}</span></td>
                </tr>`).join('');
        }
    }

    safeChart('riskDonut', { type: 'doughnut', data: { labels: ['High', 'Moderate', 'Low'], datasets: [{ data: [high, medium, low], backgroundColor: [RISK_COLORS.high, RISK_COLORS.moderate, RISK_COLORS.low], borderWidth: 3, borderColor: 'white' }] }, options: { ...chartDefaults, cutout: '65%', plugins: { legend: { display: true, position: 'bottom', labels: { usePointStyle: true, boxWidth: 8, font: { size: 10 } } } } } });

    const hourBuckets = new Array(12).fill(0);
    incidents.forEach(record => {
        const h = parseIncidentHour(record);
        if (h !== null) hourBuckets[Math.floor(h / 2)] += 1;
    });
    const hourPeak = Math.max(1, ...hourBuckets);
    safeChart('peakHoursChart', { type: 'bar', data: { labels: ['12AM', '2AM', '4AM', '6AM', '8AM', '10AM', '12PM', '2PM', '4PM', '6PM', '8PM', '10PM'], datasets: [{ data: hourBuckets, backgroundColor: (ctx) => { const v = ctx.raw / hourPeak; return v > 0.85 ? '#dc2626' : v > 0.65 ? '#f59e0b' : v > 0.4 ? '#fbbf24' : '#22c55e'; }, borderRadius: 5 }] }, options: { ...chartDefaults, scales: { y: { grid: { color: '#f1f5f9' } }, x: { grid: { display: false }, ticks: { font: { size: 9 } } } } } });

    renderProneAreas();
}

// ===== PREDICTED ACCIDENT-PRONE AREAS (KDE density features -> Random Forest, ml/prone_area_forest.py) =====
const PRONE_COLORS = { high: '#dc2626', moderate: '#eab308', low: '#16a34a' };
const PRONE_LABELS = { high: 'High', moderate: 'Moderate', low: 'Low' };
let proneMap = null;
let proneLayer = null;

async function loadBoundaryGeoJson() {
    for (const url of MANDALUYONG_GEOJSON_URLS) {
        try {
            const response = await fetch(url, { cache: 'force-cache' });
            if (!response.ok) continue;
            const data = await response.json();
            if (Array.isArray(data.features) && data.features.length === 27) return data;
        } catch { /* try the next location */ }
    }
    return null;
}

async function renderProneAreas() {
    const note = document.getElementById('paNote');
    if (!note) return;
    let data;
    try { data = await api.getProneAreas(); }
    catch (error) { note.innerHTML = `<i class="fas fa-triangle-exclamation" style="color:#dc2626;"></i> ${escapeMapHtml(error.message)}`; return; }

    if (!data.trained) {
        note.innerHTML = `<i class="fas fa-triangle-exclamation" style="color:#d97706;"></i> ${escapeMapHtml(data.reason || 'The prediction model has not been trained yet.')}`;
        return;
    }
    const m = data.model;
    const period = p => `${monthKeyLabel(p.from)} – ${monthKeyLabel(p.to)}`;
    document.getElementById('paPeriod').textContent = `Prediction for ${period(m.predictionPeriod)}`;
    note.innerHTML = `<i class="fas fa-diagram-project" style="color:var(--blue);"></i> The city is split into <b>${m.cellMeters} m</b> cells. For each cell, <b>Kernel Density Estimation</b> measures how concentrated accidents are — at the cell (${m.bandwidthMeters} m kernel), in the last 3 months, and across the surrounding area (${m.neighbourhoodBandwidthMeters} m). `
        + `These KDE outputs, with the cell's own counts, are the input to a <b>Random Forest classifier</b> (Python / scikit-learn) trained on <b>${m.trainingPeriods}</b> past periods (${m.trainingRows.toLocaleString()} examples from ${m.accidentsUsed.toLocaleString()} located accidents) to predict which cells become accident-prone over the next ${m.horizonMonths} months. `
        + `It predicts <b style="color:${PRONE_COLORS.high};">${m.predictedCells.high}</b> high, <b style="color:#a16207;">${m.predictedCells.moderate}</b> moderate and <b style="color:${PRONE_COLORS.low};">${m.predictedCells.low}</b> low cells for ${period(m.predictionPeriod)}. KDE features carry <b>${Math.round(m.kdeImportanceShare * 100)}%</b> of the model's weight.`;

    // --- barangay table ---
    document.getElementById('paBarangayBody').innerHTML = data.barangays.map(b => `
        <tr>
            <td style="font-weight:600;">${escapeMapHtml(b.barangay)}</td>
            <td style="color:${PRONE_COLORS.high};font-weight:700;">${b.high}</td>
            <td style="color:#a16207;font-weight:700;">${b.moderate}</td>
            <td>${Math.round(b.maxProbability * 100)}%</td>
            <td><span class="risk-pill ${b.level === 'high' ? 'risk-high' : b.level === 'moderate' ? 'risk-med' : 'risk-low'}">${PRONE_LABELS[b.level]}</span></td>
        </tr>`).join('');

    // --- map: every cell tinted by its predicted level ---
    const container = document.getElementById('proneMap');
    if (!window.L || !container) return;
    if (!proneMap) {
        const geo = await loadBoundaryGeoJson();
        proneMap = L.map(container, { zoomControl: true, preferCanvas: true, minZoom: 12, maxZoom: 18 });
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(proneMap);
        if (geo) {
            const outline = L.geoJSON(geo, { style: { color: '#0b2f6d', weight: 1.2, fill: false }, interactive: false }).addTo(proneMap);
            proneMap.fitBounds(outline.getBounds(), { padding: [8, 8] });
            proneMap.setMaxBounds(outline.getBounds().pad(0.2));
        } else if (data.cells.length) {
            proneMap.fitBounds(data.cells.map(c => c.bounds).flat());
        }
    }
    if (proneLayer) proneMap.removeLayer(proneLayer);
    proneLayer = L.layerGroup().addTo(proneMap);
    data.cells.forEach(c => {
        const color = PRONE_COLORS[c.level];
        L.rectangle(c.bounds, { color, weight: c.level === 'low' ? 0 : 1, fillColor: color, fillOpacity: c.level === 'high' ? 0.55 : c.level === 'moderate' ? 0.42 : 0.12 })
            .bindPopup(`<strong>${escapeMapHtml(c.barangay)}</strong><br>Chance of being accident-prone: <strong>${Math.round(c.probability * 100)}%</strong> (${PRONE_LABELS[c.level]})<br>Last 3 months: ${c.recentPerMonth} accidents / month<br>KDE density: ${c.kdeDensity} accidents / km² / month`)
            .addTo(proneLayer);
    });
    setTimeout(() => proneMap.invalidateSize(), 100);
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
                    <td><span class="incident-id" onclick="showPage('incidents');setTimeout(()=>openDetailModal(${idx}),100)">${escapeMapHtml(r.id ?? '')}</span></td>
                    <td style="font-size:12px;">${escapeMapHtml(r.date ?? '')} · ${escapeMapHtml(r.time ?? '')}</td>
                    <td style="font-size:12px;">${escapeMapHtml(r.road ?? '')}</td>
                    <td>${getSevBadge(r.sev)}</td>
                    <td style="font-size:12px;">${escapeMapHtml(r.type ?? '')}</td>
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
        const chipName = document.getElementById('chipName');
        if (chipName) chipName.textContent = currentUser.name;
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

    // Names, emails and phones are typed by residents at sign-up, so all of it is escaped:
    // raw HTML here would run inside the administrator's session.
    const h = v => escapeMapHtml(v ?? '');
    tbody.innerHTML = accountList.map(u => {
        const lastLogin = u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : 'Never signed in';
        const isSelf = currentUser && u.id === currentUser.id;
        return `
                <tr class="user-row" title="View details" onclick="openUserDetails('${h(u.id)}')">
                    <td><div style="display:flex;align-items:center;gap:10px;"><div style="width:32px;height:32px;border-radius:50%;background:${h(u.color)};display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:white;">${h(u.avatar)}</div><div><div style="font-weight:600;font-size:13px;">${h(u.name)}${isSelf ? ' <span style="font-size:10px;color:var(--gray-400);">(you)</span>' : ''}</div><div style="font-size:10px;color:var(--gray-400);">${h(u.dept)}</div></div></div></td>
                    <td style="font-size:12px;color:var(--gray-500);">${h(u.email)}<div style="font-size:10px;">${h(u.phone)}</div></td>
                    <td>${u.role === 'admin' ? '<span class="admin-badge"><i class="fas fa-shield-alt"></i> Admin</span>' : '<span class="user-badge"><i class="fas fa-user"></i> User</span>'}</td>
                    <td><span class="status-badge status-${h(u.status)}">${u.status === 'active' ? '● Active' : '○ Inactive'}</span></td>
                    <td style="font-size:12px;color:var(--gray-500);">${lastLogin}</td>
                    <td onclick="event.stopPropagation()"><div style="display:flex;gap:5px;">
                        <button class="btn btn-sm" style="background:${u.status === 'active' ? '#fef2f2' : '#f0fdf4'};color:${u.status === 'active' ? '#dc2626' : '#16a34a'};border:1px solid ${u.status === 'active' ? '#fecaca' : '#bbf7d0'};" title="${u.status === 'active' ? 'Deactivate' : 'Reactivate'}" onclick="toggleUserStatus('${h(u.id)}')"><i class="fas ${u.status === 'active' ? 'fa-ban' : 'fa-check'}"></i></button>
                        ${isSelf ? '' : `<button class="btn btn-sm" style="background:#fef2f2;color:#dc2626;border:1px solid #fecaca;" title="Remove account" onclick="deleteUserAccount('${h(u.id)}')"><i class="fas fa-trash-alt"></i></button>`}
                    </div></td>
                </tr>
            `;
    }).join('');
}

// ===== USER DETAILS =====
// Clicking a row opens everything the server knows about that account: profile, security
// summary and activity history. The password itself is never shown — only its bcrypt hash is
// stored, so nobody (administrators included) can read it back; the panel says when it changed.
const USER_ACTIVITY_KINDS = {
    login: { label: 'Signed in', icon: 'fa-right-to-bracket', bg: '#f0fdf4', fg: '#16a34a', group: 'auth' },
    logout: { label: 'Signed out', icon: 'fa-right-from-bracket', bg: '#f1f5f9', fg: '#64748b', group: 'auth' },
    login_failed: { label: 'Failed sign-in', icon: 'fa-triangle-exclamation', bg: '#fef2f2', fg: '#dc2626', group: 'auth' },
    password_changed: { label: 'Password changed', icon: 'fa-key', bg: '#fffbeb', fg: '#d97706', group: 'account' },
    profile_updated: { label: 'Profile updated', icon: 'fa-user-pen', bg: '#eff6ff', fg: '#2563eb', group: 'account' },
    account_created: { label: 'Account created', icon: 'fa-user-plus', bg: '#eff6ff', fg: '#2563eb', group: 'account' },
    account_changed: { label: 'Account changed by admin', icon: 'fa-user-shield', bg: '#f5f3ff', fg: '#7c3aed', group: 'account' },
    admin_action: { label: 'Managed a user', icon: 'fa-users-gear', bg: '#f5f3ff', fg: '#7c3aed', group: 'data' },
    incident_created: { label: 'Added accident', icon: 'fa-plus', bg: '#ecfeff', fg: '#0891b2', group: 'data' },
    incident_updated: { label: 'Edited accident', icon: 'fa-pen', bg: '#ecfeff', fg: '#0891b2', group: 'data' },
    incident_deleted: { label: 'Deleted accident', icon: 'fa-trash-alt', bg: '#fef2f2', fg: '#dc2626', group: 'data' },
    incident_imported: { label: 'Imported accidents', icon: 'fa-file-import', bg: '#ecfeff', fg: '#0891b2', group: 'data' },
    prediction_input: { label: 'Baseline data', icon: 'fa-chart-line', bg: '#ecfeff', fg: '#0891b2', group: 'data' }
};
let userDetailsData = null;
let userDetailsFilter = 'all';

function describeDevice(ua) {
    if (!ua) return '';
    const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome'
        : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
    const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS'
        : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : /Symfony|curl|artisan/i.test(ua) ? 'Server' : '';
    return os ? `${browser} on ${os}` : browser;
}

async function openUserDetails(id) {
    const body = document.getElementById('userDetailsBody');
    document.getElementById('userDetailsModal').classList.add('open');
    body.innerHTML = '<div class="ud-empty"><i class="fas fa-spinner fa-spin"></i> Loading details…</div>';
    userDetailsFilter = 'all';
    try {
        userDetailsData = await api.getAccountDetails(id);
        renderUserDetails();
    } catch (error) {
        body.innerHTML = `<div class="ud-empty" style="color:#dc2626;">${escapeMapHtml(error.message)}</div>`;
    }
}

function closeUserDetails() {
    document.getElementById('userDetailsModal').classList.remove('open');
    userDetailsData = null;
}

function setUserDetailsFilter(filter) {
    userDetailsFilter = filter;
    renderUserDetails();
}

function renderUserDetails() {
    if (!userDetailsData) return;
    const { account: u, security: s, activity } = userDetailsData;
    const h = v => escapeMapHtml(v ?? '');
    const when = iso => iso ? new Date(iso).toLocaleString() : '—';
    const item = (label, value) => `<div class="ud-item"><div class="ud-label">${label}</div><div class="ud-value">${value}</div></div>`;

    const failed = activity.filter(a => a.action === 'login_failed').length;
    const signIns = activity.filter(a => a.action === 'login').length;

    const filters = [['all', 'All'], ['auth', 'Sign-ins'], ['account', 'Account']];
    const shown = activity.filter(a => userDetailsFilter === 'all' || (USER_ACTIVITY_KINDS[a.action]?.group || 'account') === userDetailsFilter);
    const log = shown.length ? shown.map(a => {
        const k = USER_ACTIVITY_KINDS[a.action] || { label: a.action, icon: 'fa-circle', bg: '#f1f5f9', fg: '#64748b' };
        const meta = [when(a.at), a.ip ? 'IP ' + h(a.ip) : '', h(describeDevice(a.userAgent))].filter(Boolean).join(' · ');
        return `<div class="ud-log-row">
                <div class="ud-log-icon" style="background:${k.bg};color:${k.fg};"><i class="fas ${k.icon}"></i></div>
                <div style="min-width:0;"><div><strong>${h(k.label)}</strong>${a.detail ? ' — ' + h(a.detail) : ''}</div>
                <div class="ud-log-meta">${meta}</div></div>
            </div>`;
    }).join('') : '<div class="ud-empty">No activity recorded yet.</div>';

    document.getElementById('userDetailsBody').innerHTML = `
        <div class="ud-head">
            <div class="ud-avatar" style="background:${h(u.color)};">${h(u.avatar)}</div>
            <div style="min-width:0;">
                <div class="ud-name">${h(u.name)}</div>
                <div class="ud-sub">${h(u.id)} · ${h(u.dept)}</div>
                <div style="margin-top:6px;display:flex;gap:6px;">
                    ${u.role === 'admin' ? '<span class="admin-badge"><i class="fas fa-shield-alt"></i> Admin</span>' : '<span class="user-badge"><i class="fas fa-user"></i> User</span>'}
                    <span class="status-badge status-${h(u.status)}">${u.status === 'active' ? '● Active' : '○ Inactive'}</span>
                </div>
            </div>
        </div>

        <div class="ud-section">Profile</div>
        <div class="ud-grid">
            ${item('Email', h(u.email))}
            ${item('Contact number', h(u.phone))}
            ${item('Account created', when(u.createdAt))}
            ${item('Last updated', when(s.updatedAt))}
        </div>

        <div class="ud-section">Sign-in &amp; security</div>
        <div class="ud-grid">
            ${item('Last login', u.lastLoginAt ? when(u.lastLoginAt) : 'Never signed in')}
            ${item('Password', s.passwordChangedAt ? 'Last changed ' + when(s.passwordChangedAt) : 'Not changed since tracking began')}
            ${item('Active sessions', s.activeSessions ? `${s.activeSessions} (latest ${when(s.lastSessionStartedAt)})` : 'None')}
            ${u.role === 'admin' ? item('Authenticator app', s.twoFactorEnabledAt ? 'Set up ' + when(s.twoFactorEnabledAt) : 'Not set up yet') : ''}
            ${item('Recent sign-ins / failures', `${signIns} / <span style="color:${failed ? '#dc2626' : 'inherit'};">${failed}</span>`)}
        </div>
        <div class="ud-note"><i class="fas fa-lock" style="margin-top:2px;"></i>
            Passwords are stored encrypted (one-way hash) and cannot be viewed by anyone, including administrators.
            The user can set a new one with "Forgot password?" on the sign-in page.</div>

        <div class="ud-section">Activity (${activity.length})</div>
        <div class="ud-filters">${filters.map(([key, label]) =>
            `<button class="ud-filter${userDetailsFilter === key ? ' active' : ''}" onclick="setUserDetailsFilter('${key}')">${label}</button>`).join('')}</div>
        <div class="ud-log">${log}</div>
    `;
}

document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.getElementById('userDetailsModal')?.classList.contains('open')) closeUserDetails();
});
document.getElementById('userDetailsModal')?.addEventListener('click', e => {
    if (e.target.id === 'userDetailsModal') closeUserDetails();
});

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
    incident_deleted: { cssType: 'alert', icon: 'fas fa-trash', iconBg: '#fee2e2', iconColor: '#dc2626' },
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
            const response = await fetch(url, { cache: 'force-cache' });
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
            if (!isCsv && !(await loadExportLibrary('xlsx'))) return;
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
            ? `<span title="${escapeMapHtml(r._warn)}" style="color:#d97706;font-size:11px;font-weight:700;cursor:help;">⚠️ WARN</span>`
            : `<span style="color:#16a34a;font-size:11px;font-weight:700;">✅ OK</span>`}
                    </td>
                    <td style="font-size:12px;font-weight:600;color:var(--blue);">${escapeMapHtml(r.id ?? '')}</td>
                    <td style="font-size:12px;">${escapeMapHtml(r.date ?? '')}</td>
                    <td style="font-size:12px;">${escapeMapHtml(r.time ?? '')}</td>
                    <td style="font-size:12px;">${escapeMapHtml(r.barangay ?? '')}</td>
                    <td style="font-size:12px;">${escapeMapHtml(r.road ?? '')}</td>
                    <td>${getSevBadge(r.sev)}</td>
                    <td style="font-size:12px;">${escapeMapHtml(r.type ?? '')}</td>
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

/* jsPDF and SheetJS are ~1.3 MB together and only needed for exports and Excel imports, so
   they are fetched on first use instead of blocking every console page load. */
const EXPORT_LIBRARIES = {
    pdf: {
        ready: () => !!(window.jspdf && window.jspdf.jsPDF && window.jspdf.jsPDF.API.autoTable),
        urls: [
            'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
            'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js'
        ]
    },
    xlsx: {
        ready: () => !!window.XLSX,
        urls: ['https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js']
    },
    // Page snapshots (Analytics, Hotspots, Forecast, Safety Index): jsPDF + html2canvas.
    snapshot: {
        ready: () => !!(window.jspdf && window.jspdf.jsPDF && window.html2canvas),
        urls: [
            'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
            'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js'
        ]
    }
};
const exportLibraryLoads = {};

function loadScriptOnce(src) {
    if (document.querySelector(`script[src="${src}"]`)) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.onload = resolve;
        script.onerror = () => { script.remove(); reject(new Error(`Could not load ${src}`)); };
        document.head.appendChild(script);
    });
}

/* Resolves true once the library is usable; on failure says so in a toast and resolves false
   (and forgets the attempt, so the next click retries). */
async function loadExportLibrary(kind) {
    const lib = EXPORT_LIBRARIES[kind];
    if (lib.ready()) return true;
    if (!exportLibraryLoads[kind]) {
        // In order: the autotable plugin attaches itself to an already-loaded jsPDF.
        exportLibraryLoads[kind] = lib.urls.reduce((chain, url) => chain.then(() => loadScriptOnce(url)), Promise.resolve());
    }
    try {
        await exportLibraryLoads[kind];
    } catch (error) {
        console.error(error);
    }
    if (lib.ready()) return true;
    delete exportLibraryLoads[kind];
    showToast(`⚠️ The ${kind === 'xlsx' ? 'Excel' : 'PDF'} library did not load — check the internet connection.`);
    return false;
}

/* opts (all optional): cols — columns to write instead of the Export dialog's ticked ones;
   subtitle — what the rows are (e.g. a report's barangay and dates), shown in PDF/Excel. */
function exportCSV(data, filename, opts = {}) {
    const rows = data || getExportData();
    const cols = opts.cols || getSelectedCols();
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

async function exportExcel(data, filename, opts = {}) {
    const rows = data || getExportData();
    const cols = opts.cols || getSelectedCols();
    if (!(await loadExportLibrary('xlsx'))) return;
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
        ...(opts.subtitle ? [['Report', opts.subtitle]] : []),
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

async function exportPDF(data, filename, opts = {}) {
    const rows = data || getExportData();
    const cols = opts.cols || getSelectedCols();
    if (!(await loadExportLibrary('pdf'))) return;
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });

    doc.setFillColor(15, 30, 60);
    doc.rect(0, 0, 297, 22, 'F');
    doc.setFontSize(13); doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold');
    doc.text('Mandaluyong Road Accident Mapping & Analytics System', 14, 10);
    doc.setFontSize(8); doc.setFont('helvetica', 'normal');
    doc.text(opts.subtitle ? `RIMAS — ${opts.subtitle}` : 'RIMAS — Accident Export Report', 14, 16);
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

/* Downloads exactly the accidents in the report preview: the chosen barangay and dates. If
   the parameters were changed without pressing Generate Report, the preview is regenerated
   first so the file and the screen always match. */
async function exportReport(fmt) {
    fmt = fmt || currentReportFmt;
    const filters = readReportFilters();
    if (!validReportFilters(filters)) return;
    if (!lastReport || !sameReportFilters(lastReport.filters, filters)) {
        if (!(await generateReport())) return;
    }
    const { rows } = lastReport;
    if (!rows.length) { showToast('⚠️ No accidents match this barangay and date range — nothing to download.'); return; }

    const slug = v => String(v).replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '');
    const name = `RIMAS_Report_${filters.barangay === 'all' ? 'All-Barangays' : slug(filters.barangay)}_${filters.from || 'start'}_to_${filters.to || today()}`;
    const opts = { cols: Object.keys(COL_HEADERS), subtitle: `Accident Report · ${reportScopeText(filters)}` };
    if (fmt === 'pdf') exportPDF(rows, `${name}.pdf`, opts);
    else if (fmt === 'excel') exportExcel(rows, `${name}.xlsx`, opts);
    else exportCSV(rows, `${name}.csv`, opts);
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

/* Downloads the open page (Analytics, Hotspots, Forecast, Safety Index) as a PDF that looks
   like the screen: its cards, charts and tables, with the current filters applied. Each
   top-level block of the page is captured on its own so a page break never cuts through a
   card unless the card is taller than a whole PDF page. */
async function exportPagePdf(pageId, title) {
    const page = document.getElementById(pageId);
    if (!page) return;
    if (!(await loadExportLibrary('snapshot'))) return;
    showToast('⏳ Preparing PDF…');

    // The page's own blocks, minus the header with the export buttons.
    const blocks = [...page.children].filter(el =>
        !el.classList.contains('page-header') && el.offsetHeight > 0 && getComputedStyle(el).display !== 'none');
    if (!blocks.length) { showToast('⚠️ Nothing on this page to export yet.'); return; }

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const W = doc.internal.pageSize.width, H = doc.internal.pageSize.height;
    const M = 10, CW = W - M * 2, top = 26, bottom = H - 10;

    const header = () => {
        doc.setFillColor(15, 30, 60);
        doc.rect(0, 0, W, 20, 'F');
        doc.setFontSize(12); doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold');
        doc.text('Mandaluyong Road Accident Mapping & Analytics System', M, 9);
        doc.setFontSize(8); doc.setFont('helvetica', 'normal');
        doc.text(`RIMAS - ${title} Report`, M, 15);
        doc.text(`Generated: ${new Date().toLocaleString()}`, W - M, 15, { align: 'right' });
    };
    header();
    let y = top;
    const newPage = () => { doc.addPage(); header(); y = top; };

    // Capture the blocks at the page's on-screen width, so the layout matches what is shown.
    const width = page.clientWidth;
    const pxToMm = CW / width;
    const options = {
        scale: 2,
        useCORS: true,
        backgroundColor: getComputedStyle(page).backgroundColor || '#f1f5f9',
        windowWidth: document.documentElement.clientWidth,
        ignoreElements: el => el.classList && el.classList.contains('page-header')
    };

    // Lists with their own scrollbar (e.g. Barangay Safety Scores) are opened up while the
    // snapshot is taken, so the PDF shows every row; they are put back afterwards.
    const expanded = [...page.querySelectorAll('*')]
        .filter(el => /(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1)
        .map(el => {
            const saved = el.getAttribute('style');
            el.style.overflow = 'visible'; el.style.maxHeight = 'none'; el.style.height = 'auto';
            return () => (saved === null ? el.removeAttribute('style') : el.setAttribute('style', saved));
        });

    try {
        for (const block of blocks) {
            const canvas = await window.html2canvas(block, options);
            if (!canvas.width || !canvas.height) continue;
            const scale = (block.offsetWidth * pxToMm) / canvas.width;   // mm per canvas pixel
            const imgW = canvas.width * scale;
            const x = M + (CW - imgW) / 2;
            const fullH = canvas.height * scale;
            if (y + fullH > bottom && y > top && fullH <= bottom - top) newPage();
            // Taller than the space left: slice it into page-sized strips.
            let srcY = 0;
            while (srcY < canvas.height) {
                const room = bottom - y;
                const sliceH = Math.min(canvas.height - srcY, Math.floor(room / scale));
                if (sliceH <= 0) { newPage(); continue; }
                const part = document.createElement('canvas');
                part.width = canvas.width; part.height = sliceH;
                part.getContext('2d').drawImage(canvas, 0, srcY, canvas.width, sliceH, 0, 0, canvas.width, sliceH);
                doc.addImage(part.toDataURL('image/jpeg', 0.92), 'JPEG', x, y, imgW, sliceH * scale);
                y += sliceH * scale;
                srcY += sliceH;
                if (srcY < canvas.height) newPage();
            }
            y += 2;
        }
    } catch (error) {
        console.error(error);
        showToast('⚠️ Could not build the PDF — please try again.');
        return;
    } finally {
        expanded.forEach(restore => restore());
    }

    const pageCount = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
        doc.setPage(i);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(148, 163, 184);
        doc.text('Mandaluyong City TPMO - Confidential', M, H - 4);
        doc.text(`Page ${i} of ${pageCount}`, W - M, H - 4, { align: 'right' });
    }

    doc.save(`RIMAS_${title.replace(/[^\w-]+/g, '')}_${today()}.pdf`);
    showToast('✅ PDF downloaded');
}

function today() {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

// ===== INIT =====
renderTable();
restoreDashboardSession();
