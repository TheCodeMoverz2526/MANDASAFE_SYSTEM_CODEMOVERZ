#!/usr/bin/env python3
"""Gaussian KDE hotspot finder for MandaSafe incident coordinates (scikit-learn).

Projects lat/lng to a local meter-space (so the kernel is isotropic in real distance), fits a
weighted 2D Gaussian KDE whose bandwidth is chosen by cross-validated log-likelihood -- a
data-driven fit rather than the fixed Silverman's-rule formula the old JS/PHP port used -- then
walks the density grid to report the top well-separated peaks with their dominant road/barangay
and fatal count, exactly as before.

Reads one JSON payload from stdin:

    {
      "records": [ {"lat", "lng", "weight", "ref": {"road", "barangay", "sev"}}, ... ],
      "bounds": {"minLat", "maxLat", "minLng", "maxLng"},
      "options": {"gridSize", "topN", "minSeparationMeters", "minRelativeDensity", "sampleRadiusMeters"}
    }

Writes a JSON array of hotspots to stdout.
"""
import json
import sys

import numpy as np
from sklearn.model_selection import KFold
from sklearn.neighbors import KernelDensity

METERS_PER_DEG_LAT = 111320.0
BANDWIDTH_CANDIDATES = np.geomspace(40, 1000, 10)
MIN_POINTS_FOR_CV = 12
DEFAULT_BANDWIDTH = 150.0
# A city has tens of thousands of incidents but the bandwidth that best fits the *shape* of
# their spatial distribution barely moves once a few thousand are sampled -- so the search
# below picks its candidate on a weighted subsample rather than the full dataset.
SUBSAMPLE_FOR_SEARCH = 3000
# sklearn's exact (rtol=0) KDE query is orders of magnitude slower than a tree query with a
# small tolerance, for a difference in the resulting density nobody could see: 0.1% relative
# error is far below the noise in "how many incidents happened near this grid cell" anyway.
KDE_RTOL = 1e-3


def project(lat, lng, origin_lat, origin_lng):
    cos_lat = np.cos(np.radians(origin_lat))
    x = (lng - origin_lng) * METERS_PER_DEG_LAT * cos_lat
    y = (lat - origin_lat) * METERS_PER_DEG_LAT
    return x, y


def choose_bandwidth(points, weights):
    """Picks the bandwidth with the best mean held-out weighted log-likelihood across folds,
    instead of trusting a single rule-of-thumb formula on data that may be multimodal."""
    n = len(points)
    if n < MIN_POINTS_FOR_CV:
        return DEFAULT_BANDWIDTH

    if n > SUBSAMPLE_FOR_SEARCH:
        rng = np.random.default_rng(42)
        idx = rng.choice(n, size=SUBSAMPLE_FOR_SEARCH, replace=False, p=weights / weights.sum())
        search_points, search_weights = points[idx], weights[idx]
    else:
        search_points, search_weights = points, weights

    splits = list(KFold(n_splits=min(5, len(search_points)), shuffle=True, random_state=42).split(search_points))

    best_h, best_score = DEFAULT_BANDWIDTH, -np.inf
    for h in BANDWIDTH_CANDIDATES:
        scores = []
        for train_idx, test_idx in splits:
            if len(train_idx) == 0 or len(test_idx) == 0:
                continue
            kde = KernelDensity(kernel='gaussian', bandwidth=h, rtol=KDE_RTOL)
            kde.fit(search_points[train_idx], sample_weight=search_weights[train_idx])
            log_dens = kde.score_samples(search_points[test_idx])
            scores.append(np.average(log_dens, weights=search_weights[test_idx]))
        mean_score = float(np.mean(scores)) if scores else -np.inf
        if mean_score > best_score:
            best_score, best_h = mean_score, h
    return float(best_h)


def main():
    payload = json.load(sys.stdin)
    records = payload.get('records') or []
    bounds = payload['bounds']
    options = payload.get('options') or {}

    grid_size = int(options.get('gridSize', 36))
    top_n = int(options.get('topN', 8))
    min_separation = float(options.get('minSeparationMeters', 400))
    min_relative_density = float(options.get('minRelativeDensity', 0.12))
    sample_radius = float(options.get('sampleRadiusMeters', 260))

    if not records:
        print(json.dumps([]))
        return

    origin_lat = (bounds['minLat'] + bounds['maxLat']) / 2
    origin_lng = (bounds['minLng'] + bounds['maxLng']) / 2

    lats = np.array([r['lat'] for r in records], dtype=float)
    lngs = np.array([r['lng'] for r in records], dtype=float)
    weights = np.array([max(r.get('weight', 1), 0.01) for r in records], dtype=float)
    xs, ys = project(lats, lngs, origin_lat, origin_lng)
    points = np.column_stack([xs, ys])

    bandwidth = choose_bandwidth(points, weights)

    kde = KernelDensity(kernel='gaussian', bandwidth=bandwidth, rtol=KDE_RTOL)
    kde.fit(points, sample_weight=weights)

    pad_lat = (bounds['maxLat'] - bounds['minLat']) * 0.04
    pad_lng = (bounds['maxLng'] - bounds['minLng']) * 0.04
    lat_step = (bounds['maxLat'] - bounds['minLat'] + pad_lat * 2) / grid_size
    lng_step = (bounds['maxLng'] - bounds['minLng'] + pad_lng * 2) / grid_size

    grid_lats = bounds['minLat'] - pad_lat + np.arange(grid_size + 1) * lat_step
    grid_lngs = bounds['minLng'] - pad_lng + np.arange(grid_size + 1) * lng_step
    grid_lat_mesh, grid_lng_mesh = np.meshgrid(grid_lats, grid_lngs, indexing='ij')
    flat_lats = grid_lat_mesh.ravel()
    flat_lngs = grid_lng_mesh.ravel()
    grid_x, grid_y = project(flat_lats, flat_lngs, origin_lat, origin_lng)
    grid_points = np.column_stack([grid_x, grid_y])

    density = np.exp(kde.score_samples(grid_points))
    max_density = float(density.max())
    if max_density <= 0:
        print(json.dumps([]))
        return

    order = np.argsort(-density)

    hotspots = []
    chosen_xy = []
    for idx in order:
        d = density[idx]
        if d / max_density < min_relative_density:
            break
        if len(hotspots) >= top_n:
            break
        cx, cy = grid_x[idx], grid_y[idx]
        if any(np.hypot(cx - hx, cy - hy) < min_separation for hx, hy in chosen_xy):
            continue

        dist = np.hypot(xs - cx, ys - cy)
        nearby_idx = np.where(dist <= sample_radius)[0]
        if len(nearby_idx) == 0:
            continue

        road_counts, barangay_counts, fatal_count = {}, {}, 0
        for i in nearby_idx:
            ref = records[int(i)].get('ref') or {}
            road = ref.get('road') or 'Unknown'
            barangay = ref.get('barangay') or 'Unknown'
            road_counts[road] = road_counts.get(road, 0) + 1
            barangay_counts[barangay] = barangay_counts.get(barangay, 0) + 1
            if ref.get('sev') == 'Fatal':
                fatal_count += 1

        top_road = max(road_counts.items(), key=lambda kv: kv[1])[0]
        top_barangay = max(barangay_counts.items(), key=lambda kv: kv[1])[0]

        hotspots.append({
            'lat': float(flat_lats[idx]), 'lng': float(flat_lngs[idx]),
            'x': float(cx), 'y': float(cy),
            'density': float(d),
            'intensity': round(float(d / max_density), 2),
            'incidentCount': int(len(nearby_idx)),
            'road': top_road,
            'barangay': top_barangay,
            'fatalCount': int(fatal_count),
            'bandwidthMeters': round(bandwidth, 1),
        })
        chosen_xy.append((cx, cy))

    # When many incidents share the exact same fallback (barangay-centroid) coordinates, the
    # kernel's spread can still surface more than one grid peak for the same road -- collapse
    # those down to the single strongest peak per road/barangay pair.
    by_location = {}
    for h in hotspots:
        key = f"{h['barangay']}||{h['road']}"
        if key not in by_location or h['density'] > by_location[key]['density']:
            by_location[key] = h

    result = sorted(by_location.values(), key=lambda h: -h['density'])
    for h in result:
        h.pop('x', None)
        h.pop('y', None)

    print(json.dumps(result))


if __name__ == '__main__':
    main()
