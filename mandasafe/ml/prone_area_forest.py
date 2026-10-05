#!/usr/bin/env python3
"""Accident-prone area classifier for MandaSafe: KDE density features -> Random Forest.

Mandaluyong is divided into square cells (250 m by default). For every cell and every month
boundary, the model looks back over the previous HISTORY months and describes the cell with
Kernel Density Estimation outputs -- how dense accidents are at the cell (the KDE surface the
hotspot map draws), how dense they were recently, and how dense the wider neighbourhood is --
plus the cell's own counts. The label is what happened NEXT: whether the cell turned out to be
accident-prone over the following HORIZON months.

Validation is temporal, never random: the model is trained only on periods that ended before the
test period started, then scored on that most recent test period it has never seen, alongside a
simple "same as last period" baseline so the gain from the model is visible. The KDE bandwidth is
chosen the same way, on a validation period that ends before the test period begins. The final
model is then retrained on every labelled period and predicts the coming HORIZON months.

Reads one JSON payload from stdin:

    {
      "incidents": [ {"lat", "lng", "date", "sev", "barangay"}, ... ],
      "boundaries": { "<barangay>": [ [[lng, lat], ...], ... ] },
      "options": { "cellMeters": 250, "historyMonths": 12, "horizonMonths": 3, "proneShare": 0.2 }
    }

Writes one JSON object to stdout: { "trained", "reason", "model": {...}, "cells": [...],
"barangays": [...] } -- see build_output() for the fields.
"""
import json
import sys

import numpy as np
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score, f1_score, precision_score, recall_score, roc_auc_score

from kde_features import BinnedKde, locate_barangays, project, unproject

SEVERE = {'Fatal', 'Injury'}
SEVERITY_WEIGHTS = {'Fatal': 4, 'Injury': 3, 'Minor': 2, 'Damage': 1}
BANDWIDTH_CANDIDATES = [75.0, 125.0, 200.0, 300.0, 450.0]
NEIGHBOURHOOD_FACTOR = 3  # the wide-area KDE uses this many times the chosen bandwidth
HIGH_PROBABILITY = 0.6
MODERATE_PROBABILITY = 0.3

FEATURES = [
    ('kdeDensity', 'KDE density at the cell (past 12 months)'),
    ('kdeRecent', 'KDE density at the cell (past 3 months)'),
    ('kdeTrend', 'Change in KDE density (recent vs. 12 months)'),
    ('kdeNeighbourhood', 'KDE density of the surrounding area'),
    ('kdeSevere', 'Severity-weighted KDE density'),
    ('countHistory', 'Accidents in the cell (past 12 months)'),
    ('countRecent', 'Accidents in the cell (past 3 months)'),
    ('activeMonths', 'Share of months with an accident'),
    ('severeShare', 'Share of fatal/injury accidents'),
]


def month_index(date_str):
    try:
        year, month = int(date_str[:4]), int(date_str[5:7])
    except (TypeError, ValueError):
        return None
    return year * 12 + (month - 1) if 1 <= month <= 12 else None


def month_label(index):
    return f'{index // 12:04d}-{index % 12 + 1:02d}'


def untrained(reason, **extra):
    return {'trained': False, 'reason': reason, 'model': extra or None, 'cells': [], 'barangays': []}


def main():
    payload = json.load(sys.stdin)
    options = payload.get('options') or {}
    cell_m = float(options.get('cellMeters', 250))
    history = int(options.get('historyMonths', 12))
    horizon = int(options.get('horizonMonths', 3))
    recent = min(3, history)
    prone_share = float(options.get('proneShare', 0.2))
    boundaries = payload.get('boundaries') or {}

    # ---- Accidents with a real location inside the city --------------------------------
    rows = []
    for incident in payload.get('incidents') or []:
        try:
            lat, lng = float(incident.get('lat')), float(incident.get('lng'))
        except (TypeError, ValueError):
            continue
        m = month_index(str(incident.get('date') or ''))
        if m is None or not np.isfinite(lat) or not np.isfinite(lng):
            continue
        rows.append((lat, lng, m, incident.get('sev') or ''))
    if not rows or not boundaries:
        print(json.dumps(untrained('No accidents with a recorded location to learn from.')))
        return

    lats = np.array([r[0] for r in rows])
    lngs = np.array([r[1] for r in rows])
    months = np.array([r[2] for r in rows])
    sevs = np.array([r[3] for r in rows], dtype=object)
    in_city = locate_barangays(lngs, lats, boundaries) != None  # noqa: E711
    lats, lngs, months, sevs = lats[in_city], lngs[in_city], months[in_city], sevs[in_city]
    severe = np.isin(sevs, list(SEVERE))
    sev_weight = np.array([SEVERITY_WEIGHTS.get(s, 1) for s in sevs], dtype=float)

    first, last = int(months.min()), int(months.max())
    if last - first + 1 < history + 2 * horizon:
        print(json.dumps(untrained(
            f'Needs at least {history + 2 * horizon} months of records; there are {last - first + 1}.')))
        return

    # ---- Grid over the city, in meters -------------------------------------------------
    all_lats = [p[1] for rings in boundaries.values() for ring in rings for p in ring]
    all_lngs = [p[0] for rings in boundaries.values() for ring in rings for p in ring]
    origin_lat = (min(all_lats) + max(all_lats)) / 2
    origin_lng = (min(all_lngs) + max(all_lngs)) / 2
    bx, by = project(np.array(all_lats), np.array(all_lngs), origin_lat, origin_lng)
    min_x, min_y = bx.min(), by.min()
    cols = int(np.ceil((bx.max() - min_x) / cell_m))
    nrows = int(np.ceil((by.max() - min_y) / cell_m))

    px, py = project(lats, lngs, origin_lat, origin_lng)
    points = np.column_stack([px, py])
    point_cell = (np.clip(((py - min_y) // cell_m).astype(int), 0, nrows - 1) * cols
                  + np.clip(((px - min_x) // cell_m).astype(int), 0, cols - 1))

    cx = min_x + (np.arange(nrows * cols) % cols + 0.5) * cell_m
    cy = min_y + (np.arange(nrows * cols) // cols + 0.5) * cell_m
    c_lat, c_lng = unproject(cx, cy, origin_lat, origin_lng)
    centre_brgy = locate_barangays(c_lng, c_lat, boundaries)
    # A cell belongs to the study area when its centre is in the city or an accident in the
    # city falls inside it (edge cells whose centre sits just outside the border).
    keep = (centre_brgy != None) | np.isin(np.arange(nrows * cols), point_cell)  # noqa: E711
    cell_ids = np.flatnonzero(keep)
    cell_pos = {cid: i for i, cid in enumerate(cell_ids)}
    n_cells = len(cell_ids)
    centres = np.column_stack([cx[cell_ids], cy[cell_ids]])
    point_slot = np.array([cell_pos[c] for c in point_cell])

    # Edge cells take the barangay most of their accidents are in.
    cell_brgy = centre_brgy[cell_ids].copy()
    point_brgy = locate_barangays(lngs, lats, boundaries)
    for i in np.flatnonzero(cell_brgy == None):  # noqa: E711
        names, counts = np.unique(point_brgy[point_slot == i].astype(str), return_counts=True)
        cell_brgy[i] = names[np.argmax(counts)] if len(names) else 'Unknown'

    kde = BinnedKde(min_x, min_y, min_x + cols * cell_m, min_y + nrows * cell_m)

    def features_at(cut, bandwidth):
        """Every cell's features from the HISTORY months before month `cut`."""
        win = (months >= cut - history) & (months < cut)
        rec = (months >= cut - recent) & (months < cut)
        counts_h = np.bincount(point_slot[win], minlength=n_cells)
        counts_r = np.bincount(point_slot[rec], minlength=n_cells)
        severe_h = np.bincount(point_slot[win & severe], minlength=n_cells)
        active = np.zeros(n_cells)
        for m in range(cut - history, cut):
            active += np.bincount(point_slot[months == m], minlength=n_cells) > 0
        density = kde.rate(points[win], centres, bandwidth, history)
        density_recent = kde.rate(points[rec], centres, bandwidth, recent)
        return np.column_stack([
            density,
            density_recent,
            density_recent - density,
            kde.rate(points[win], centres, bandwidth * NEIGHBOURHOOD_FACTOR, history),
            kde.rate(points[win], centres, bandwidth, history, sev_weight[win]),
            counts_h / history,
            counts_r / recent,
            active / history,
            np.divide(severe_h, counts_h, out=np.zeros(n_cells), where=counts_h > 0),
        ])

    def target_counts(cut):
        win = (months >= cut) & (months < cut + horizon)
        return np.bincount(point_slot[win], minlength=n_cells)

    def prone_threshold(counts):
        # Accident-prone = among the busiest `proneShare` of cells over the period, and at
        # least one accident a month on average.
        return max(float(horizon), float(np.quantile(counts, 1 - prone_share)))

    # ---- Snapshots: one per month boundary with a full history and a full horizon -------
    cuts = list(range(first + history, last - horizon + 2))
    labels = {cut: target_counts(cut) for cut in cuts}
    y = np.concatenate([labels[cut] >= prone_threshold(labels[cut]) for cut in cuts]).astype(int)
    cut_of_row = np.concatenate([np.full(n_cells, cut) for cut in cuts])

    def snapshot_features(bandwidth):
        return np.vstack([features_at(cut, bandwidth) for cut in cuts])

    def forest():
        return RandomForestClassifier(n_estimators=200, min_samples_leaf=3, class_weight='balanced',
                                      n_jobs=-1, random_state=42)

    def fit_and_score(X, eval_cut):
        """Train on every snapshot whose horizon ended before `eval_cut`, score `eval_cut`."""
        train = cut_of_row + horizon <= eval_cut
        evaluate = cut_of_row == eval_cut
        if len(np.unique(y[train])) < 2 or len(np.unique(y[evaluate])) < 2:
            return None
        model = forest().fit(X[train], y[train])
        return model, train, evaluate, model.predict_proba(X[evaluate])[:, 1]

    # ---- Bandwidth: tuned on a validation period that ends before the test period starts,
    # by how well each candidate predicts accident-prone cells -- the test period never
    # influences the choice.
    test_cut = last - horizon + 1
    validation_cut = test_cut - horizon
    candidates = {}
    for bandwidth in BANDWIDTH_CANDIDATES:
        X_candidate = snapshot_features(bandwidth)
        scored = fit_and_score(X_candidate, validation_cut)
        if scored is not None:
            candidates[bandwidth] = (roc_auc_score(y[scored[2]], scored[3]), X_candidate)
    if not candidates:
        print(json.dumps(untrained('Not enough variation between busy and quiet cells to train on yet.')))
        return
    bandwidth = max(candidates, key=lambda b: candidates[b][0])
    X = candidates[bandwidth][1]

    scored = fit_and_score(X, test_cut)
    if scored is None:
        print(json.dumps(untrained('The most recent period has no accident-prone cells to test against.')))
        return
    _, train_rows, test_rows, proba_test = scored
    pred_test = (proba_test >= 0.5).astype(int)
    y_test = y[test_rows]

    # Baseline: "a cell is prone next period if it was prone over the matching past window".
    past_counts = np.bincount(point_slot[(months >= test_cut - horizon) & (months < test_cut)], minlength=n_cells)
    baseline_pred = (past_counts >= prone_threshold(past_counts)).astype(int)

    def scores(truth, pred, proba=None):
        out = {
            'accuracy': round(float(accuracy_score(truth, pred)), 3),
            'precision': round(float(precision_score(truth, pred, zero_division=0)), 3),
            'recall': round(float(recall_score(truth, pred, zero_division=0)), 3),
            'f1': round(float(f1_score(truth, pred, zero_division=0)), 3),
        }
        if proba is not None and len(np.unique(truth)) == 2:
            out['rocAuc'] = round(float(roc_auc_score(truth, proba)), 3)
        return out

    # ---- Final model on every labelled snapshot, predicting the coming horizon ----------
    final = forest().fit(X, y)
    predict_cut = last + 1
    X_now = features_at(predict_cut, bandwidth)
    proba_now = final.predict_proba(X_now)[:, 1]

    print(json.dumps(build_output(
        proba_now, X_now, centres, cell_brgy, cell_m, origin_lat, origin_lng, final,
        model_info={
            'algorithm': 'Random Forest classifier (scikit-learn), KDE density features',
            'cellMeters': cell_m,
            'bandwidthMeters': round(float(bandwidth), 1),
            'neighbourhoodBandwidthMeters': round(float(bandwidth * NEIGHBOURHOOD_FACTOR), 1),
            'bandwidthSelection': {
                'validationPeriod': {'from': month_label(validation_cut), 'to': month_label(validation_cut + horizon - 1)},
                'candidates': [{'bandwidthMeters': b, 'rocAuc': round(float(candidates[b][0]), 3)} for b in sorted(candidates)],
            },
            'historyMonths': history,
            'horizonMonths': horizon,
            'labelRule': (f'A cell is accident-prone when, over the next {horizon} months, it is among the busiest '
                          f'{round(prone_share * 100)}% of cells and averages at least one accident a month.'),
            'accidentsUsed': int(len(points)),
            'cells': int(n_cells),
            'trainingRows': int(train_rows.sum()),
            'trainingPeriods': int(len(set(cut_of_row[train_rows].tolist()))),
            'testPeriod': {'from': month_label(test_cut), 'to': month_label(test_cut + horizon - 1)},
            'testPositives': int(y_test.sum()),
            'metrics': scores(y_test, pred_test, proba_test),
            # The baseline's ranking score is the past window's own count.
            'baseline': scores(y_test, baseline_pred, past_counts),
            'predictionPeriod': {'from': month_label(predict_cut), 'to': month_label(predict_cut + horizon - 1)},
            'thresholds': {'high': HIGH_PROBABILITY, 'moderate': MODERATE_PROBABILITY},
        })))


def level_for(p):
    return 'high' if p >= HIGH_PROBABILITY else 'moderate' if p >= MODERATE_PROBABILITY else 'low'


def build_output(proba, X_now, centres, cell_brgy, cell_m, origin_lat, origin_lng, model, model_info):
    half = cell_m / 2
    south, west = unproject(centres[:, 0] - half, centres[:, 1] - half, origin_lat, origin_lng)
    north, east = unproject(centres[:, 0] + half, centres[:, 1] + half, origin_lat, origin_lng)
    mid_lat, mid_lng = unproject(centres[:, 0], centres[:, 1], origin_lat, origin_lng)
    column = {key: i for i, (key, _) in enumerate(FEATURES)}

    cells = []
    for i in range(len(centres)):
        p = float(proba[i])
        cells.append({
            'lat': round(float(mid_lat[i]), 6), 'lng': round(float(mid_lng[i]), 6),
            'bounds': [[round(float(south[i]), 6), round(float(west[i]), 6)],
                       [round(float(north[i]), 6), round(float(east[i]), 6)]],
            'barangay': str(cell_brgy[i]),
            'probability': round(p, 3),
            'level': level_for(p),
            'kdeDensity': round(float(X_now[i, column['kdeDensity']]), 2),
            'recentPerMonth': round(float(X_now[i, column['countRecent']]), 2),
        })

    by_brgy = {}
    for cell in cells:
        b = by_brgy.setdefault(cell['barangay'], {'barangay': cell['barangay'], 'cells': 0, 'high': 0,
                                                  'moderate': 0, 'low': 0, 'maxProbability': 0.0,
                                                  'sumProbability': 0.0})
        b['cells'] += 1
        b[cell['level']] += 1
        b['maxProbability'] = max(b['maxProbability'], cell['probability'])
        b['sumProbability'] += cell['probability']
    barangays = []
    for b in by_brgy.values():
        b['meanProbability'] = round(b.pop('sumProbability') / b['cells'], 3)
        b['level'] = level_for(b['maxProbability'])
        barangays.append(b)
    barangays.sort(key=lambda b: (-b['high'], -b['maxProbability'], -b['meanProbability']))

    importances = sorted(
        ({'feature': key, 'label': label, 'importance': round(float(v), 4)}
         for (key, label), v in zip(FEATURES, model.feature_importances_)),
        key=lambda f: -f['importance'])
    model_info['featureImportances'] = importances
    model_info['kdeImportanceShare'] = round(sum(f['importance'] for f in importances if f['feature'].startswith('kde')), 3)
    model_info['predictedCells'] = {lvl: sum(1 for c in cells if c['level'] == lvl) for lvl in ('high', 'moderate', 'low')}

    return {'trained': True, 'reason': None, 'model': model_info, 'cells': cells, 'barangays': barangays}


if __name__ == '__main__':
    main()
