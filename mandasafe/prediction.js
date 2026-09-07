// Computes road-safety predictions purely from data that actually exists in the store:
// admin-entered baseline monthly counts (predictionInputs) plus logged incidents.
// No hardcoded or mock prediction values are used anywhere in this module.
//
// Two signals feed the final risk score:
//  - a linear forecast of incident frequency per barangay/road (trend + volume), and
//  - a Random Forest classifier trained on logged incidents that estimates how likely a
//    severe outcome (Fatal/Injury) is for that location, from barangay/road/type/time features.
// The forest needs a minimum amount of labeled, class-diverse history to train at all; until
// then predictions fall back to the frequency signal alone (mlModel: 'heuristic').

const { trainRandomForest, predictClass } = require('./randomForest');

const SEVERITY_FEATURES = [
    { key: 'barangay', type: 'categorical' },
    { key: 'road', type: 'categorical' },
    { key: 'type', type: 'categorical' },
    { key: 'hour', type: 'numeric' },
    { key: 'dayOfWeek', type: 'numeric' },
    { key: 'month', type: 'numeric' }
];
const SEVERE_CLASSES = new Set(['Fatal', 'Injury']);

function parseHour(timeStr) {
    if (!timeStr) return -1;
    const parsed = new Date(`2000-01-01 ${timeStr}`);
    return Number.isNaN(parsed.getTime()) ? -1 : parsed.getHours();
}

function incidentFeatures(incident) {
    const d = new Date(incident.date);
    const valid = !Number.isNaN(d.getTime());
    return {
        barangay: incident.barangay || 'Unknown',
        road: incident.road || 'Unknown',
        type: incident.type || 'Unknown',
        hour: parseHour(incident.time),
        dayOfWeek: valid ? d.getDay() : -1,
        month: valid ? d.getMonth() : -1
    };
}

function trainSeverityForest(incidents) {
    const rows = (incidents || [])
        .filter(i => i.barangay && i.road && i.sev)
        .map(i => ({ ...incidentFeatures(i), sev: i.sev }));
    return trainRandomForest(rows, { features: SEVERITY_FEATURES, labelKey: 'sev' });
}

// Average, across a group's own logged incidents, the forest's predicted probability that
// the outcome is severe (Fatal or Injury). Returns null when there's nothing to score.
function groupSeverityProbability(forest, groupIncidents) {
    if (!forest || !groupIncidents || !groupIncidents.length) return null;
    const total = groupIncidents.reduce((sum, incident) => {
        const result = predictClass(forest, incidentFeatures(incident));
        if (!result) return sum;
        return sum + Object.entries(result.probabilities).reduce((s, [label, p]) => s + (SEVERE_CLASSES.has(label) ? p : 0), 0);
    }, 0);
    return total / groupIncidents.length;
}

function monthKey(dateStr) {
    if (!dateStr) return null;
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) return null;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function groupKey(barangay, road) {
    return `${barangay}||${road || 'All Roads'}`;
}

function linearForecast(counts) {
    const n = counts.length;
    if (n === 0) return 0;
    if (n === 1) return counts[0];
    const xs = counts.map((_, i) => i);
    const xMean = xs.reduce((a, b) => a + b, 0) / n;
    const yMean = counts.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    xs.forEach((x, i) => { num += (x - xMean) * (counts[i] - yMean); den += (x - xMean) ** 2; });
    const slope = den === 0 ? 0 : num / den;
    const forecast = yMean + slope * (n - xMean);
    return { value: Math.max(0, Math.round(forecast)), slope };
}

function computePredictions(store) {
    const groups = new Map();
    const forest = trainSeverityForest(store.incidents);

    (store.predictionInputs || []).forEach(input => {
        if (!input.barangay || !input.month) return;
        const key = groupKey(input.barangay, input.road);
        if (!groups.has(key)) groups.set(key, { barangay: input.barangay, road: input.road || 'All Roads', history: new Map(), sources: new Set(), incidents: [] });
        const g = groups.get(key);
        g.history.set(input.month, (g.history.get(input.month) || 0) + Number(input.incidentCount || 0));
        g.sources.add('admin');
    });

    (store.incidents || []).forEach(incident => {
        if (!incident.barangay || !incident.road) return;
        const key = groupKey(incident.barangay, incident.road);
        if (!groups.has(key)) groups.set(key, { barangay: incident.barangay, road: incident.road, history: new Map(), sources: new Set(), incidents: [] });
        const g = groups.get(key);
        g.incidents.push(incident);
        const mk = monthKey(incident.date);
        if (mk) {
            g.history.set(mk, (g.history.get(mk) || 0) + 1);
            g.sources.add('logged');
        }
    });

    const results = [];
    groups.forEach((g, key) => {
        const months = [...g.history.keys()].sort();
        const counts = months.map(m => g.history.get(m));
        const forecast = linearForecast(counts);
        const predictedNextMonth = typeof forecast === 'number' ? forecast : forecast.value;
        const slope = typeof forecast === 'number' ? 0 : forecast.slope;
        const trend = slope > 0.15 ? 'up' : slope < -0.15 ? 'down' : 'stable';
        const recentWindow = counts.slice(-3);
        const recentAvg = recentWindow.length ? recentWindow.reduce((a, b) => a + b, 0) / recentWindow.length : 0;
        const frequencyScore = recentAvg * 0.55 + predictedNextMonth * 0.45;

        // The forest's severe-outcome probability nudges the frequency score up to +30% or
        // down to -30%; it modulates volume-based risk rather than replacing it, since a
        // busy-but-minor road shouldn't outrank a low-traffic road with a fatal history.
        const severeProbability = groupSeverityProbability(forest, g.incidents);
        const mlAdjustment = severeProbability === null ? 1 : 0.7 + 0.6 * severeProbability;
        const rawScore = frequencyScore * mlAdjustment;

        results.push({
            key,
            barangay: g.barangay,
            road: g.road,
            history: months.map((m, i) => ({ month: m, count: counts[i] })),
            totalIncidents: counts.reduce((a, b) => a + b, 0),
            predictedNextMonth,
            trend,
            rawScore,
            severeProbability: severeProbability === null ? null : Math.round(severeProbability * 100) / 100,
            mlModel: forest ? 'random-forest' : 'heuristic',
            sources: [...g.sources]
        });
    });

    const maxScore = Math.max(1, ...results.map(r => r.rawScore));
    results.forEach(r => {
        r.riskScore = Math.round((r.rawScore / maxScore) * 100) / 10;
        r.riskLevel = r.riskScore >= 7 ? 'high' : r.riskScore >= 4 ? 'medium' : 'low';
        delete r.rawScore;
    });

    results.sort((a, b) => b.riskScore - a.riskScore);
    return results;
}

function computeStats(store, predictions) {
    const incidents = store.incidents || [];
    const total = incidents.length;
    const resolved = incidents.filter(i => i.status === 'resolved').length;
    const active = total - resolved;
    const highRisk = predictions.filter(p => p.riskLevel === 'high').length;
    const mediumRisk = predictions.filter(p => p.riskLevel === 'medium').length;
    const lowRisk = predictions.filter(p => p.riskLevel === 'low').length;
    const avgRiskScore = predictions.length
        ? Math.round((predictions.reduce((a, p) => a + p.riskScore, 0) / predictions.length) * 10) / 10
        : 0;

    return {
        totalIncidents: total,
        activeIncidents: active,
        resolvedIncidents: resolved,
        highRiskLocations: highRisk,
        mediumRiskLocations: mediumRisk,
        lowRiskLocations: lowRisk,
        avgRiskScore,
        updatedAt: new Date().toISOString()
    };
}

module.exports = { computePredictions, computeStats, monthKey, trainSeverityForest, incidentFeatures };
