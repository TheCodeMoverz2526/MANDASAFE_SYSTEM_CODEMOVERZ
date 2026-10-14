<?php

namespace App\Services;

use App\Models\Incident;
use App\Models\PredictionInput;
use App\Models\Setting;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * The read-only figures every MandaSafe page shows: predictions, stats, hotspots and the
 * one-payload summary. These are pure functions of the stored data, so each is computed once
 * and cached until a write bumps the data version (Setting::touchDataVersion()).
 */
class AnalyticsService
{
    private const SEVERITY_WEIGHTS = ['Fatal' => 4, 'Injury' => 3, 'Minor' => 2, 'Damage' => 1];

    /**
     * Bumped whenever the shape of a cached result changes (e.g. predictions gaining the
     * 24-month forecastPath), so old cache entries are ignored instead of served for a day.
     */
    private const CACHE_SCHEMA = 6;

    /** Incidents as plain rows, newest first — the shape the ported algorithms expect. */
    public function incidents(): array
    {
        return Incident::newestFirst()->get()->map->toApi()->all();
    }

    public function predictionInputs(): array
    {
        return PredictionInput::newestFirst()->get()->map->toApi()->all();
    }

    private function remember(string $name, callable $callback)
    {
        return $this->cached($name, function (&$degraded) use ($callback) {
            return $callback();
        });
    }

    /**
     * For a computation that can silently degrade (a crashed Python interpreter falling back
     * to "no hotspots" or "untrained model"). A degraded result is real data, not a bug, but
     * it is also likely a passing hiccup, so it is kept for 30 seconds instead of a day.
     */
    private function rememberUnlessDegraded(string $name, callable $callback)
    {
        return $this->cached($name, $callback);
    }

    /**
     * The cache every figure goes through. Results are keyed by the data version, so any
     * write makes them stale. Three things keep a stale cache from ever making a visitor wait:
     *
     *  - After a write, the models are recomputed in the background (AnalyticsWarmer), and
     *    until that finishes visitors get the previous result straight away. The accident
     *    records themselves are never cached, so new records still show at once; only the
     *    model outputs lag for the half-minute the recomputation takes.
     *  - With nothing older to show (a fresh install), only one request computes; the others
     *    wait for its result instead of each running the same Python models at once.
     *  - A degraded result (Python failed) is kept for 30 seconds only and never becomes the
     *    "previous result" that is served while warming.
     */
    private function cached(string $name, callable $callback)
    {
        $seconds = (int) config('mandasafe.analytics_cache_seconds');
        if ($seconds <= 0) {
            $degraded = false;

            return $callback($degraded);
        }

        $version = Setting::dataVersion();
        $key = self::cacheKey($name, $version);
        $latestKey = 'mandasafe:' . $name . ':s' . self::CACHE_SCHEMA . ':latest';

        $cached = Cache::get($key);
        if ($cached !== null) {
            return $cached;
        }

        // Serve the previous result while the background warm catches up — but never inside
        // the warm itself, which is the process that has to do the real computation.
        if (AnalyticsWarmer::enabled() && ! AnalyticsWarmer::$warming) {
            $latest = Cache::get($latestKey);
            if (is_array($latest) && array_key_exists('value', $latest)) {
                AnalyticsWarmer::kick();

                return $latest['value'];
            }
        }

        $compute = function () use ($key, $latestKey, $callback, $seconds, $version) {
            $again = Cache::get($key);   // someone else may have finished while we waited
            if ($again !== null) {
                return $again;
            }
            $degraded = false;
            $result = $callback($degraded);
            Cache::put($key, $result, $degraded ? 30 : $seconds);
            if (! $degraded) {
                Cache::forever($latestKey, ['version' => $version, 'value' => $result]);
            }

            return $result;
        };

        try {
            return Cache::lock('mandasafe:compute:' . $name, 300)->block(280, $compute);
        } catch (Throwable $e) {
            // No lock support, or the wait ran out: compute anyway rather than fail the page.
            return $compute();
        }
    }

    private static function cacheKey(string $name, int $version): string
    {
        return 'mandasafe:' . $name . ':s' . self::CACHE_SCHEMA . ':v' . $version;
    }

    public function predictions(): array
    {
        return $this->rememberUnlessDegraded('predictions', function (&$degraded) {
            return PredictionService::computePredictions($this->incidents(), $this->predictionInputs(), $degraded);
        });
    }

    public function stats(): array
    {
        return $this->remember('stats', fn () => PredictionService::computeStats(
            $this->incidents(),
            $this->predictions()
        ));
    }

    /**
     * Runs the Gaussian KDE hotspot finder over every incident with a resolvable location
     * (its own coordinates, or its barangay's centroid as a fallback), weighted by severity.
     */
    public function hotspots(): array
    {
        return $this->densityAnalysis()['peaks'];
    }

    /**
     * Every barangay ranked on the same density surface as the hotspot peaks (see
     * barangay_ranking in ml/hotspots.py), so the list covers the whole city, not just peaks.
     */
    public function barangayHotspots(): array
    {
        return $this->densityAnalysis()['barangays'];
    }

    /** One KDE run gives both the peaks and the per-barangay ranking; it is cached as a pair. */
    private function densityAnalysis(): array
    {
        return $this->rememberUnlessDegraded('density', function (&$degraded) {
            $records = [];
            foreach ($this->incidents() as $incident) {
                $point = GeoService::resolveIncidentPoint($incident);
                if ($point === null) {
                    continue;
                }
                $records[] = [
                    'lat' => $point['lat'],
                    'lng' => $point['lng'],
                    'weight' => self::SEVERITY_WEIGHTS[$incident['sev']] ?? 1,
                    'ref' => $incident,
                ];
            }

            $result = KdeService::findHotspots($records, GeoService::mandaluyongBounds(), [
                'withBarangays' => true,
                // So each barangay's map spot is placed inside its own boundary.
                'boundaries' => GeoService::barangayPolygons(),
                'centroids' => GeoService::barangayCentroids(),
            ], $degraded);

            // An empty/failed run comes back as a bare list rather than the pair.
            return [
                'peaks' => $result['peaks'] ?? (array_is_list($result) ? $result : []),
                'barangays' => $result['barangays'] ?? [],
            ];
        });
    }

    /**
     * The accident-prone area classifier (ml/prone_area_forest.py): KDE density features per
     * 250 m cell feed a Random Forest that predicts which cells will be accident-prone over the
     * coming months, validated on the most recent period it never trained on.
     */
    public function proneAreas(): array
    {
        return $this->rememberUnlessDegraded('prone-areas', function (&$degraded) {
            $incidents = [];
            foreach ($this->incidents() as $incident) {
                // Only real coordinates: a guessed location would teach the model a pattern
                // that is not in the data.
                if (is_numeric($incident['lat'] ?? null) && is_numeric($incident['lng'] ?? null)) {
                    $incidents[] = [
                        'lat' => (float) $incident['lat'],
                        'lng' => (float) $incident['lng'],
                        'date' => $incident['date'] ?? null,
                        'sev' => $incident['sev'] ?? null,
                        'barangay' => $incident['barangay'] ?? null,
                    ];
                }
            }

            try {
                return MlBridge::run('prone_area_forest.py', [
                    'incidents' => $incidents,
                    'boundaries' => GeoService::barangayPolygons(),
                ]);
            } catch (Throwable $e) {
                Log::warning('prone_area_forest.py unavailable', ['error' => $e->getMessage()]);
                $degraded = true;

                return ['trained' => false, 'reason' => 'The prediction model could not run. Check that Python and scikit-learn are installed.', 'model' => null, 'cells' => [], 'barangays' => []];
            }
        });
    }

    /**
     * Severity classification: how the records split across Fatal / Injury / Minor / Damage
     * (overall and per barangay), plus the state of the Random Forest severity classifier
     * (ml/severity_forest.py) — trained, or the plain reason it cannot train yet.
     */
    public function severityClassification(): array
    {
        return $this->rememberUnlessDegraded('severity', function (&$degraded) {
            $incidents = $this->incidents();
            $order = array_keys(self::SEVERITY_WEIGHTS);

            $overall = [];
            $byBarangay = [];
            foreach ($incidents as $incident) {
                $sev = $incident['sev'] ?: 'Unknown';
                $barangay = $incident['barangay'] ?: 'Unknown';
                $overall[$sev] = ($overall[$sev] ?? 0) + 1;
                $byBarangay[$barangay][$sev] = ($byBarangay[$barangay][$sev] ?? 0) + 1;
            }

            $total = count($incidents);
            $rank = fn ($sev) => ($i = array_search($sev, $order, true)) === false ? 99 : $i;
            uksort($overall, fn ($a, $b) => $rank($a) <=> $rank($b) ?: strcmp($a, $b));
            $distribution = [];
            foreach ($overall as $sev => $count) {
                $distribution[] = ['sev' => (string) $sev, 'count' => $count, 'percent' => $total ? round($count / $total * 100, 1) : 0];
            }

            $barangays = [];
            foreach ($byBarangay as $barangay => $counts) {
                $sum = array_sum($counts);
                $severe = ($counts['Fatal'] ?? 0) + ($counts['Injury'] ?? 0);
                $barangays[] = [
                    'barangay' => (string) $barangay,
                    'total' => $sum,
                    'counts' => $counts,
                    'severePercent' => $sum ? round($severe / $sum * 100, 1) : 0,
                ];
            }
            usort($barangays, fn ($a, $b) => $b['severePercent'] <=> $a['severePercent'] ?: $b['total'] <=> $a['total']);

            try {
                $model = MlBridge::run('severity_forest.py', ['incidents' => $incidents, 'groups' => []]);
                unset($model['results']);
            } catch (Throwable $e) {
                Log::warning('severity_forest.py unavailable', ['error' => $e->getMessage()]);
                $degraded = true;
                $model = ['trained' => false, 'reason' => 'The severity model could not run. Check that Python and scikit-learn are installed.'];
            }

            return [
                'total' => $total,
                'distribution' => $distribution,
                'byBarangay' => $barangays,
                'model' => $model,
            ];
        });
    }

    /**
     * One small payload for the resident-facing pages: totals, per-barangay counts (with the
     * barangay centroid so the map can label them), monthly trend, type/severity mix and the
     * newest reports. Sending this instead of all ~8,000 incident rows keeps those pages quick.
     */
    public function summary(): array
    {
        return $this->remember('summary', function () {
            $incidents = $this->incidents();
            $predictions = $this->predictions();
            $stats = PredictionService::computeStats($incidents, $predictions);
            $centroids = GeoService::barangayCentroids();

            $byBarangay = [];
            $byMonth = [];
            $byType = [];
            $byRoad = [];
            $bySeverity = [];
            $dates = [];

            foreach ($incidents as $incident) {
                $barangay = $incident['barangay'] ?: 'Unknown';
                if (! isset($byBarangay[$barangay])) {
                    $centroid = $centroids[$barangay] ?? null;
                    $byBarangay[$barangay] = [
                        'barangay' => $barangay,
                        'count' => 0,
                        'lat' => $centroid['lat'] ?? null,
                        'lng' => $centroid['lng'] ?? null,
                    ];
                }
                $byBarangay[$barangay]['count']++;

                $month = substr((string) ($incident['date'] ?? ''), 0, 7);
                if (preg_match('/^\d{4}-\d{2}$/', $month)) {
                    $byMonth[$month] = ($byMonth[$month] ?? 0) + 1;
                }

                $type = $incident['type'] ?: 'Unknown';
                $byType[$type] = ($byType[$type] ?? 0) + 1;

                $road = trim((string) ($incident['road'] ?? ''));
                if ($road !== '' && $road !== 'Unknown') {
                    $byRoad[$road] = ($byRoad[$road] ?? 0) + 1;
                }

                $sev = $incident['sev'] ?: 'Unknown';
                $bySeverity[$sev] = ($bySeverity[$sev] ?? 0) + 1;

                if (! empty($incident['date'])) {
                    $dates[] = $incident['date'];
                }
            }

            sort($dates, SORT_STRING);

            $recent = $incidents;
            usort($recent, fn ($a, $b) => strcmp(
                $b['date'] . ' ' . $b['time'],
                $a['date'] . ' ' . $a['time']
            ));

            $barangayList = array_values($byBarangay);
            usort($barangayList, fn ($a, $b) => $b['count'] <=> $a['count']);

            ksort($byMonth, SORT_STRING);
            arsort($byType);
            arsort($bySeverity);

            // Every month from the first record to the last, including months with none —
            // skipping empty months would make a trend line jump straight over a gap.
            $monthList = [];
            foreach (SafetyIndexService::monthRange($incidents) as $month) {
                $monthList[] = ['month' => $month, 'count' => $byMonth[$month] ?? 0];
            }

            // Hour of day (0-23) and weekday (Mon..Sun), from each record's own date and time.
            $byHour = array_fill(0, 24, 0);
            $byWeekday = array_fill(0, 7, 0);
            foreach ($incidents as $incident) {
                if (preg_match('/^(\d{1,2}):\d{2}/', (string) ($incident['time'] ?? ''), $t) && (int) $t[1] < 24) {
                    $byHour[(int) $t[1]]++;
                }
                $stamp = strtotime(substr((string) ($incident['date'] ?? ''), 0, 10));
                if ($stamp !== false) {
                    $byWeekday[(int) date('N', $stamp) - 1]++;
                }
            }

            $latest = end($monthList) ?: null;
            $previous = count($monthList) > 1 ? $monthList[count($monthList) - 2] : null;

            $typeList = [];
            foreach ($byType as $type => $count) {
                $typeList[] = ['type' => (string) $type, 'count' => $count];
            }

            // Accidents per named road, busiest first; records without a road are left out.
            arsort($byRoad);
            $roadList = [];
            foreach ($byRoad as $road => $count) {
                $roadList[] = ['road' => (string) $road, 'count' => $count];
            }

            $severityList = [];
            foreach ($bySeverity as $sev => $count) {
                $severityList[] = ['sev' => (string) $sev, 'count' => $count];
            }

            return $stats + [
                'range' => ['from' => $dates[0] ?? null, 'to' => $dates === [] ? null : end($dates)],
                'barangayCount' => count($byBarangay),
                'byBarangay' => $barangayList,
                'byMonth' => $monthList,
                'byType' => $typeList,
                'byRoad' => $roadList,
                'bySeverity' => $severityList,
                'byHour' => $byHour,
                'byWeekday' => $byWeekday,
                'latestMonth' => $latest,
                'previousMonth' => $previous,
                // Whether these fields actually carry information: a column where every
                // record has the same value is not being recorded, and pages say so.
                'severityTracked' => count($bySeverity) > 1,
                'statusTracked' => ($stats['resolvedIncidents'] ?? 0) > 0,
                'safety' => SafetyIndexService::compute($incidents),
                'topPredictions' => array_slice($predictions, 0, 6),
                'recent' => array_slice($recent, 0, 20),
            ];
        });
    }
}
