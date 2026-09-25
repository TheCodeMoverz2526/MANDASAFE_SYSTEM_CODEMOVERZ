<?php

namespace App\Services;

use App\Models\Incident;
use App\Models\PredictionInput;
use App\Models\Setting;
use Illuminate\Support\Facades\Cache;

/**
 * The read-only figures every MandaSafe page shows: predictions, stats, hotspots and the
 * one-payload summary. These are pure functions of the stored data, so each is computed once
 * and cached until a write bumps the data version (Setting::touchDataVersion()).
 */
class AnalyticsService
{
    private const SEVERITY_WEIGHTS = ['Fatal' => 4, 'Injury' => 3, 'Minor' => 2, 'Damage' => 1];

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
        $seconds = (int) config('mandasafe.analytics_cache_seconds');
        if ($seconds <= 0) {
            return $callback();
        }

        return Cache::remember('mandasafe:' . $name . ':v' . Setting::dataVersion(), $seconds, $callback);
    }

    /**
     * Same as remember(), but for a computation that can silently degrade (a crashed Python
     * interpreter falling back to "no hotspots" or "untrained model"). A degraded result is
     * real data, not a bug, but it is also likely a passing hiccup -- caching it for the full
     * 24 hours would freeze that hiccup in place long after the interpreter recovers, so it
     * gets a much shorter TTL instead and the next request tries again for real.
     */
    private function rememberUnlessDegraded(string $name, callable $callback)
    {
        $seconds = (int) config('mandasafe.analytics_cache_seconds');
        if ($seconds <= 0) {
            $degraded = false;

            return $callback($degraded);
        }

        $key = 'mandasafe:' . $name . ':v' . Setting::dataVersion();
        $cached = Cache::get($key);
        if ($cached !== null) {
            return $cached;
        }

        $degraded = false;
        $result = $callback($degraded);
        Cache::put($key, $result, $degraded ? 30 : $seconds);

        return $result;
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
