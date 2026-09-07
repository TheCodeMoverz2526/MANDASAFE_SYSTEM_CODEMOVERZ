<?php

namespace App\Services;

/**
 * Road-safety predictions computed purely from data that actually exists in the database:
 * admin-entered baseline monthly counts (prediction inputs) plus logged incidents. No
 * hardcoded or mock prediction values are used anywhere in this class. Port of prediction.js.
 *
 * Two signals feed the final risk score:
 *  - a linear forecast of incident frequency per barangay/road (trend + volume), and
 *  - a Random Forest classifier trained on logged incidents that estimates how likely a
 *    severe outcome (Fatal/Injury) is for that location, from barangay/road/type/time features.
 *
 * The forest needs a minimum amount of labeled, class-diverse history to train at all; until
 * then predictions fall back to the frequency signal alone (mlModel: 'heuristic').
 */
class PredictionService
{
    private const SEVERITY_FEATURES = [
        ['key' => 'barangay', 'type' => 'categorical'],
        ['key' => 'road', 'type' => 'categorical'],
        ['key' => 'type', 'type' => 'categorical'],
        ['key' => 'hour', 'type' => 'numeric'],
        ['key' => 'dayOfWeek', 'type' => 'numeric'],
        ['key' => 'month', 'type' => 'numeric'],
    ];

    private const SEVERE_CLASSES = ['Fatal', 'Injury'];

    private static function parseHour($time): int
    {
        if (empty($time)) {
            return -1;
        }

        $stamp = strtotime('2000-01-01 ' . $time);

        return $stamp === false ? -1 : (int) date('G', $stamp);
    }

    public static function incidentFeatures(array $incident): array
    {
        $stamp = empty($incident['date']) ? false : strtotime((string) $incident['date']);

        return [
            'barangay' => $incident['barangay'] ?: 'Unknown',
            'road' => $incident['road'] ?: 'Unknown',
            'type' => $incident['type'] ?: 'Unknown',
            'hour' => self::parseHour($incident['time'] ?? null),
            'dayOfWeek' => $stamp === false ? -1 : (int) date('w', $stamp),
            'month' => $stamp === false ? -1 : ((int) date('n', $stamp)) - 1,
        ];
    }

    public static function trainSeverityForest(array $incidents): ?array
    {
        $rows = [];
        foreach ($incidents as $incident) {
            if (empty($incident['barangay']) || empty($incident['road']) || empty($incident['sev'])) {
                continue;
            }
            $rows[] = self::incidentFeatures($incident) + ['sev' => $incident['sev']];
        }

        return RandomForest::train($rows, ['features' => self::SEVERITY_FEATURES, 'labelKey' => 'sev']);
    }

    /**
     * Averages, across a group's own logged incidents, the forest's predicted probability that
     * the outcome is severe (Fatal or Injury). Returns null when there is nothing to score.
     */
    private static function groupSeverityProbability(?array $forest, array $groupIncidents): ?float
    {
        if ($forest === null || $groupIncidents === []) {
            return null;
        }

        $total = 0.0;
        foreach ($groupIncidents as $incident) {
            $result = RandomForest::predictClass($forest, self::incidentFeatures($incident));
            if ($result === null) {
                continue;
            }
            foreach ($result['probabilities'] as $label => $probability) {
                if (in_array($label, self::SEVERE_CLASSES, true)) {
                    $total += $probability;
                }
            }
        }

        return $total / count($groupIncidents);
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
    public static function computePredictions(array $incidents, array $predictionInputs): array
    {
        $groups = [];
        $forest = self::trainSeverityForest($incidents);

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

        $results = [];
        foreach ($groups as $key => $group) {
            $history = $group['history'];
            ksort($history, SORT_STRING);
            $months = array_keys($history);
            $counts = array_values($history);

            $forecast = self::linearForecast($counts);
            $predictedNextMonth = $forecast['value'];
            $slope = $forecast['slope'];
            $trend = $slope > 0.15 ? 'up' : ($slope < -0.15 ? 'down' : 'stable');

            $recentWindow = array_slice($counts, -3);
            $recentAvg = $recentWindow === [] ? 0 : array_sum($recentWindow) / count($recentWindow);
            $frequencyScore = $recentAvg * 0.55 + $predictedNextMonth * 0.45;

            // The forest's severe-outcome probability nudges the frequency score up to +30% or
            // down to -30%; it modulates volume-based risk rather than replacing it, since a
            // busy-but-minor road should not outrank a low-traffic road with a fatal history.
            $severeProbability = self::groupSeverityProbability($forest, $group['incidents']);
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
                'mlModel' => $forest ? 'random-forest' : 'heuristic',
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
