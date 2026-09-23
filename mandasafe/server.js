const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadStore, saveStore } = require('./db');
const { computePredictions, computeStats } = require('./prediction');
const { findHotspots } = require('./kde');
const { resolveIncidentPoint, getMandaluyongBounds, getBarangayCentroids } = require('./geo');
const auth = require('./auth');

// Load simple KEY=value settings without requiring an external package.
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
    fs.readFileSync(envFile, 'utf8').split(/\r?\n/).forEach(line => {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
    });
}

const PORT = 5500;
const HOST = '0.0.0.0';
const ROOT = __dirname;
const MIME_TYPES = {
    '.css': 'text/css',
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.geojson': 'application/json'
};

function readJson(request, maxBytes = 10000) {
    return new Promise((resolve, reject) => {
        let body = '';
        request.on('data', chunk => { body += chunk; if (body.length > maxBytes) reject(new Error('Request too large')); });
        request.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('Invalid JSON')); } });
        request.on('error', reject);
    });
}

// No delivery provider is wired up yet — the code is generated and returned to the
// caller (shown on-screen) instead of being emailed/texted. Plug a provider in here
// when one is chosen.
async function sendOtp(data) {
    if (!/^\d{6}$/.test(data.code) || !['email', 'sms'].includes(data.channel)) throw new Error('Invalid verification request.');
    return { testMode: true, code: data.code };
}

function sendJson(response, status, payload) {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(payload));
}

function requireFields(body, fields) {
    const missing = fields.filter(field => body[field] === undefined || body[field] === null || body[field] === '');
    if (missing.length) throw new Error(`Missing required field(s): ${missing.join(', ')}`);
}

/* ===== Access control =====================================================
   Accounts and sessions live in the same JSON store as the data (see auth.js).
   Reading is open — that is what lets the public landing page and signed-in users
   see the reports and predictions the administrators produced. Writing is not. */

function actorFor(request) {
    return auth.accountForToken(auth.tokenFromRequest(request));
}

// Returns the signed-in account, or null after already sending the error response.
function requireRole(request, response, role) {
    const account = actorFor(request);
    if (!account) {
        sendJson(response, 401, { error: 'Please sign in to continue.' });
        return null;
    }
    if (role === 'admin' && account.role !== 'admin') {
        sendJson(response, 403, { error: 'Administrator access is required for this action.' });
        return null;
    }
    return account;
}

function handleAuthApi(request, response, urlPath) {
    if (!urlPath.startsWith('/api/auth/')) return false;
    const action = urlPath.slice('/api/auth/'.length);

    if (action === 'me' && request.method === 'GET') {
        const account = actorFor(request);
        if (!account) return sendJson(response, 401, { error: 'Not signed in.' }), true;
        return sendJson(response, 200, account), true;
    }

    if (action === 'register' && request.method === 'POST') {
        readJson(request).then(body => {
            requireFields(body, ['name', 'email', 'phone', 'password']);
            sendJson(response, 201, auth.registerAccount(body));
        }).catch(error => sendJson(response, 400, { error: error.message }));
        return true;
    }

    if (action === 'login' && request.method === 'POST') {
        readJson(request).then(body => {
            requireFields(body, ['identifier', 'password']);
            const account = auth.verifyCredentials(body.identifier, body.password);
            sendJson(response, 200, auth.createSession(account.id));
        }).catch(error => sendJson(response, 401, { error: error.message }));
        return true;
    }

    // Confirms an identifier exists and returns the contact points the OTP screen masks.
    if (action === 'contact' && request.method === 'POST') {
        readJson(request).then(body => {
            requireFields(body, ['identifier']);
            sendJson(response, 200, auth.contactDetails(body.identifier));
        }).catch(error => sendJson(response, 404, { error: error.message }));
        return true;
    }

    if (action === 'reset-password' && request.method === 'POST') {
        readJson(request).then(body => {
            requireFields(body, ['identifier', 'password']);
            sendJson(response, 200, auth.resetPassword(body.identifier, body.password));
        }).catch(error => sendJson(response, 400, { error: error.message }));
        return true;
    }

    // The signed-in account editing its own details — the bearer token is the proof.
    if (action === 'profile' && request.method === 'PUT') {
        const account = actorFor(request);
        if (!account) return sendJson(response, 401, { error: 'Not signed in.' }), true;
        readJson(request).then(body => {
            requireFields(body, ['name', 'email', 'phone']);
            sendJson(response, 200, auth.updateOwnProfile(account.id, body));
        }).catch(error => sendJson(response, 400, { error: error.message }));
        return true;
    }

    if (action === 'logout' && request.method === 'POST') {
        auth.destroySession(auth.tokenFromRequest(request));
        return sendJson(response, 200, { signedOut: true }), true;
    }

    sendJson(response, 404, { error: 'Unknown auth endpoint.' });
    return true;
}

function handleAccountsApi(request, response, urlPath) {
    const match = urlPath.match(/^\/api\/accounts(?:\/([^/]+))?$/);
    if (!match) return false;
    const id = match[1] ? decodeURIComponent(match[1]) : null;

    if (request.method === 'GET' && !id) {
        if (!requireRole(request, response, 'admin')) return true;
        return sendJson(response, 200, auth.listAccounts()), true;
    }

    if (request.method === 'POST' && !id) {
        if (!requireRole(request, response, 'admin')) return true;
        readJson(request).then(body => {
            requireFields(body, ['name', 'email', 'phone', 'password']);
            const created = auth.registerAccount(body);
            // An admin adding a user may set the role straight away.
            sendJson(response, 201, body.role === 'admin' ? auth.updateAccount(created.id, { role: 'admin' }) : created);
        }).catch(error => sendJson(response, 400, { error: error.message }));
        return true;
    }

    if (request.method === 'PUT' && id) {
        if (!requireRole(request, response, 'admin')) return true;
        readJson(request).then(body => {
            sendJson(response, 200, auth.updateAccount(id, body));
        }).catch(error => sendJson(response, 400, { error: error.message }));
        return true;
    }

    if (request.method === 'DELETE' && id) {
        if (!requireRole(request, response, 'admin')) return true;
        try {
            sendJson(response, 200, auth.deleteAccount(id));
        } catch (error) {
            sendJson(response, 400, { error: error.message });
        }
        return true;
    }

    sendJson(response, 405, { error: 'Method not allowed.' });
    return true;
}

function nextIncidentId(store) {
    const id = `#A${10000 + store.nextIncidentSeq}`;
    store.nextIncidentSeq += 1;
    return id;
}

function nextInputId(store) {
    const id = `RF-${1000 + store.nextInputSeq}`;
    store.nextInputSeq += 1;
    return id;
}

function handleIncidentsBulkApi(request, response, urlPath) {
    if (urlPath !== '/api/incidents/bulk' || request.method !== 'POST') return false;
    const actor = requireRole(request, response, 'admin');
    if (!actor) return true;
    readJson(request, 30 * 1024 * 1024).then(body => {
        const records = Array.isArray(body.records) ? body.records : [];
        if (!records.length) throw new Error('No records to import.');
        const store = loadStore();
        const existingKeys = new Set(store.incidents.map(item => [item.date, item.time, item.barangay, item.road, item.type].join('||').toLowerCase()));

        const created = [];
        const skipped = [];
        records.forEach((body, index) => {
            try {
                requireFields(body, ['barangay', 'road', 'sev', 'type', 'date']);
                const key = [body.date, body.time || '', body.barangay, body.road, body.type].join('||').toLowerCase();
                if (existingKeys.has(key)) { skipped.push({ index, reason: 'Duplicate of an existing incident' }); return; }
                existingKeys.add(key);
                const record = {
                    id: nextIncidentId(store),
                    date: body.date,
                    time: body.time || '',
                    loc: body.loc || 'Mandaluyong',
                    barangay: body.barangay,
                    road: body.road,
                    sev: body.sev,
                    type: body.type,
                    lat: body.lat !== undefined && body.lat !== null && body.lat !== '' ? Number.parseFloat(body.lat) : null,
                    lng: body.lng !== undefined && body.lng !== null && body.lng !== '' ? Number.parseFloat(body.lng) : null,
                    status: body.status || 'active',
                    createdBy: actor.email,
                    createdAt: new Date().toISOString()
                };
                store.incidents.unshift(record);
                created.push(record);
            } catch (error) {
                skipped.push({ index, reason: error.message });
            }
        });

        saveStore(store);
        sendJson(response, 201, { created, skipped, createdCount: created.length, skippedCount: skipped.length });
    }).catch(error => sendJson(response, 400, { error: error.message }));
    return true;
}

function handleIncidentsApi(request, response, urlPath) {
    const match = urlPath.match(/^\/api\/incidents(?:\/([^/]+))?$/);
    if (!match) return false;
    const id = match[1] ? decodeURIComponent(match[1]) : null;
    const store = loadStore();

    // Anyone may read the incident list — that is how signed-in users and the public
    // landing page see the accident reports the administrators entered.
    if (request.method === 'GET' && !id) {
        sendJson(response, 200, store.incidents);
        return true;
    }

    // Everything below changes data, so it needs an administrator session.
    const actor = requireRole(request, response, 'admin');
    if (!actor) return true;

    if (request.method === 'POST' && !id) {
        readJson(request).then(body => {
            requireFields(body, ['barangay', 'road', 'sev', 'type', 'date']);
            const record = {
                id: nextIncidentId(store),
                date: body.date,
                time: body.time || '',
                loc: body.loc || 'Mandaluyong',
                barangay: body.barangay,
                road: body.road,
                sev: body.sev,
                type: body.type,
                lat: body.lat !== undefined ? Number.parseFloat(body.lat) : null,
                lng: body.lng !== undefined ? Number.parseFloat(body.lng) : null,
                status: body.status || 'active',
                createdBy: actor.email,
                createdAt: new Date().toISOString()
            };
            store.incidents.unshift(record);
            saveStore(store);
            sendJson(response, 201, record);
        }).catch(error => sendJson(response, 400, { error: error.message }));
        return true;
    }

    if (request.method === 'PUT' && id) {
        readJson(request).then(body => {
            const index = store.incidents.findIndex(item => item.id === id);
            if (index === -1) return sendJson(response, 404, { error: 'Incident not found.' });
            const existing = store.incidents[index];
            const updated = {
                ...existing,
                date: body.date ?? existing.date,
                time: body.time ?? existing.time,
                barangay: body.barangay ?? existing.barangay,
                road: body.road ?? existing.road,
                sev: body.sev ?? existing.sev,
                type: body.type ?? existing.type,
                lat: body.lat !== undefined ? Number.parseFloat(body.lat) : existing.lat,
                lng: body.lng !== undefined ? Number.parseFloat(body.lng) : existing.lng,
                status: body.status ?? existing.status,
                updatedBy: actor.email,
                updatedAt: new Date().toISOString()
            };
            store.incidents[index] = updated;
            saveStore(store);
            sendJson(response, 200, updated);
        }).catch(error => sendJson(response, 400, { error: error.message }));
        return true;
    }

    if (request.method === 'DELETE' && id) {
        const index = store.incidents.findIndex(item => item.id === id);
        if (index === -1) { sendJson(response, 404, { error: 'Incident not found.' }); return true; }
        store.incidents.splice(index, 1);
        saveStore(store);
        sendJson(response, 200, { deleted: id });
        return true;
    }

    sendJson(response, 405, { error: 'Method not allowed.' });
    return true;
}

function handlePredictionInputsApi(request, response, urlPath) {
    const match = urlPath.match(/^\/api\/prediction-inputs(?:\/([^/]+))?$/);
    if (!match) return false;
    const id = match[1] ? decodeURIComponent(match[1]) : null;
    const store = loadStore();

    if (request.method === 'GET' && !id) {
        sendJson(response, 200, store.predictionInputs);
        return true;
    }

    // Baseline prediction data is admin-entered — it drives every forecast users see.
    const actor = requireRole(request, response, 'admin');
    if (!actor) return true;

    if (request.method === 'POST' && !id) {
        readJson(request).then(body => {
            requireFields(body, ['barangay', 'month', 'incidentCount']);
            if (!/^\d{4}-\d{2}$/.test(body.month)) throw new Error('Month must be in YYYY-MM format.');
            const count = Number(body.incidentCount);
            if (!Number.isFinite(count) || count < 0) throw new Error('Incident count must be a non-negative number.');
            const record = {
                id: nextInputId(store),
                barangay: body.barangay,
                road: body.road || 'All Roads',
                month: body.month,
                incidentCount: count,
                notes: body.notes || '',
                updatedBy: actor.email,
                updatedAt: new Date().toISOString()
            };
            store.predictionInputs.unshift(record);
            saveStore(store);
            sendJson(response, 201, record);
        }).catch(error => sendJson(response, 400, { error: error.message }));
        return true;
    }

    if (request.method === 'PUT' && id) {
        readJson(request).then(body => {
            const index = store.predictionInputs.findIndex(item => item.id === id);
            if (index === -1) return sendJson(response, 404, { error: 'Prediction data entry not found.' });
            const existing = store.predictionInputs[index];
            if (body.month && !/^\d{4}-\d{2}$/.test(body.month)) throw new Error('Month must be in YYYY-MM format.');
            const updated = {
                ...existing,
                barangay: body.barangay ?? existing.barangay,
                road: body.road ?? existing.road,
                month: body.month ?? existing.month,
                incidentCount: body.incidentCount !== undefined ? Number(body.incidentCount) : existing.incidentCount,
                notes: body.notes ?? existing.notes,
                updatedBy: actor.email,
                updatedAt: new Date().toISOString()
            };
            store.predictionInputs[index] = updated;
            saveStore(store);
            sendJson(response, 200, updated);
        }).catch(error => sendJson(response, 400, { error: error.message }));
        return true;
    }

    if (request.method === 'DELETE' && id) {
        const index = store.predictionInputs.findIndex(item => item.id === id);
        if (index === -1) { sendJson(response, 404, { error: 'Prediction data entry not found.' }); return true; }
        store.predictionInputs.splice(index, 1);
        saveStore(store);
        sendJson(response, 200, { deleted: id });
        return true;
    }

    sendJson(response, 405, { error: 'Method not allowed.' });
    return true;
}

const SEVERITY_WEIGHTS = { Fatal: 4, Injury: 3, Minor: 2, Damage: 1 };

// Runs the Gaussian KDE hotspot finder over every incident with a resolvable location
// (its own coordinates, or its barangay's centroid as a fallback), weighted by severity.
function computeHotspots(store) {
    const records = (store.incidents || [])
        .map(incident => {
            const point = resolveIncidentPoint(incident);
            if (!point) return null;
            return { lat: point.lat, lng: point.lng, weight: SEVERITY_WEIGHTS[incident.sev] || 1, ref: incident };
        })
        .filter(Boolean);
    return findHotspots(records, getMandaluyongBounds());
}

// ===== Public summary =====================================================
// One small payload for the resident-facing pages: totals, per-barangay counts (with the
// barangay centroid so the map can label them), monthly trend, type/severity mix and the
// newest reports. Sending this instead of all ~8,000 incident rows keeps those pages quick.
function computeSummary(store) {
    const incidents = store.incidents || [];
    const predictions = computePredictions(store);
    const stats = computeStats(store, predictions);

    const byBarangay = new Map();
    const byMonth = new Map();
    const byType = new Map();
    const bySeverity = new Map();

    incidents.forEach(incident => {
        const barangay = incident.barangay || 'Unknown';
        if (!byBarangay.has(barangay)) {
            const centroid = getBarangayCentroids().get(barangay);
            byBarangay.set(barangay, { barangay, count: 0, lat: centroid ? centroid.lat : null, lng: centroid ? centroid.lng : null });
        }
        byBarangay.get(barangay).count += 1;

        const month = (incident.date || '').slice(0, 7);
        if (/^\d{4}-\d{2}$/.test(month)) byMonth.set(month, (byMonth.get(month) || 0) + 1);
        byType.set(incident.type || 'Unknown', (byType.get(incident.type || 'Unknown') || 0) + 1);
        bySeverity.set(incident.sev || 'Unknown', (bySeverity.get(incident.sev || 'Unknown') || 0) + 1);
    });

    const dates = incidents.map(i => i.date).filter(Boolean).sort();
    const recent = [...incidents]
        .sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`))
        .slice(0, 20);

    return {
        ...stats,
        range: { from: dates[0] || null, to: dates[dates.length - 1] || null },
        barangayCount: byBarangay.size,
        byBarangay: [...byBarangay.values()].sort((a, b) => b.count - a.count),
        byMonth: [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([month, count]) => ({ month, count })),
        byType: [...byType.entries()].sort((a, b) => b[1] - a[1]).map(([type, count]) => ({ type, count })),
        bySeverity: [...bySeverity.entries()].sort((a, b) => b[1] - a[1]).map(([sev, count]) => ({ sev, count })),
        topPredictions: predictions.slice(0, 6),
        recent
    };
}

http.createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-rimas-token');
    if (request.method === 'OPTIONS') { response.writeHead(204); return response.end(); }

    const urlPath = decodeURIComponent(request.url.split('?')[0]);

    if (request.method === 'GET' && urlPath === '/api/predictions') {
        const store = loadStore();
        return sendJson(response, 200, computePredictions(store));
    }
    if (request.method === 'GET' && urlPath === '/api/stats') {
        const store = loadStore();
        const predictions = computePredictions(store);
        return sendJson(response, 200, computeStats(store, predictions));
    }
    if (request.method === 'GET' && urlPath === '/api/summary') {
        return sendJson(response, 200, computeSummary(loadStore()));
    }
    if (request.method === 'GET' && urlPath === '/api/hotspots') {
        const store = loadStore();
        return sendJson(response, 200, computeHotspots(store));
    }
    if (handleAuthApi(request, response, urlPath)) return;
    if (handleAccountsApi(request, response, urlPath)) return;
    if (handleIncidentsBulkApi(request, response, urlPath)) return;
    if (handleIncidentsApi(request, response, urlPath)) return;
    if (handlePredictionInputsApi(request, response, urlPath)) return;

    if (request.method === 'GET' && request.url === '/api/otp-status') {
        response.writeHead(200, { 'Content-Type': 'application/json' }); return response.end(JSON.stringify({ testMode: true, email: true, sms: true }));
    }
    if (request.method === 'GET' && request.url === '/api/barangays') {
        return fs.readFile(path.join(ROOT, 'data', 'mandaluyong-barangays.geojson'), (error, content) => {
            if (error) { response.writeHead(500, { 'Content-Type': 'application/json' }); return response.end(JSON.stringify({ error: 'Barangay boundary data is missing.' })); }
            response.writeHead(200, { 'Content-Type': 'application/geo+json' }); response.end(content);
        });
    }
    if (request.method === 'POST' && request.url === '/api/send-otp') {
        return readJson(request).then(sendOtp).then(result => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(result || { sent: true })); }).catch(error => { response.writeHead(502, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: error.message })); });
    }
    const requestedPath = request.url === '/' ? '/index.html' : decodeURIComponent(request.url.split('?')[0]);
    const filePath = path.resolve(ROOT, `.${requestedPath}`);

    if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
        response.writeHead(403);
        return response.end('Forbidden');
    }

    fs.readFile(filePath, (error, content) => {
        if (error) {
            response.writeHead(error.code === 'ENOENT' ? 404 : 500);
            return response.end(error.code === 'ENOENT' ? 'Not found' : 'Server error');
        }
        response.writeHead(200, { 'Content-Type': `${MIME_TYPES[path.extname(filePath)] || 'application/octet-stream'}; charset=utf-8` });
        response.end(content);
    });
}).listen(PORT, HOST, () => {
    console.log('Starting RIMAS server');
    auth.seedDefaultAdmin();
    console.log(`MandaSafe is running at http://localhost:${PORT}/`);
    const addresses = Object.values(os.networkInterfaces()).flat().filter(network => network.family === 'IPv4' && !network.internal);
    addresses.forEach(network => console.log(`Mobile access: http://${network.address}:${PORT}/`));
});
