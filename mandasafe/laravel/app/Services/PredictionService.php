<?php

namespace App\Services;

use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * Road-safety predictions computed purely from data that actually exists in the database:
 * admin-entered baseline monthly counts (prediction inputs) plus logged incidents. No
 * hardcoded or mock prediction values are used anywhere in this class. Port of prediction.js.
 *
 * Two signals feed the final risk score:
 *  - a forecast of next month's incident count per barangay/road: a scikit-learn Random
 *    Forest regressor (ml/forecast_forest.py) trained on every group's monthly history, or a
 *    straight-line trend when there is too little history or Python is unavailable, and
 *  - a scikit-learn Random Forest classifier (ml/severity_forest.py), trained on logged
 *    incidents, that estimates how likely a severe outcome (Fatal/Injury) is for that
 *    location, from barangay/road/type/time features.
 *
 * The forest needs a minimum amount of labeled, class-diverse history to train at all; until
 * then predictions fall back to the frequency signal alone (mlModel: 'heuristic').
 */
class PredictionService
{
    /**
     * Runs every group's own logged incidents through the severity forest in one call.
     *
     * @param  array<string, array>  $groupIncidents  group key => that group's incident rows
     * @param  bool  $degraded  set true only when the fallback was forced by a failure (a
     *                          crashed/unavailable Python interpreter), never when the forest
     *                          legitimately has too little class-diverse data to train --
     *                          that second case is a stable answer, safe to cache normally.
     * @return array{trained: bool, oobAccuracy: ?float, probabilities: array<string, ?float>}
     */
    private static function scoreGroupSeverity(array $incidents, array $groupIncidents, bool &$degraded = false): array
    {
        $degraded = false;

        try {
            $response = MlBridge::run('severity_forest.py', [
                'incidents' => array_values($incidents),
                'groups' => array_map(
                    fn ($key, $rows) => ['key' => $key, 'incidents' => array_values($rows)],
                    array_keys($groupIncidents),
                    array_values($groupIncidents)
                ),
            ]);
        } catch (Throwable $e) {
            // The forest is an enhancement, not a requirement -- computePredictions() already
            // falls back to the frequency signal alone (mlModel: 'heuristic') whenever the model
            // isn't trained, so a broken/unavailable Python interpreter degrades to that same
            // path instead of failing the whole predictions/summary request.
            Log::warning('severity_forest.py unavailable, falling back to heuristic scoring', [
                'error' => $e->getMessage(),
            ]);

            $degraded = true;

            return ['trained' => false, 'oobAccuracy' => null, 'probabilities' => []];
        }

        $probabilities = [];
        foreach ($response['results'] ?? [] as $result) {
            $probabilities[$result['key']] = $result['severeProbability'];
        }

        return [
            'trained' => (bool) ($response['trained'] ?? false),
            'oobAccuracy' => $response['oobAccuracy'] ?? null,
            'probabilities' => $probabilities,
        ];
    }

    /**
     * Next-month counts from the Random Forest regressor in ml/forecast_forest.py, trained on
     * every group's monthly history at once. Falls back to the straight-line forecast (an
     * untrained result) when Python is unavailable or there is too little history.
     *
     * @param  array<string, array<string, int>>  $histories  group key => [month => count]
     * @return array{trained: bool, forecastMonth: ?string, oobR2: ?float, backtest: ?array, predicted: array<string, ?float>}
     */
    private static function forecastWithForest(array $histories, bool &$degraded = false): array
    {
        $untrained = ['trained' => false, 'forecastMonth' => null, 'oobR2' => null, 'backtest' => null, 'predicted' => []];

        try {
            $response = MlBridge::run('forecast_forest.py', [
                'groups' => array_map(
                    fn ($key, $history) => [
                        'key' => $key,
                        'history' => array_map(fn ($month, $count) => ['month' => $month, 'count' => $count], array_keys($history), array_values($history)),
                    ],
                    array_keys($histories),
                    array_values($histories)
                ),
            ]);
        } catch (Throwable $e) {
            Log::warning('forecast_forest.py unavailable, falling back to the linear forecast', [
                'error' => $e->getMessage(),
            ]);
            $degraded = true;

            return $untrained;
        }

        $predicted = [];
        foreach ($response['results'] ?? [] as $result) {
            $predicted[$result['key']] = $result['predicted'];
        }

        return [
            'trained' => (bool) ($response['trained'] ?? false),
            'forecastMonth' => $response['forecastMonth'] ?? null,
            'oobR2' => $response['oobR2'] ?? null,
            'backtest' => $response['backtest'] ?? null,
            'predicted' => $predicted,
        ];
    }

    public static function monthKey($date): ?string
    {
        if (empty($date)) {
            return null;
        }
        $stamp = strtotime((string) $date);

        return $stamp === false ? null : date('Y-m', $stamp);
    }

    private static function groupKey($barangay, $road): string
    {
        return $barangay . '||' . ($road ?: 'All Roads');
    }

    /** Ordinary least-squares fit over the monthly counts, projected one month ahead. */
    private static function linearForecast(array $counts): array
    {
        $n = count($counts);
        if ($n === 0) {
            return ['value' => 0, 'slope' => 0.0];
        }
        if ($n === 1) {
            return ['value' => (int) $counts[0], 'slope' => 0.0];
        }

        $xMean = ($n - 1) / 2;
        $yMean = array_sum($counts) / $n;

        $num = 0.0;
        $den = 0.0;
        for ($i = 0; $i < $n; $i++) {
            $num += ($i - $xMean) * ($counts[$i] - $yMean);
            $den += ($i - $xMean) ** 2;
        }

        $slope = $den == 0.0 ? 0.0 : $num / $den;
        $forecast = $yMean + $slope * ($n - $xMean);

        return ['value' => (int) max(0, self::jsRound($forecast)), 'slope' => $slope];
    }

    /** JavaScript's Math.round: halves always go up, never away from zero. */
    private static function jsRound(float $value): float
    {
        return floor($value + 0.5);
    }

    /**
     * @param  array  $incidents  plain rows with barangay/road/sev/type/date/time/status keys
     * @param  array  $predictionInputs  plain rows with barangay/road/month/incidentCount keys
     */
    public static function computePredictions(array $incidents, array $predictionInputs, bool &$degraded = false): array
    {
        $groups = [];

        foreach ($predictionInputs as $input) {
            if (empty($input['barangay']) || empty($input['month'])) {
                continue;
            }
            $key = self::groupKey($input['barangay'], $input['road'] ?? null);
            if (! isset($groups[$key])) {
                $groups[$key] = ['barangay' => $input['barangay'], 'road' => $input['road'] ?: 'All Roads', 'history' => [], 'sources' => [], 'incidents' => []];
            }
            $month = $input['month'];
            $groups[$key]['history'][$month] = ($groups[$key]['history'][$month] ?? 0) + (int) ($input['incidentCount'] ?? 0);
            $groups[$key]['sources']['admin'] = true;
        }

        foreach ($incidents as $incident) {
            if (empty($incident['barangay']) || empty($incident['road'])) {
                continue;
            }
            $key = self::groupKey($incident['barangay'], $incident['road']);
            if (! isset($groups[$key])) {
                $groups[$key] = ['barangay' => $incident['barangay'], 'road' => $incident['road'], 'history' => [], 'sources' => [], 'incidents' => []];
            }
            $groups[$key]['incidents'][] = $incident;

            $month = self::monthKey($incident['date'] ?? null);
            if ($month !== null) {
                $groups[$key]['history'][$month] = ($groups[$key]['history'][$month] ?? 0) + 1;
                $groups[$key]['sources']['logged'] = true;
            }
        }

        $severity = self::scoreGroupSeverity($incidents, array_map(fn ($g) => $g['incidents'], $groups), $degraded);

        $forecastDegraded = false;
        $forest = self::forecastWithForest(array_map(fn ($g) => $g['history'], $groups), $forecastDegraded);
        $degraded = $degraded || $forecastDegraded;

        $results = [];
        foreach ($groups as $key => $group) {
            $history = $group['history'];
            ksort($history, SORT_STRING);
            $months = array_keys($history);
            $counts = array_values($history);

            $recentWindow = array_slice($counts, -3);
            $recentAvg = $recentWindow === [] ? 0 : array_sum($recentWindow) / count($recentWindow);

            $forestValue = $forest['trained'] ? ($forest['predicted'][$key] ?? null) : null;

            if ($forestValue !== null) {
                // The forest's forecast, and whether it sits above or below the recent level.
                $predictedNextMonth = (int) self::jsRound($forestValue);
                $change = $recentAvg > 0 ? ($forestValue - $recentAvg) / $recentAvg : ($forestValue > 0 ? 1 : 0);
                $trend = $change > 0.10 ? 'up' : ($change < -0.10 ? 'down' : 'stable');
            } else {
                $forecast = self::linearForecast($counts);
                $predictedNextMonth = $forecast['value'];
                $slope = $forecast['slope'];
                $trend = $slope > 0.15 ? 'up' : ($slope < -0.15 ? 'down' : 'stable');
            }
            $frequencyScore = $recentAvg * 0.55 + $predictedNextMonth * 0.45;

            // The forest's severe-outcome probability nudges the frequency score up to +30% or
            // down to -30%; it modulates volume-based risk rather than replacing it, since a
            // busy-but-minor road should not outrank a low-traffic road with a fatal history.
            $severeProbability = $severity['probabilities'][$key] ?? null;
            $mlAdjustment = $severeProbability === null ? 1 : 0.7 + 0.6 * $severeProbability;
            $rawScore = $frequencyScore * $mlAdjustment;

            $historyOut = [];
            foreach ($months as $index => $month) {
                $historyOut[] = ['month' => $month, 'count' => $counts[$index]];
            }

            $results[] = [
                'key' => $key,
                'barangay' => $group['barangay'],
                'road' => $group['road'],
                'history' => $historyOut,
                'totalIncidents' => array_sum($counts),
                'predictedNextMonth' => $predictedNextMonth,
                'trend' => $trend,
                '_rawScore' => $rawScore,
                'severeProbability' => $severeProbability === null ? null : self::jsRound($severeProbability * 100) / 100,
                'mlModel' => $severity['trained'] ? 'random-forest' : 'heuristic',
                'mlAccuracy' => $severity['trained'] ? self::jsRound($severity['oobAccuracy'] * 100) / 100 : null,
                // Which model produced predictedNextMonth: the Python forest, or the straight line.
                'forecastModel' => $forestValue !== null ? 'random-forest' : 'linear',
                'forecastMonth' => $forest['forecastMonth'],
                'forecastBacktest' => $forestValue !== null ? $forest['backtest'] : null,
                'sources' => array_keys($group['sources']),
            ];
        }

        $maxScore = max(1, ...array_merge([1], array_column($results, '_rawScore')));

        foreach ($results as &$result) {
            $result['riskScore'] = self::jsRound(($result['_rawScore'] / $maxScore) * 100) / 10;
            $result['riskLevel'] = $result['riskScore'] >= 7 ? 'high' : ($result['riskScore'] >= 4 ? 'medium' : 'low');
            unset($result['_rawScore']);
        }
        unset($result);

        usort($results, fn ($a, $b) => $b['riskScore'] <=> $a['riskScore']);

        return $results;
    }

    public static function computeStats(array $incidents, array $predictions): array
    {
        $total = count($incidents);
        $resolved = 0;
        foreach ($incidents as $incident) {
            if (($incident['status'] ?? null) === 'resolved') {
                $resolved++;
            }
        }

        $levels = array_count_values(array_column($predictions, 'riskLevel'));
        $riskScores = array_column($predictions, 'riskScore');

        return [
            'totalIncidents' => $total,
            'activeIncidents' => $total - $resolved,
            'resolvedIncidents' => $resolved,
            'highRiskLocations' => $levels['high'] ?? 0,
            'mediumRiskLocations' => $levels['medium'] ?? 0,
            'lowRiskLocations' => $levels['low'] ?? 0,
            'avgRiskScore' => $riskScores === [] ? 0 : self::jsRound((array_sum($riskScores) / count($riskScores)) * 10) / 10,
            'updatedAt' => AccountService::isoNow(),
        ];
    }
}
