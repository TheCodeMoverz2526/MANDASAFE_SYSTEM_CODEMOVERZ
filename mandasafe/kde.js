// Finds genuine spatial hotspots (density peaks) instead of a raw road-count, via a 2D Gaussian
// Kernel Density Estimate over incident coordinates. The KDE itself -- projection to meter-space,
// bandwidth selection and the density surface -- is computed by scikit-learn in ml/hotspots.py;
// see that file for the algorithm. This just hands it the records and returns its answer.
const { runPython } = require('./mlBridge');

// records: [{ lat, lng, weight, ref }]. bounds: { minLat, maxLat, minLng, maxLng }.
function findHotspots(records, bounds, options = {}) {
    if (!records.length) return [];
    return runPython('hotspots.py', { records, bounds, options });
}

module.exports = { findHotspots };
