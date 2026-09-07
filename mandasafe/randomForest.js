// A small dependency-free Random Forest classifier (bagged CART trees with per-node
// random feature subsets), used to classify incident severity from contextual features
// (barangay, road, type, hour, day-of-week, month). No external ML package is installed
// in this project, so this implements the standard algorithm directly.

function gini(rows, labelKey, classes) {
    const n = rows.length;
    if (!n) return 0;
    let impurity = 1;
    for (const c of classes) {
        const count = rows.reduce((a, r) => a + (r[labelKey] === c ? 1 : 0), 0);
        const p = count / n;
        impurity -= p * p;
    }
    return impurity;
}

function splitRows(rows, feature, value) {
    if (feature.type === 'numeric') {
        return {
            left: rows.filter(r => Number(r[feature.key]) <= value),
            right: rows.filter(r => Number(r[feature.key]) > value)
        };
    }
    return {
        left: rows.filter(r => r[feature.key] === value),
        right: rows.filter(r => r[feature.key] !== value)
    };
}

function sampleFeatures(features, count) {
    const pool = [...features];
    const picked = [];
    while (picked.length < count && pool.length) {
        picked.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    }
    return picked;
}

function findBestSplit(rows, features, labelKey, classes, featureSampleSize) {
    const candidateFeatures = sampleFeatures(features, featureSampleSize);
    const parentImpurity = gini(rows, labelKey, classes);
    let best = null;

    candidateFeatures.forEach(feature => {
        const values = [...new Set(rows.map(r => r[feature.key]))];
        values.forEach(value => {
            const { left, right } = splitRows(rows, feature, value);
            if (!left.length || !right.length) return;
            const weighted = (left.length / rows.length) * gini(left, labelKey, classes)
                + (right.length / rows.length) * gini(right, labelKey, classes);
            const gain = parentImpurity - weighted;
            if (!best || gain > best.gain) best = { feature, value, gain, left, right };
        });
    });

    return best && best.gain > 1e-9 ? best : null;
}

function leafDistribution(rows, labelKey, classes) {
    const n = rows.length || 1;
    const distribution = {};
    classes.forEach(c => { distribution[c] = 0; });
    rows.forEach(r => { distribution[r[labelKey]] = (distribution[r[labelKey]] || 0) + 1; });
    classes.forEach(c => { distribution[c] = distribution[c] / n; });
    return { leaf: true, distribution, n: rows.length };
}

function buildTree(rows, features, labelKey, classes, depth, maxDepth, minSamplesSplit, featureSampleSize) {
    const isPure = rows.every(r => r[labelKey] === rows[0][labelKey]);
    if (depth >= maxDepth || rows.length < minSamplesSplit || isPure) {
        return leafDistribution(rows, labelKey, classes);
    }
    const split = findBestSplit(rows, features, labelKey, classes, featureSampleSize);
    if (!split) return leafDistribution(rows, labelKey, classes);
    return {
        leaf: false,
        feature: split.feature,
        value: split.value,
        left: buildTree(split.left, features, labelKey, classes, depth + 1, maxDepth, minSamplesSplit, featureSampleSize),
        right: buildTree(split.right, features, labelKey, classes, depth + 1, maxDepth, minSamplesSplit, featureSampleSize)
    };
}

function predictTree(node, sample) {
    if (node.leaf) return node.distribution;
    const goLeft = node.feature.type === 'numeric'
        ? Number(sample[node.feature.key]) <= node.value
        : sample[node.feature.key] === node.value;
    return predictTree(goLeft ? node.left : node.right, sample);
}

function bootstrapSample(rows) {
    const sample = [];
    for (let i = 0; i < rows.length; i++) sample.push(rows[Math.floor(Math.random() * rows.length)]);
    return sample;
}

// rows: array of feature+label objects. features: [{key, type:'numeric'|'categorical'}].
// Returns null when there isn't enough labeled, class-diverse data to train meaningfully —
// callers should fall back to a heuristic in that case rather than trust a degenerate model.
function trainRandomForest(rows, { features, labelKey, nTrees = 41, maxDepth = 6, minSamplesSplit = 4 }) {
    const classes = [...new Set(rows.map(r => r[labelKey]))];
    if (rows.length < 8 || classes.length < 2) return null;

    const featureSampleSize = Math.max(1, Math.round(Math.sqrt(features.length)));
    const trees = [];
    for (let t = 0; t < nTrees; t++) {
        const sample = bootstrapSample(rows);
        trees.push(buildTree(sample, features, labelKey, classes, 0, maxDepth, minSamplesSplit, featureSampleSize));
    }
    return { trees, features, labelKey, classes, trainedOn: rows.length };
}

function predictProbabilities(forest, sample) {
    if (!forest) return null;
    const totals = {};
    forest.classes.forEach(c => { totals[c] = 0; });
    forest.trees.forEach(tree => {
        const dist = predictTree(tree, sample);
        forest.classes.forEach(c => { totals[c] += dist[c] || 0; });
    });
    const n = forest.trees.length;
    const probabilities = {};
    forest.classes.forEach(c => { probabilities[c] = totals[c] / n; });
    return probabilities;
}

function predictClass(forest, sample) {
    const probabilities = predictProbabilities(forest, sample);
    if (!probabilities) return null;
    const [label, confidence] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0];
    return { label, confidence, probabilities };
}

module.exports = { trainRandomForest, predictClass, predictProbabilities };
