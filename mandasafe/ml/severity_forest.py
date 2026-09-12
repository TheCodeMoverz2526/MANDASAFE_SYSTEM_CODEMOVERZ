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
      "trainedOn": <labeled row count>,
      "classes": [...],
      "oobAccuracy": <out-of-bag accuracy, an honest held-out estimate, or null>,
      "results": [ {"key": "...", "severeProbability": <0..1 or null>}, ... ]
    }

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
from sklearn.preprocessing import OneHotEncoder

SEVERE_CLASSES = {'Fatal', 'Injury'}
MIN_ROWS = 8
MIN_CLASSES = 2


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


def incident_features(incident):
    d = parse_date(incident.get('date'))
    return {
        'barangay': incident.get('barangay') or 'Unknown',
        'road': incident.get('road') or 'Unknown',
        'type': incident.get('type') or 'Unknown',
        'hour': parse_hour(incident.get('time')),
        'dayOfWeek': (d.weekday() + 1) % 7 if d else -1,  # Sunday=0, matches JS Date#getDay()
        'month': (d.month - 1) if d else -1,              # 0-indexed, matches JS Date#getMonth()
    }


def cyclical(rows):
    """hour/dayOfWeek/month as sin/cos pairs plus a 'known' flag, so e.g. 23:00 and 00:00 land
    next to each other instead of at opposite ends of a raw integer scale."""
    out = np.zeros((len(rows), 7), dtype=float)
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
    return out


def category_matrix(feature_rows):
    return np.array([[r['barangay'], r['road'], r['type']] for r in feature_rows], dtype=object)


def encode(cat_encoder, feature_rows):
    cat = cat_encoder.transform(category_matrix(feature_rows))
    num = cyclical(feature_rows)
    return hstack([cat, csr_matrix(num)]).tocsr()


def main():
    payload = json.load(sys.stdin)
    incidents = payload.get('incidents') or []
    groups = payload.get('groups') or []

    labeled = [i for i in incidents if i.get('barangay') and i.get('road') and i.get('sev')]
    feature_rows = [incident_features(i) for i in labeled]
    labels = np.array([i['sev'] for i in labeled])
    classes = sorted(set(labels.tolist()))

    if len(labeled) < MIN_ROWS or len(classes) < MIN_CLASSES:
        print(json.dumps({
            'trained': False,
            'trainedOn': len(labeled),
            'classes': classes,
            'oobAccuracy': None,
            'results': [{'key': g['key'], 'severeProbability': None} for g in groups],
        }))
        return

    cat_encoder = OneHotEncoder(handle_unknown='ignore')
    cat_encoder.fit(category_matrix(feature_rows))
    X = encode(cat_encoder, feature_rows)

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
        proba = forest.predict_proba(encode(cat_encoder, all_rows))
        severe_by_row = proba[:, severe_idx].sum(axis=1)

    results = []
    for g, (start, end) in zip(groups, offsets):
        severe_probability = float(np.mean(severe_by_row[start:end])) if end > start else None
        results.append({'key': g['key'], 'severeProbability': severe_probability})

    print(json.dumps({
        'trained': True,
        'trainedOn': len(labeled),
        'classes': [str(c) for c in forest.classes_],
        'oobAccuracy': float(forest.oob_score_),
        'results': results,
    }))


if __name__ == '__main__':
    main()
