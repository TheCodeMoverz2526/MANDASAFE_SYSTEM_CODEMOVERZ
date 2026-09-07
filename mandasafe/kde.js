// 2D Gaussian Kernel Density Estimation over incident coordinates, projected to a local
// meter-space so the kernel is isotropic in real distance rather than raw lat/lng degrees.
// Used to find genuine spatial hotspots (density peaks) instead of a raw road-count.

const METERS_PER_DEG_LAT = 111320;

function project(lat, lng, originLat, originLng) {
    const cosLat = Math.cos(originLat * Math.PI / 180);
    return {
        x: (lng - originLng) * METERS_PER_DEG_LAT * cosLat,
        y: (lat - originLat) * METERS_PER_DEG_LAT
    };
}

function unproject(x, y, originLat, originLng) {
    const cosLat = Math.cos(originLat * Math.PI / 180);
    return {
        lat: originLat + y / METERS_PER_DEG_LAT,
        lng: originLng + x / (METERS_PER_DEG_LAT * cosLat)
    };
}

function gaussian(u) { return Math.exp(-0.5 * u * u) / Math.sqrt(2 * Math.PI); }

// Silverman's rule of thumb, weighted by an effective sample size (sum(w)^2 / sum(w^2))
// so heavily-weighted points (e.g. fatal incidents) don't understate the bandwidth.
function silvermanBandwidth(values, weights) {
    const n = values.length;
    if (n < 2) return 150; // fallback: ~1.5 city blocks, avoids a degenerate zero-width kernel
    const sumW = weights.reduce((a, b) => a + b, 0);
    const mean = values.reduce((a, v, i) => a + v * weights[i], 0) / sumW;
    const variance = values.reduce((a, v, i) => a + weights[i] * (v - mean) ** 2, 0) / sumW;
    const std = Math.sqrt(Math.max(variance, 1e-6));
    const effectiveN = Math.max(2, (sumW * sumW) / weights.reduce((a, w) => a + w * w, 0));
    const h = 1.06 * std * Math.pow(effectiveN, -1 / 5);
    return Math.max(h, 40); // never collapse below ~40m — keeps the surface smooth at city scale
}

function densityAt(x, y, projected, weights, hx, hy, sumW) {
    let total = 0;
    for (let i = 0; i < projected.length; i++) {
        const ux = (x - projected[i].x) / hx;
        const uy = (y - projected[i].y) / hy;
        total += weights[i] * gaussian(ux) * gaussian(uy);
    }
    return total / (sumW * hx * hy);
}

// records: [{ lat, lng, weight, ref }]. bounds: { minLat, maxLat, minLng, maxLng }.
function findHotspots(records, bounds, options = {}) {
    const { gridSize = 36, topN = 8, minSeparationMeters = 400, minRelativeDensity = 0.12, sampleRadiusMeters = 260 } = options;
    if (!records.length) return [];

    const originLat = (bounds.minLat + bounds.maxLat) / 2;
    const originLng = (bounds.minLng + bounds.maxLng) / 2;
    const projected = records.map(r => project(r.lat, r.lng, originLat, originLng));
    const weights = records.map(r => Math.max(r.weight, 0.01));
    const sumW = weights.reduce((a, b) => a + b, 0);

    const hx = silvermanBandwidth(projected.map(p => p.x), weights);
    const hy = silvermanBandwidth(projected.map(p => p.y), weights);

    const padLat = (bounds.maxLat - bounds.minLat) * 0.04;
    const padLng = (bounds.maxLng - bounds.minLng) * 0.04;
    const latStep = (bounds.maxLat - bounds.minLat + padLat * 2) / gridSize;
    const lngStep = (bounds.maxLng - bounds.minLng + padLng * 2) / gridSize;

    const cells = [];
    let maxDensity = 0;
    for (let i = 0; i <= gridSize; i++) {
        const lat = bounds.minLat - padLat + i * latStep;
        for (let j = 0; j <= gridSize; j++) {
            const lng = bounds.minLng - padLng + j * lngStep;
            const { x, y } = project(lat, lng, originLat, originLng);
            const density = densityAt(x, y, projected, weights, hx, hy, sumW);
            if (density > maxDensity) maxDensity = density;
            cells.push({ lat, lng, x, y, density });
        }
    }
    if (maxDensity <= 0) return [];

    cells.sort((a, b) => b.density - a.density);

    const hotspots = [];
    for (const cell of cells) {
        if (cell.density / maxDensity < minRelativeDensity) break;
        if (hotspots.length >= topN) break;
        const tooClose = hotspots.some(h => Math.hypot(h.x - cell.x, h.y - cell.y) < minSeparationMeters);
        if (tooClose) continue;

        const nearby = records.filter((r, i) => Math.hypot(projected[i].x - cell.x, projected[i].y - cell.y) <= sampleRadiusMeters);
        if (!nearby.length) continue;
        const roadCounts = new Map();
        const barangayCounts = new Map();
        nearby.forEach(r => {
            roadCounts.set(r.ref.road, (roadCounts.get(r.ref.road) || 0) + 1);
            barangayCounts.set(r.ref.barangay, (barangayCounts.get(r.ref.barangay) || 0) + 1);
        });
        const topRoad = [...roadCounts.entries()].sort((a, b) => b[1] - a[1])[0];
        const topBarangay = [...barangayCounts.entries()].sort((a, b) => b[1] - a[1])[0];

        hotspots.push({
            lat: cell.lat, lng: cell.lng, x: cell.x, y: cell.y,
            density: cell.density,
            intensity: Math.round((cell.density / maxDensity) * 100) / 100,
            incidentCount: nearby.length,
            road: topRoad ? topRoad[0] : 'Unknown',
            barangay: topBarangay ? topBarangay[0] : 'Unknown',
            fatalCount: nearby.filter(r => r.ref.sev === 'Fatal').length
        });
    }

    // When many incidents share the exact same fallback (barangay-centroid) coordinates,
    // the kernel's spread can still surface more than one grid peak for the same road —
    // collapse those down to the single strongest peak per road/barangay pair.
    const byLocation = new Map();
    hotspots.forEach(h => {
        const key = `${h.barangay}||${h.road}`;
        const existing = byLocation.get(key);
        if (!existing || h.density > existing.density) byLocation.set(key, h);
    });

    return [...byLocation.values()]
        .sort((a, b) => b.density - a.density)
        .map(({ x, y, ...rest }) => rest);
}

module.exports = { findHotspots, silvermanBandwidth };
