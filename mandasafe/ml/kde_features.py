"""KDE density features shared by MandaSafe's machine-learning models.

The hotspot finder (hotspots.py) turns accident coordinates into a Gaussian KDE surface for the
map. The two classifiers -- prone_area_forest.py (which places are accident-prone) and
severity_forest.py (how severe an accident is likely to be) -- use that same surface as model
input, through the helpers here: the same meter-space projection, the same cross-validated
bandwidth, and one density unit (accidents per km^2 per month) that stays comparable between
time windows of different length.
"""
import numpy as np
from sklearn.neighbors import KernelDensity

from hotspots import KDE_RTOL, METERS_PER_DEG_LAT, choose_bandwidth, project  # noqa: F401  (re-exported)

M2_PER_KM2 = 1_000_000.0


def unproject(x, y, origin_lat, origin_lng):
    cos_lat = np.cos(np.radians(origin_lat))
    lat = origin_lat + np.asarray(y) / METERS_PER_DEG_LAT
    lng = origin_lng + np.asarray(x) / (METERS_PER_DEG_LAT * cos_lat)
    return lat, lng


def density_rate(points, query, bandwidth, months, weights=None):
    """Accidents per km^2 per month at each query point, from a Gaussian KDE over `points`.

    sklearn's KDE integrates to 1, so the density is scaled by the (weighted) number of points
    and divided by the window length -- a busy three-month window and a quiet twelve-month one
    then land on the same scale. No points means zero density everywhere."""
    query = np.asarray(query, dtype=float)
    if len(points) == 0 or len(query) == 0:
        return np.zeros(len(query))
    weights = np.ones(len(points)) if weights is None else np.asarray(weights, dtype=float)
    kde = KernelDensity(kernel='gaussian', bandwidth=bandwidth, rtol=KDE_RTOL)
    kde.fit(points, sample_weight=weights)
    density = np.exp(kde.score_samples(query))
    return density * weights.sum() * M2_PER_KM2 / max(months, 1)


class BinnedKde:
    """A Gaussian KDE evaluated on a fixed grid, for scoring many windows quickly.

    Accidents are counted on a grid whose step is a quarter of the bandwidth (never finer than
    MIN_STEP meters) and the counts are smoothed with a Gaussian kernel of that bandwidth --
    the standard binned approximation of a KDE, accurate to a fraction of the grid step. Each
    window then costs milliseconds instead of a tree query per point, which is what lets the
    models try several bandwidths."""
    MIN_STEP = 25.0

    def __init__(self, min_x, min_y, max_x, max_y):
        self.extent = (min_x, min_y, max_x, max_y)

    def rate(self, points, query, bandwidth, months, weights=None):
        """Accidents per km^2 per month at each query point -- same unit as density_rate()."""
        from scipy.ndimage import gaussian_filter
        min_x, min_y, max_x, max_y = self.extent
        step = max(self.MIN_STEP, bandwidth / 4)
        pad = 4 * bandwidth
        x0, y0 = min_x - pad, min_y - pad
        nx = int(np.ceil((max_x - min_x + 2 * pad) / step)) + 1
        ny = int(np.ceil((max_y - min_y + 2 * pad) / step)) + 1

        def index(xs, ys):
            return (np.clip(((ys - y0) / step).astype(int), 0, ny - 1),
                    np.clip(((xs - x0) / step).astype(int), 0, nx - 1))

        grid = np.zeros((ny, nx))
        if len(points):
            np.add.at(grid, index(points[:, 0], points[:, 1]),
                      1.0 if weights is None else np.asarray(weights, dtype=float))
        smooth = gaussian_filter(grid, sigma=bandwidth / step, mode='constant', truncate=4.0)
        return smooth[index(query[:, 0], query[:, 1])] / (step ** 2) * M2_PER_KM2 / max(months, 1)


def points_in_ring(lngs, lats, ring):
    """Vectorised ray-casting point-in-polygon for one ring of [lng, lat] pairs."""
    ring = np.asarray(ring, dtype=float)
    inside = np.zeros(len(lngs), dtype=bool)
    xj, yj = ring[-1]
    for xi, yi in ring:
        crosses = (yi > lats) != (yj > lats)
        with np.errstate(divide='ignore', invalid='ignore'):
            x_cross = (xj - xi) * (lats - yi) / (yj - yi) + xi
        inside ^= crosses & (lngs < x_cross)
        xj, yj = xi, yi
    return inside


def locate_barangays(lngs, lats, boundaries):
    """The barangay each point falls inside, by its coordinates, or None outside the city.
    `boundaries` is {barangay: [outer ring, ...]} as GeoService::barangayPolygons() sends it."""
    lngs = np.asarray(lngs, dtype=float)
    lats = np.asarray(lats, dtype=float)
    names = np.full(len(lngs), None, dtype=object)
    for name, rings in (boundaries or {}).items():
        todo = names == None  # noqa: E711  (elementwise comparison on an object array)
        if not todo.any():
            break
        hit = np.zeros(len(lngs), dtype=bool)
        for ring in rings:
            hit |= points_in_ring(lngs, lats, ring)
        names[todo & hit] = name
    return names
