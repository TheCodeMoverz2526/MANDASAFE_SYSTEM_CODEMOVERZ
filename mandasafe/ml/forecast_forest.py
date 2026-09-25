#!/usr/bin/env python3
"""Next-month accident forecast for MandaSafe (scikit-learn Random Forest regressor).

Reads one JSON payload from stdin:

    {
      "groups": [ {"key": "...", "history": [ {"month": "YYYY-MM", "count": n}, ... ]}, ... ]
    }

Every group (a barangay, or a barangay + road) is turned into a continuous monthly series --
months with no record count as 0 -- running up to the latest month seen in ANY group, so all
groups are forecast for the same next month. One forest is trained on all groups together:
each training row is "this group, this month", described by its recent past, and the target is
that month's count. A single shared model learns far more than one tiny model per barangay.

Features for month t:  counts at t-1, t-2, t-3; mean of the last 3, 6 and 12 months; the
group's average over all earlier months; and the calendar month as a sin/cos pair (seasonality).

Writes one JSON object to stdout:

    {
      "trained": bool,
      "trainedOn": <training rows>,
      "forecastMonth": "YYYY-MM",
      "oobR2": <out-of-bag R^2, or null>,
      "backtest": {"month": "YYYY-MM", "maeForest": x, "maeLinear": y} or null,
      "results": [ {"key": "...", "predicted": <float or null>}, ... ]
    }

The backtest refits the forest without the last real month, predicts that month, and compares
the mean absolute error against the straight-line trend the system used before -- an honest
"is this actually better" check on data the model did not see.

With too little history (fewer than MIN_ROWS training rows) trained=false and every group gets
predicted=null, so the caller keeps its straight-line forecast.
"""
import json
import sys

import numpy as np
from sklearn.ensemble import RandomForestRegressor

LAGS = 3
MIN_ROWS = 24


def month_index(ym):
    year, month = ym.split('-')[:2]
    return int(year) * 12 + int(month) - 1


def month_label(index):
    return f'{index // 12:04d}-{index % 12 + 1:02d}'


def features(series, t):
    """Row describing month t of one group's series using only months before t."""
    past = series[:t]

    def mean_last(n):
        window = past[-n:]
        return float(np.mean(window)) if len(window) else 0.0

    return [
        past[-1] if len(past) >= 1 else 0.0,
        past[-2] if len(past) >= 2 else 0.0,
        past[-3] if len(past) >= 3 else 0.0,
        mean_last(3),
        mean_last(6),
        mean_last(12),
        float(np.mean(past)) if len(past) else 0.0,  # long-run level, past only
    ]


def seasonal(index):
    month = index % 12
    return [np.sin(2 * np.pi * month / 12), np.cos(2 * np.pi * month / 12)]


def build_series(groups):
    """{key: (start_index, [counts...])}, all ending at the same latest month."""
    parsed, last = {}, None
    for g in groups:
        counts = {}
        for h in g.get('history') or []:
            try:
                counts[month_index(h['month'])] = counts.get(month_index(h['month']), 0) + float(h['count'])
            except (KeyError, ValueError, TypeError):
                continue
        if counts:
            parsed[g['key']] = counts
            last = max(last, max(counts)) if last is not None else max(counts)

    series = {}
    for key, counts in parsed.items():
        start = min(counts)
        series[key] = (start, [counts.get(i, 0.0) for i in range(start, last + 1)])
    return series, last


def training_rows(series, upto=None):
    """Rows for every month that has LAGS months of history before it (and, when `upto` is
    given, only months before that absolute month index)."""
    X, y = [], []
    for start, values in series.values():
        for t in range(LAGS, len(values)):
            if upto is not None and start + t >= upto:
                break
            X.append(features(values, t) + seasonal(start + t))
            y.append(values[t])
    return np.array(X, dtype=float), np.array(y, dtype=float)


def linear_next(values):
    """The straight-line forecast the system used before, for the backtest comparison."""
    n = len(values)
    if n == 0:
        return 0.0
    if n == 1:
        return float(values[0])
    x = np.arange(n)
    slope, intercept = np.polyfit(x, values, 1)
    return max(0.0, float(intercept + slope * n))


def make_forest():
    return RandomForestRegressor(
        n_estimators=300,
        min_samples_leaf=2,
        max_features=0.6,
        oob_score=True,
        bootstrap=True,
        n_jobs=-1,
        random_state=42,
    )


def backtest(series, last):
    X, y = training_rows(series, upto=last)
    if len(y) < MIN_ROWS:
        return None
    forest = make_forest().fit(X, y)
    errors_forest, errors_linear = [], []
    for start, values in series.values():
        t = last - start
        if t < LAGS:
            continue
        history = values[:t]
        row = features(values, t) + seasonal(last)
        errors_forest.append(abs(forest.predict(np.array([row]))[0] - values[t]))
        errors_linear.append(abs(linear_next(history) - values[t]))
    if not errors_forest:
        return None
    return {
        'month': month_label(last),
        'maeForest': round(float(np.mean(errors_forest)), 2),
        'maeLinear': round(float(np.mean(errors_linear)), 2),
    }


def main():
    payload = json.load(sys.stdin)
    groups = payload.get('groups') or []
    series, last = build_series(groups)

    X, y = training_rows(series)
    if last is None or len(y) < MIN_ROWS:
        print(json.dumps({
            'trained': False,
            'trainedOn': int(len(y)),
            'forecastMonth': month_label(last + 1) if last is not None else None,
            'oobR2': None,
            'backtest': None,
            'results': [{'key': g['key'], 'predicted': None} for g in groups],
        }))
        return

    forest = make_forest().fit(X, y)

    next_index = last + 1
    results = []
    for g in groups:
        entry = series.get(g['key'])
        if entry is None:
            results.append({'key': g['key'], 'predicted': None})
            continue
        start, values = entry
        row = features(values, len(values)) + seasonal(next_index)
        results.append({'key': g['key'], 'predicted': max(0.0, float(forest.predict(np.array([row]))[0]))})

    print(json.dumps({
        'trained': True,
        'trainedOn': int(len(y)),
        'forecastMonth': month_label(next_index),
        'oobR2': float(forest.oob_score_),
        'backtest': backtest(series, last),
        'results': results,
    }))


if __name__ == '__main__':
    main()
