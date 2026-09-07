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
    const max = counts ? Math.max(1, ...Object.values(counts)) : 1;

    const boundaries = L.geoJSON(geo, {
        style: feature => {
            const value = counts ? (counts[brgyName(feature)] || 0) : 0;
            return {
                color: '#1d4ed8',
                weight: 1.4,
                opacity: 0.85,
                fillColor: counts ? shade(value / max) : '#3b82f6',
                fillOpacity: counts ? (value ? 0.62 : 0.12) : 0.06
            };
        },
        onEachFeature: (feature, layer) => {
            const name = brgyName(feature);
            const value = counts ? (counts[name] || 0) : null;
            layer.bindTooltip(
                `<b>${name}</b>` + (value === null ? '' : `<br>${value.toLocaleString()} incident${value === 1 ? '' : 's'}`),
                { sticky: true }
            );
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

/* Choropleth ramp: pale blue (few) → deep red (many). */
function shade(ratio) {
    const stops = ['#dbeafe', '#bfdbfe', '#fde68a', '#fdba74', '#f87171', '#dc2626'];
    return stops[Math.min(stops.length - 1, Math.floor(Math.sqrt(ratio) * stops.length))];
}

/* Individual incident pins, capped so the browser stays responsive. */
function plotIncidents(map, list, limit = 400) {
    const layer = L.layerGroup().addTo(map);
    list.filter(i => Number.isFinite(i.lat) && Number.isFinite(i.lng)).slice(0, limit).forEach(i => {
        const meta = sevMeta(i.sev);
        L.circleMarker([i.lat, i.lng], {
            radius: i.sev === 'Fatal' ? 8 : i.sev === 'Injury' ? 7 : 5,
            color: '#fff', weight: 1.5, fillColor: meta.color, fillOpacity: 0.9
        }).addTo(layer).bindPopup(
            `<b>${esc(i.id)}</b><span>${esc(i.barangay)}${i.road && i.road !== 'Unknown' ? ' • ' + esc(i.road) : ''}</span>` +
            `<div style="margin-top:6px"><span class="tag ${meta.tag}">${esc(i.sev)}</span> ` +
            `<span class="tag ${statusTag(i.status)}">${esc(i.status)}</span></div>` +
            `<div style="margin-top:6px;font-size:11.5px;color:#64748b">${esc(i.type)}<br>${fmtDate(i.date)} ${fmtTime(i.time)}</div>`
        );
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
                `<div style="margin-top:6px;font-size:12px">${num(s.incidentCount)} incidents nearby` +
                `<br>Intensity ${Math.round((s.intensity || 0) * 100)}%</div>`);
    });
    return layer;
}
