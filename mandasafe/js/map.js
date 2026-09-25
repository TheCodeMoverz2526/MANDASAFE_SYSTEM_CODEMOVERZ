/* =========================================================
   MandaSafe — Leaflet maps for the resident side

   The city outline is NOT hand-drawn: it comes from the same
   data/mandaluyong-barangays.geojson the RIMAS server uses for barangay
   centroids, so the resident map and the admin console draw identical
   boundaries. Everything outside those 27 barangay polygons is masked out
   and the view cannot be panned away from the city.
   ========================================================= */

const GEOJSON_URL = 'data/mandaluyong-barangays.geojson';
const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTR = '&copy; OpenStreetMap contributors | Mandaluyong City TPMO';
const WORLD_RING = [[-90, -180], [-90, 180], [90, 180], [90, -180]];

let barangayGeo = null;

async function loadBarangayGeo() {
    if (barangayGeo) return barangayGeo;
    const response = await fetch(GEOJSON_URL, { cache: 'force-cache' });
    if (!response.ok) throw new Error('Barangay boundary file could not be loaded.');
    barangayGeo = await response.json();
    return barangayGeo;
}

function brgyName(feature) {
    const p = feature.properties || {};
    return p.brgy_name || p.name || 'Unknown';
}

/* The exact palette the RIMAS console tints each barangay with, picked by its PSGC code
   rather than by incident count, so a barangay is always the same colour whatever is
   filtered — and the resident map now reads the same way the admin one does. */
const MANDALUYONG_PALETTE = ['#1a56db', '#0f766e', '#7c3aed', '#c2410c', '#be185d', '#047857', '#0369a1', '#6d28d9', '#b45309'];
function brgyStyle(feature) {
    const code = String((feature.properties || {}).psgc_10d || '');
    const index = Number(code.slice(-2)) - 1;
    const color = MANDALUYONG_PALETTE[((index % MANDALUYONG_PALETTE.length) + MANDALUYONG_PALETTE.length) % MANDALUYONG_PALETTE.length];
    return { color, weight: 1.5, opacity: .9, fillColor: color, fillOpacity: .18 };
}

/* Every outer ring of every barangay, as Leaflet [lat, lng] pairs — used both
   for the mask holes and for fitting the map to the real city extent. */
function outerRings(geo) {
    const rings = [];
    (geo.features || []).forEach(feature => {
        const g = feature.geometry || {};
        if (g.type === 'Polygon') rings.push(g.coordinates[0]);
        if (g.type === 'MultiPolygon') g.coordinates.forEach(poly => rings.push(poly[0]));
    });
    return rings.map(ring => ring.map(([lng, lat]) => [lat, lng]));
}

/* Creates a map locked to Mandaluyong.
   options: { zoom, scroll, zoomControl, counts } — counts is an optional
   { barangayName: incidentCount } map that shades each barangay. */
async function createMandaMap(elId, options = {}) {
    const geo = await loadBarangayGeo();
    const rings = outerRings(geo);
    const cityBounds = L.latLngBounds(rings.flat());

    const map = L.map(elId, {
        zoomControl: options.zoomControl !== false,
        scrollWheelZoom: options.scroll !== false,
        minZoom: 12,
        maxZoom: 18,
        maxBounds: cityBounds.pad(0.25),
        maxBoundsViscosity: 0.9
    }).fitBounds(cityBounds, { padding: [10, 10] });

    L.tileLayer(TILE_URL, { attribution: TILE_ATTR, maxZoom: 19 }).addTo(map);

    // Dim everything outside the city: one polygon with every barangay as a hole.
    L.polygon([WORLD_RING, ...rings], {
        stroke: false, fillColor: '#0b2f6d', fillOpacity: 0.35, interactive: false
    }).addTo(map);

    const counts = options.counts || null;

    const boundaries = L.geoJSON(geo, {
        style: brgyStyle,
        onEachFeature: (feature, layer) => {
            const name = brgyName(feature);
            const value = counts ? (counts[name] || 0) : null;
            // A permanent name label, the same way the admin console labels every barangay,
            // plus a click popup for the count — kept separate so the always-visible label
            // never has to be redrawn just because the filters changed.
            layer.bindTooltip(name, { className: 'brgy-tooltip', permanent: true, direction: 'center', opacity: .92 });
            if (value !== null) {
                layer.bindPopup(`<b>${name}</b><br>${value.toLocaleString()} accident${value === 1 ? '' : 's'}`);
            }
            layer.on({
                mouseover: e => e.target.setStyle({ weight: 3, color: '#f97316' }),
                mouseout: e => boundaries.resetStyle(e.target)
            });
        }
    }).addTo(map);

    // City outline drawn on top so the municipal border stays readable.
    L.polygon(rings, { color: '#0b2f6d', weight: 3, opacity: 0.9, fill: false, interactive: false }).addTo(map);

    setTimeout(() => map.invalidateSize(), 200);
    return { map, geo, boundaries, cityBounds };
}

/* Thousands of shapes as separate SVG elements make the map crawl; drawn onto one canvas per
   map they stay smooth even with every accident on record. */
function canvasFor(map) {
    if (!map._msCanvas) map._msCanvas = L.canvas({ padding: 0.5 });
    return map._msCanvas;
}

/* Individual accident pins — every one on record unless a limit is passed. The popup text is
   built only when a pin is clicked, not up front for thousands of pins. */
function plotIncidents(map, list, limit = Infinity) {
    const layer = L.layerGroup().addTo(map);
    const renderer = canvasFor(map);
    list.filter(i => Number.isFinite(i.lat) && Number.isFinite(i.lng)).slice(0, limit).forEach(i => {
        const meta = sevMeta(i.sev);
        L.circleMarker([i.lat, i.lng], {
            renderer,
            radius: i.sev === 'Fatal' ? 8 : i.sev === 'Injury' ? 7 : 5,
            color: '#fff', weight: 1.5, fillColor: meta.color, fillOpacity: 0.9
        }).addTo(layer).bindPopup(() =>
            `<b>${esc(i.id)}</b><span>${esc(i.barangay)}${i.road && i.road !== 'Unknown' ? ' • ' + esc(i.road) : ''}</span>` +
            `<div style="margin-top:6px"><span class="tag ${meta.tag}">${esc(i.sev)}</span> ` +
            `<span class="tag ${statusTag(i.status)}">${esc(i.status)}</span></div>` +
            `<div style="margin-top:6px;font-size:11.5px;color:#64748b">${esc(i.type)}<br>${fmtDate(i.date)} ${fmtTime(i.time)}</div>`
        );
    });
    return layer;
}

/* Soft severity-weighted glow per incident — the same "heatmap" the admin console draws,
   built from plain circles rather than a raster layer so it needs no extra library. */
function plotHeat(map, list) {
    const layer = L.layerGroup().addTo(map);
    const renderer = canvasFor(map);
    list.filter(i => Number.isFinite(i.lat) && Number.isFinite(i.lng)).forEach(i => {
        const radius = i.sev === 'Fatal' ? 260 : i.sev === 'Injury' ? 200 : 150;
        const fillOpacity = i.sev === 'Fatal' ? 0.22 : 0.16;
        const color = sevMeta(i.sev).color;
        L.circle([i.lat, i.lng], { renderer, radius, color, fillColor: color, fillOpacity, weight: 0, interactive: false }).addTo(layer);
    });
    return layer;
}

/* KDE hotspot peaks from /api/hotspots, drawn as graded circles. */
function plotHotspots(map, spots) {
    const layer = L.layerGroup().addTo(map);
    const rings = [
        { r: 620, o: 0.10, c: '#f97316' },
        { r: 430, o: 0.15, c: '#fb923c' },
        { r: 280, o: 0.22, c: '#f59e0b' },
        { r: 160, o: 0.30, c: '#ef4444' }
    ];
    spots.forEach(s => {
        const weight = Math.max(0.35, s.intensity || 0.5);
        rings.forEach(g => L.circle([s.lat, s.lng], {
            radius: g.r * weight, stroke: false, fillColor: g.c, fillOpacity: g.o, interactive: false
        }).addTo(layer));
        L.circleMarker([s.lat, s.lng], { radius: 6, color: '#fff', weight: 2, fillColor: '#b91c1c', fillOpacity: 1 })
            .addTo(layer)
            .bindPopup(`<b>${esc(s.barangay)}</b><span>${esc(s.road)}</span>` +
                `<div style="margin-top:6px;font-size:12px">${num(s.incidentCount)} accidents nearby` +
                `<br>Intensity ${Math.round((s.intensity || 0) * 100)}%</div>`);
    });
    return layer;
}

/* One spot per barangay from /api/hotspots/barangays, at the barangay's own densest accident
   location. Intensities are steep (the top barangay dwarfs the rest), so the glow grows with
   the square root of intensity and never drops below a floor — every barangay stays visible. */
function plotBarangaySpots(map, ranking) {
    const layer = L.layerGroup().addTo(map);
    const rings = [
        { r: 520, o: 0.10, c: '#f97316' },
        { r: 360, o: 0.15, c: '#fb923c' },
        { r: 230, o: 0.22, c: '#f59e0b' },
        { r: 130, o: 0.30, c: '#ef4444' }
    ];
    ranking.forEach((s, n) => {
        if (s.lat == null || s.lng == null) return;
        const weight = Math.max(0.3, Math.sqrt(s.intensity || 0));
        rings.forEach(g => L.circle([s.lat, s.lng], {
            radius: g.r * weight, stroke: false, fillColor: g.c, fillOpacity: g.o, interactive: false
        }).addTo(layer));
        const pct = (s.intensity || 0) * 100;
        L.circleMarker([s.lat, s.lng], { radius: 6, color: '#fff', weight: 2, fillColor: '#b91c1c', fillOpacity: 1 })
            .addTo(layer)
            .bindPopup(`<b>#${n + 1} ${esc(s.barangay)}</b>` +
                `<div style="margin-top:6px;font-size:12px">${num(s.incidentCount)} accidents` +
                `<br>Intensity ${pct >= 1 ? Math.round(pct) + '%' : pct > 0 ? '&lt;1%' : '0%'}</div>`);
    });
    return layer;
}

/* =========================================================
   Barangay search — used by the Incident Map's search bar.

   Matching runs on a "folded" form of the name: lower case, accents stripped,
   punctuation collapsed to single spaces. That way "wack wack", "Wack-Wack"
   and "wackwack" all reach Wack-wack Greenhills, "zaniga" still finds
   New Zañiga, and "mabini j rizal" finds Mabini-J. Rizal.
   ========================================================= */

function foldName(value) {
    return String(value ?? '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function barangayNames(geo) {
    return ((geo || {}).features || []).map(brgyName).sort((a, b) => a.localeCompare(b));
}

/* Partial or complete names, best first: an exact name, then names that start
   with what was typed, then names with a word starting with it, then any name
   containing it — and last, the same test with every space dropped, so
   "wackwack" and "pagasa" land too. Returns [] for an empty query or a name
   that is not one of the 27 barangays. */
function matchBarangays(geo, query) {
    const q = foldName(query);
    if (!q) return [];
    const tight = q.replace(/ /g, '');
    return barangayNames(geo)
        .map(name => {
            const folded = foldName(name);
            const rank = folded === q ? 0
                : folded.startsWith(q) ? 1
                : folded.split(' ').some(word => word.startsWith(q)) ? 2
                : folded.includes(q) ? 3
                : folded.replace(/ /g, '').includes(tight) ? 4 : -1;
            return { name, rank };
        })
        .filter(m => m.rank >= 0)
        .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
        .map(m => m.name);
}

function findBarangayFeature(geo, name) {
    const q = foldName(name);
    return ((geo || {}).features || []).find(f => foldName(brgyName(f)) === q) || null;
}

/* The searched barangay is outlined in the same orange the hover state uses. */
const FOCUS_STYLE = {
    color: '#ea580c', weight: 4, opacity: 1,
    fillColor: '#f97316', fillOpacity: 0.25,
    className: 'brgy-focus', interactive: false
};

/* Zooms to one barangay and outlines it, returning the highlight layer so the
   caller can clear it again — or null when `name` is not one of the 27.
   The outline is a layer of its own rather than a restyle of the boundary
   layer, so it survives a mouse-over (which resets boundary styles) and stays
   visible even with Barangay Boundaries switched off. */
function focusBarangay(map, geo, name, previous) {
    if (previous) map.removeLayer(previous);
    const feature = findBarangayFeature(geo, name);
    if (!feature) return null;

    const highlight = L.geoJSON(feature, { style: () => FOCUS_STYLE, interactive: false }).addTo(map);
    highlight.bringToFront();
    map.flyToBounds(highlight.getBounds(), { padding: [40, 40], maxZoom: 17, duration: 0.9 });
    return highlight;
}
