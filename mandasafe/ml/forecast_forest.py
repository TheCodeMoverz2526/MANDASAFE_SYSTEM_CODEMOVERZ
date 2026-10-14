#!/usr/bin/env python3
"""Monthly accident forecast for MandaSafe (scikit-learn Random Forest regressor).

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
      "backtest": {"from": "YYYY-MM", "month": "YYYY-MM", "months": n, "maeForest": x,
                   "maeAverage3": a, "maeLastMonth": l, "maeLinear": y} or null,
      "horizonMonths": ["YYYY-MM", ...],          # the HORIZON months after the last real one
      "horizonBacktest": {"from": "YYYY-MM", "mae": [x1, x2, ...]} or null,
      "results": [ {"key": "...", "predicted": <float or null>, "path": [<float>, ...] or null}, ... ]
    }

`path` is the forecast for each of the next HORIZON months, made recursively: the forecast
for month +1 is fed back in as if it were real to forecast month +2, and so on. `predicted` is
path[0]. Errors compound with each step, so the horizon backtest refits the forest without the
last HOLDOUT real months, forecasts them the same recursive way, and reports the mean absolute
error per area at each step ahead.

Each forecast is the average of the forest's prediction and the plain 3-month average. Over
the last six months that blend was off by less than either one alone (the forest by itself only
tied the 3-month average), so the forest earns its place as a correction to the simple level.

The backtest checks that on data the model did not see: for each of the last BACKTEST_MONTHS
real months it refits without that month and everything after, forecasts it, and reports the
mean absolute error per area, next to the 3-month average, last month's count and the
straight-line trend the system used before.

With too little history (fewer than MIN_ROWS training rows) trained=false and every group gets
predicted=null, so the caller keeps its straight-line forecast.
"""
import json
import sys

import numpy as np
from sklearn.ensemble import RandomForestRegressor

LAGS = 3
MIN_ROWS = 24
HORIZON = 24
HOLDOUT = 6
BACKTEST_MONTHS = 6


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
    """Mean absolute error per area over the last BACKTEST_MONTHS months, each forecast by a
    forest that never saw that month or anything after it."""
    errors = {'model': [], 'avg3': [], 'last': [], 'linear': []}
    first = None
    for target in range(last - BACKTEST_MONTHS + 1, last + 1):
        X, y = training_rows(series, upto=target)
        if len(y) < MIN_ROWS:
            continue
        forest = make_forest().fit(X, y)
        for start, values in series.values():
            t = target - start
            if t < LAGS:
                continue
            actual = values[t]
            predicted = blend(forest.predict(np.array([features(values, t) + seasonal(target)]))[0], values, t)
            errors['model'].append(abs(predicted - actual))
            errors['avg3'].append(abs(mean_last3(values, t) - actual))
            errors['last'].append(abs(values[t - 1] - actual))
            errors['linear'].append(abs(linear_next(values[:t]) - actual))
        if first is None:
            first = target
    if not errors['model']:
        return None
    mae = lambda key: round(float(np.mean(errors[key])), 2)
    return {
        'from': month_label(first),
        'month': month_label(last),
        'months': last - first + 1,
        'maeForest': mae('model'),
        'maeAverage3': mae('avg3'),
        'maeLastMonth': mae('last'),
        'maeLinear': mae('linear'),
    }


def mean_last3(values, t):
    """The plain 3-month average before month t (fewer months if that is all there is)."""
    window = values[max(0, t - 3):t]
    return float(np.mean(window)) if len(window) else 0.0


def blend(forest_value, values, t):
    """The forecast: the forest's prediction averaged with the 3-month average, never below 0."""
    return max(0.0, (float(forest_value) + mean_last3(values, t)) / 2)


def forecast_paths(forest, series, last, steps):
    """{key: [forecast for last+1 .. last+steps]}, each step fed back as the next step's past."""
    keys = list(series)
    extended = {key: list(series[key][1]) for key in keys}
    paths = {key: [] for key in keys}
    for k in range(1, steps + 1):
        rows = [features(extended[key], len(extended[key])) + seasonal(last + k) for key in keys]
        for key, value in zip(keys, forest.predict(np.array(rows, dtype=float))):
            value = blend(value, extended[key], len(extended[key]))
            extended[key].append(value)
            paths[key].append(value)
    return paths


def horizon_backtest(series, last):
    """Refit without the last HOLDOUT months, forecast them recursively, MAE at each step."""
    cut = last - HOLDOUT + 1  # first held-out month
    X, y = training_rows(series, upto=cut)
    if len(y) < MIN_ROWS:
        return None
    forest = make_forest().fit(X, y)
    truncated = {}
    for key, (start, values) in series.items():
        t = cut - start
        if t >= LAGS:
            truncated[key] = (start, values[:t])
    if not truncated:
        return None
    paths = forecast_paths(forest, truncated, cut - 1, HOLDOUT)
    mae = []
    for k in range(HOLDOUT):
        errors = [abs(paths[key][k] - series[key][1][cut - series[key][0] + k]) for key in truncated]
        mae.append(round(float(np.mean(errors)), 2))
    return {'from': month_label(cut), 'mae': mae}


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
            'horizonMonths': [month_label(last + k) for k in range(1, HORIZON + 1)] if last is not None else [],
            'horizonBacktest': None,
            'results': [{'key': g['key'], 'predicted': None, 'path': None} for g in groups],
        }))
        return

    forest = make_forest().fit(X, y)

    next_index = last + 1
    paths = forecast_paths(forest, series, last, HORIZON)
    results = []
    for g in groups:
        path = paths.get(g['key'])
        results.append({'key': g['key'], 'predicted': path[0] if path else None, 'path': path})

    print(json.dumps({
        'trained': True,
        'trainedOn': int(len(y)),
        'forecastMonth': month_label(next_index),
        'oobR2': float(forest.oob_score_),
        'backtest': backtest(series, last),
        'horizonMonths': [month_label(last + k) for k in range(1, HORIZON + 1)],
        'horizonBacktest': horizon_backtest(series, last),
        'results': results,
    }))


if __name__ == '__main__':
    main()
