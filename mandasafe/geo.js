// Shared spatial helpers: barangay centroids + incident coordinate resolution,
// used server-side by both the KDE hotspot engine and the prediction module.
const fs = require('fs');
const path = require('path');

const GEOJSON_PATH = path.join(__dirname, 'data', 'mandaluyong-barangays.geojson');

let cachedCentroids = null;
let cachedBounds = null;

function walkCoordinates(node, points) {
    if (!Array.isArray(node)) return;
    if (typeof node[0] === 'number' && typeof node[1] === 'number') { points.push(node); return; }
    node.forEach(child => walkCoordinates(child, points));
}

function featureCentroid(feature) {
    const points = [];
    walkCoordinates(feature.geometry?.coordinates || [], points);
    if (!points.length) return null;
    const sum = points.reduce((acc, [lng, lat]) => [acc[0] + lng, acc[1] + lat], [0, 0]);
    return { lat: sum[1] / points.length, lng: sum[0] / points.length, points };
}

function loadBoundaries() {
    if (cachedCentroids && cachedBounds) return { centroids: cachedCentroids, bounds: cachedBounds };
    cachedCentroids = new Map();
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    try {
        const raw = fs.readFileSync(GEOJSON_PATH, 'utf8');
        const geojson = JSON.parse(raw);
        (geojson.features || []).forEach(feature => {
            const c = featureCentroid(feature);
            if (!c) return;
            cachedCentroids.set(feature.properties?.brgy_name, { lat: c.lat, lng: c.lng });
            c.points.forEach(([lng, lat]) => {
                if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
                if (lng < minLng) minLng = lng; if (lng > maxLng) maxLng = lng;
            });
        });
    } catch { /* boundary file missing — centroid fallback simply won't be available */ }
    cachedBounds = Number.isFinite(minLat)
        ? { minLat, maxLat, minLng, maxLng }
        : { minLat: 14.55, maxLat: 14.61, minLng: 121.00, maxLng: 121.06 };
    return { centroids: cachedCentroids, bounds: cachedBounds };
}

function getBarangayCentroids() {
    return loadBoundaries().centroids;
}

function getMandaluyongBounds() {
    return loadBoundaries().bounds;
}

// Resolves a usable {lat, lng} for an incident: its own coordinates if present,
// otherwise its barangay's centroid. Returns null if neither is available.
function resolveIncidentPoint(incident) {
    const lat = Number.parseFloat(incident.lat);
    const lng = Number.parseFloat(incident.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
    const centroids = getBarangayCentroids();
    const centroid = centroids.get(incident.barangay);
    return centroid ? { lat: centroid.lat, lng: centroid.lng } : null;
}

module.exports = { getBarangayCentroids, getMandaluyongBounds, resolveIncidentPoint };
