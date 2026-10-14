#!/usr/bin/env python3
"""Severity classifier for MandaSafe incidents (scikit-learn Random Forest).

Reads one JSON payload from stdin:

    {
      "incidents": [ {"barangay", "road", "type", "date", "time", "sev"}, ... ],
      "groups": [ {"key": "...", "incidents": [ {"barangay", "road", "type", "date", "time"}, ... ]}, ... ]
    }

`incidents` is the full labeled training set. `groups` are the barangay/road groups whose own
incidents get scored once the forest is trained (same incidents that fed training -- we are
asking "how severe does the model consider this location's history", not testing on unseen data).

Writes one JSON object to stdout:

    {
      "trained": bool,
      "reason": <why it did not train, or null>,
      "trainedOn": <labeled row count>,
      "classes": [...],
      "classCounts": {"<severity>": <rows>, ...},
      "oobAccuracy": <out-of-bag accuracy, an honest held-out estimate, or null>,
      "majorityBaseline": <accuracy of always guessing the most common severity>,
      "balancedAccuracy": <out-of-bag accuracy averaged over the classes (chance = 1/classes)>,
      "severeRocAuc": <out-of-bag ROC AUC of "serious (Fatal/Injury) vs not" (0.5 = no skill)>,
      "featureImportances": [ {"feature", "importance"}, ... ],
      "results": [ {"key": "...", "severeProbability": <0..1 or null>}, ... ]
    }

Besides barangay/road/type and the time of the accident, every incident carries the KDE density
of accidents at its own location (kde_features.py) -- the same density surface the hotspot map
draws -- so the forest can learn whether dense, busy spots differ in severity from quiet ones.

Needs at least MIN_ROWS labeled rows spanning MIN_CLASSES+ severity classes to train at all;
otherwise trained=false and every group gets a null severeProbability, so the caller can fall
back to a frequency-only heuristic exactly as before.
"""
import json
import sys
from datetime import datetime

import numpy as np
from scipy.sparse import csr_matrix, hstack
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import balanced_accuracy_score, roc_auc_score
from sklearn.preprocessing import OneHotEncoder

from kde_features import BinnedKde, project

SEVERE_CLASSES = {'Fatal', 'Injury'}
MIN_ROWS = 8
MIN_CLASSES = 2
KDE_BANDWIDTH_METERS = 125.0
NUMERIC_FEATURES = ['Hour of day (sin)', 'Hour of day (cos)', 'Day of week (sin)', 'Day of week (cos)',
                    'Month (sin)', 'Month (cos)', 'Date/time known', 'KDE density at the location',
                    'Location known']


def parse_hour(time_str):
    if not time_str:
        return -1
    try:
        return datetime.strptime(time_str[:8], '%H:%M:%S').hour
    except ValueError:
        return -1


def parse_date(date_str):
    if not date_str:
        return None
    try:
        return datetime.strptime(date_str[:10], '%Y-%m-%d')
    except ValueError:
        return None


def parse_point(incident):
    try:
        lat, lng = float(incident.get('lat')), float(incident.get('lng'))
    except (TypeError, ValueError):
        return None
    return (lat, lng) if np.isfinite(lat) and np.isfinite(lng) else None


def incident_features(incident):
    d = parse_date(incident.get('date'))
    return {
        'barangay': incident.get('barangay') or 'Unknown',
        'road': incident.get('road') or 'Unknown',
        'type': incident.get('type') or 'Unknown',
        'hour': parse_hour(incident.get('time')),
        'dayOfWeek': (d.weekday() + 1) % 7 if d else -1,  # Sunday=0, matches JS Date#getDay()
        'month': (d.month - 1) if d else -1,              # 0-indexed, matches JS Date#getMonth()
        'point': parse_point(incident),
        'monthIndex': d.year * 12 + d.month - 1 if d else None,
    }


class DensitySurface:
    """KDE density of every located training incident, sampled at any incident's location, in
    accidents per km^2 per month over the span of the records."""

    def __init__(self, training_rows):
        located = [r['point'] for r in training_rows if r['point'] is not None]
        month_ids = [r['monthIndex'] for r in training_rows if r['monthIndex'] is not None]
        self.months = (max(month_ids) - min(month_ids) + 1) if month_ids else 1
        if not located:
            self.points = np.zeros((0, 2))
            return
        lats = np.array([p[0] for p in located])
        lngs = np.array([p[1] for p in located])
        self.origin = (float(lats.mean()), float(lngs.mean()))
        xs, ys = project(lats, lngs, *self.origin)
        self.points = np.column_stack([xs, ys])
        self.kde = BinnedKde(xs.min(), ys.min(), xs.max(), ys.max())

    def at(self, rows):
        out = np.zeros(len(rows))
        idx = [i for i, r in enumerate(rows) if r['point'] is not None]
        if not idx or len(self.points) == 0:
            return out
        lats = np.array([rows[i]['point'][0] for i in idx])
        lngs = np.array([rows[i]['point'][1] for i in idx])
        xs, ys = project(lats, lngs, *self.origin)
        out[idx] = self.kde.rate(self.points, np.column_stack([xs, ys]), KDE_BANDWIDTH_METERS, self.months)
        return out


def numeric(rows, surface):
    """hour/dayOfWeek/month as sin/cos pairs plus a 'known' flag, so e.g. 23:00 and 00:00 land
    next to each other instead of at opposite ends of a raw integer scale -- then the KDE
    density at the location (log-scaled, it is heavily skewed) and a 'location known' flag."""
    out = np.zeros((len(rows), len(NUMERIC_FEATURES)), dtype=float)
    for i, r in enumerate(rows):
        hour, dow, month = r['hour'], r['dayOfWeek'], r['month']
        known = hour >= 0 and dow >= 0 and month >= 0
        out[i, 6] = 1.0 if known else 0.0
        if known:
            out[i, 0] = np.sin(2 * np.pi * hour / 24)
            out[i, 1] = np.cos(2 * np.pi * hour / 24)
            out[i, 2] = np.sin(2 * np.pi * dow / 7)
            out[i, 3] = np.cos(2 * np.pi * dow / 7)
            out[i, 4] = np.sin(2 * np.pi * month / 12)
            out[i, 5] = np.cos(2 * np.pi * month / 12)
        out[i, 8] = 1.0 if r['point'] is not None else 0.0
    out[:, 7] = np.log1p(surface.at(rows))
    return out


def category_matrix(feature_rows):
    return np.array([[r['barangay'], r['road'], r['type']] for r in feature_rows], dtype=object)


def encode(cat_encoder, feature_rows, surface):
    cat = cat_encoder.transform(category_matrix(feature_rows))
    return hstack([cat, csr_matrix(numeric(feature_rows, surface))]).tocsr()


def feature_importances(forest, cat_encoder):
    """Importance per original feature: one-hot columns are summed back into barangay, road
    and type, so the list reads in the terms the records use."""
    values = forest.feature_importances_
    sizes = [len(c) for c in cat_encoder.categories_]
    out, start = [], 0
    for name, size in zip(['Barangay', 'Road', 'Accident type'], sizes):
        out.append({'feature': name, 'importance': float(values[start:start + size].sum())})
        start += size
    for name, value in zip(NUMERIC_FEATURES, values[start:]):
        out.append({'feature': name, 'importance': float(value)})
    return sorted(({**f, 'importance': round(f['importance'], 4)} for f in out), key=lambda f: -f['importance'])


def main():
    payload = json.load(sys.stdin)
    incidents = payload.get('incidents') or []
    groups = payload.get('groups') or []

    labeled = [i for i in incidents if i.get('barangay') and i.get('road') and i.get('sev')]
    feature_rows = [incident_features(i) for i in labeled]
    labels = np.array([i['sev'] for i in labeled])
    classes = sorted(set(labels.tolist()))
    class_counts = {c: int((labels == c).sum()) for c in classes}

    if len(labeled) < MIN_ROWS or len(classes) < MIN_CLASSES:
        reason = (f'Needs at least {MIN_ROWS} records with a severity; there are {len(labeled)}.'
                  if len(labeled) < MIN_ROWS else
                  f'Every record has the same severity ({classes[0]}) -- the model needs at least '
                  f'{MIN_CLASSES} different severities to learn what separates them.' if classes else
                  'No records have a severity yet.')
        print(json.dumps({
            'trained': False,
            'reason': reason,
            'trainedOn': len(labeled),
            'classes': classes,
            'classCounts': class_counts,
            'oobAccuracy': None,
            'featureImportances': [],
            'results': [{'key': g['key'], 'severeProbability': None} for g in groups],
        }))
        return

    surface = DensitySurface(feature_rows)
    cat_encoder = OneHotEncoder(handle_unknown='ignore')
    cat_encoder.fit(category_matrix(feature_rows))
    X = encode(cat_encoder, feature_rows, surface)

    forest = RandomForestClassifier(
        n_estimators=400,
        min_samples_leaf=2,
        class_weight='balanced',
        oob_score=True,
        bootstrap=True,
        n_jobs=-1,
        random_state=42,
    )
    forest.fit(X, labels)

    severe_idx = [i for i, c in enumerate(forest.classes_) if c in SEVERE_CLASSES]

    # Plain accuracy flatters nothing here: the classes are weighted to be balanced, and always
    # guessing the commonest severity already scores high. These are the honest measures.
    majority = max(class_counts.values()) / len(labels)
    balanced, severe_auc = None, None
    oob = getattr(forest, 'oob_decision_function_', None)
    if oob is not None:
        ok = ~np.isnan(oob).any(axis=1)
        if ok.any():
            predicted = forest.classes_[oob[ok].argmax(axis=1)]
            balanced = float(balanced_accuracy_score(labels[ok], predicted))
            is_severe = np.isin(labels[ok], list(SEVERE_CLASSES))
            if severe_idx and 0 < is_severe.sum() < len(is_severe):
                severe_auc = float(roc_auc_score(is_severe, oob[ok][:, severe_idx].sum(axis=1)))

    # One prediction call over every group's incidents stacked together, instead of one call
    # per group: predict_proba's fixed dispatch overhead (it parallelizes across the forest's
    # trees internally) dominates at this data size when repeated per group, which turned
    # ~1,650 groups into minutes of wall time -- batching cut that to under a second.
    all_rows, offsets, cursor = [], [], 0
    for g in groups:
        rows = [incident_features(i) for i in (g.get('incidents') or [])]
        all_rows.extend(rows)
        offsets.append((cursor, cursor + len(rows)))
        cursor += len(rows)

    severe_by_row = np.zeros(len(all_rows))
    if all_rows and severe_idx:
        proba = forest.predict_proba(encode(cat_encoder, all_rows, surface))
        severe_by_row = proba[:, severe_idx].sum(axis=1)

    results = []
    for g, (start, end) in zip(groups, offsets):
        severe_probability = float(np.mean(severe_by_row[start:end])) if end > start else None
        results.append({'key': g['key'], 'severeProbability': severe_probability})

    print(json.dumps({
        'trained': True,
        'reason': None,
        'trainedOn': len(labeled),
        'classes': [str(c) for c in forest.classes_],
        'classCounts': class_counts,
        'oobAccuracy': float(forest.oob_score_),
        'majorityBaseline': round(float(majority), 4),
        'balancedAccuracy': None if balanced is None else round(balanced, 4),
        'severeRocAuc': None if severe_auc is None else round(severe_auc, 4),
        'featureImportances': feature_importances(forest, cat_encoder),
        'results': results,
    }))


if __name__ == '__main__':
    main()
