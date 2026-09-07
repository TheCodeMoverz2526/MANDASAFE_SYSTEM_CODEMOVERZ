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

    public function predictions(): array
    {
        return $this->remember('predictions', fn () => PredictionService::computePredictions(
            $this->incidents(),
            $this->predictionInputs()
        ));
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
        return $this->remember('hotspots', function () {
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

            return KdeService::findHotspots($records, GeoService::mandaluyongBounds());
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

            $monthList = [];
            foreach ($byMonth as $month => $count) {
                $monthList[] = ['month' => (string) $month, 'count' => $count];
            }

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
                'topPredictions' => array_slice($predictions, 0, 6),
                'recent' => array_slice($recent, 0, 20),
            ];
        });
    }
}
