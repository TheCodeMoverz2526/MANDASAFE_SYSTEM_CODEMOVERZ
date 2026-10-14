<?php

namespace App\Services;

/**
 * The Safety Index — one 0-100 score for the city (higher is safer), shared by the admin
 * console and the resident pages so both always show the same number.
 *
 * It is built only from what the records actually contain, per complete calendar month:
 *
 *   Accident Frequency  -- the last 3 months against the 6 before them. No change scores 50;
 *                          every 1% fall adds a point, every 1% rise takes one away.
 *   Geographic Spread   -- how much of the last 3 months' accidents fall in a single barangay.
 *                          Evenly spread across the 27 barangays scores ~93; one barangay
 *                          holding half of them scores 0.
 *   Accident Severity   -- the fatal/injury share of the last 3 months. Only counted when the
 *                          records carry more than one severity; if every record has the same
 *                          value, severity is not really being recorded and is left out.
 *   Case Resolution     -- the share of records marked resolved. Only counted when at least
 *                          one record has been resolved; otherwise status is not being tracked.
 *
 * The overall score is the average of the categories that can be measured. The monthly trend
 * applies the same rules to each earlier month, so the last point of the trend is the score.
 */
class SafetyIndexService
{
    private const RECENT = 3;
    private const EARLIER = 6;

    /** A barangay's change is measured against at least this many accidents a month, so a
     *  move from 0.5 to 1 a month is not read as a 100% rise. */
    private const MIN_BASE = 3.0;

    public static function compute(array $incidents): array
    {
        $months = self::monthRange($incidents);
        $empty = [
            'overall' => null, 'level' => 'No data', 'categories' => [], 'excluded' => [],
            'trend' => [], 'byBarangay' => [], 'rising' => [], 'window' => null,
        ];
        if ($months === []) {
            return $empty;
        }

        $index = array_flip($months);
        $n = count($months);
        $city = array_fill(0, $n, 0);
        $severe = array_fill(0, $n, 0.0);   // fatal*4 + injury*2, per month
        $resolved = array_fill(0, $n, 0);
        $byBarangay = [];
        $severities = [];
        $anyResolved = false;

        foreach ($incidents as $incident) {
            $month = substr((string) ($incident['date'] ?? ''), 0, 7);
            if (! isset($index[$month])) {
                continue;
            }
            $i = $index[$month];
            $city[$i]++;

            $sev = (string) ($incident['sev'] ?? '');
            $severities[$sev] = true;
            $severe[$i] += $sev === 'Fatal' ? 4 : ($sev === 'Injury' ? 2 : 0);

            if (($incident['status'] ?? '') === 'resolved') {
                $resolved[$i]++;
                $anyResolved = true;
            }

            $barangay = $incident['barangay'] ?: 'Unknown';
            $byBarangay[$barangay] ??= array_fill(0, $n, 0);
            $byBarangay[$barangay][$i]++;
        }

        $severityTracked = count($severities) > 1;
        $statusTracked = $anyResolved;

        $excluded = [];
        if (! $severityTracked) {
            $only = array_key_first($severities) ?: 'one value';
            $excluded[] = ['name' => 'Accident Severity', 'reason' => "Every record has the same severity ({$only}), so severity is not being recorded yet."];
        }
        if (! $statusTracked) {
            $excluded[] = ['name' => 'Case Resolution', 'reason' => 'No record has been marked resolved, so case status is not being tracked yet.'];
        }
        if ($n < self::RECENT + self::EARLIER) {
            $excluded[] = ['name' => 'Accident Frequency', 'reason' => 'Needs at least ' . (self::RECENT + self::EARLIER) . ' months of records.'];
        }

        $at = function (int $end) use ($city, $severe, $resolved, $byBarangay, $n, $severityTracked, $statusTracked): array {
            $categories = [];

            if ($end + 1 >= self::RECENT + self::EARLIER) {
                $recent = self::avg($city, $end - self::RECENT + 1, $end);
                $earlier = self::avg($city, $end - self::RECENT - self::EARLIER + 1, $end - self::RECENT);
                $change = $earlier > 0 ? ($recent - $earlier) / $earlier : 0.0;
                $categories[] = [
                    'key' => 'frequency', 'name' => 'Accident Frequency',
                    'score' => self::clamp(50 - 100 * $change),
                    'why' => 'Last 3 months against the 6 before them',
                    'detail' => sprintf('%s a month recently vs %s before (%s%d%%)',
                        number_format($recent, 0), number_format($earlier, 0), $change >= 0 ? '+' : '', round($change * 100)),
                ];
            }

            $windowStart = max(0, $end - self::RECENT + 1);
            $windowTotal = self::sum($city, $windowStart, $end);
            if ($windowTotal > 0) {
                $top = 0;
                $topName = '';
                foreach ($byBarangay as $name => $series) {
                    $count = self::sum($series, $windowStart, $end);
                    if ($count > $top) {
                        $top = $count;
                        $topName = $name;
                    }
                }
                $share = $top / $windowTotal;
                $categories[] = [
                    'key' => 'spread', 'name' => 'Geographic Spread',
                    'score' => self::clamp(100 - $share * 200),
                    'why' => 'How concentrated recent accidents are in one barangay',
                    'detail' => sprintf('%s has %d%% of the last 3 months\' accidents', $topName, round($share * 100)),
                ];

                if ($severityTracked) {
                    $rate = self::sum($severe, $windowStart, $end) / $windowTotal;
                    $categories[] = [
                        'key' => 'severity', 'name' => 'Accident Severity',
                        'score' => self::clamp(100 - $rate * 100),
                        'why' => 'Share of fatal and injury outcomes in the last 3 months',
                        'detail' => '',
                    ];
                }
            }

            if ($statusTracked) {
                $total = self::sum($city, 0, $end);
                $categories[] = [
                    'key' => 'resolution', 'name' => 'Case Resolution',
                    'score' => self::clamp($total ? self::sum($resolved, 0, $end) / $total * 100 : 0),
                    'why' => 'Records marked resolved by the TPMO',
                    'detail' => '',
                ];
            }

            $overall = $categories === [] ? null
                : (int) round(array_sum(array_column($categories, 'score')) / count($categories));

            return [$overall, $categories];
        };

        [$overall, $categories] = $at($n - 1);
        foreach ($categories as &$category) {
            $category['score'] = (int) round($category['score']);
        }
        unset($category);

        // The trend starts once record-keeping is established: the first month with at least a
        // quarter of the typical monthly count. Months before that (the records ramping up)
        // would read as a surge in accidents when it is really a surge in record-keeping.
        $sorted = $city;
        sort($sorted);
        $median = $sorted[intdiv($n, 2)] ?? 0;
        $established = 0;
        while ($established < $n - 1 && $city[$established] < 0.25 * $median) {
            $established++;
        }

        $trend = [];
        $firstTrend = min($n - 1, $established + self::RECENT + self::EARLIER - 1);
        for ($i = $firstTrend; $i < $n; $i++) {
            [$score] = $at($i);
            if ($score !== null) {
                $trend[] = ['month' => $months[$i], 'score' => $score];
            }
        }

        // Per barangay: its own frequency trend, and its recent volume against the busiest
        // barangay. Averaged, so a busy-but-improving barangay is not ranked the same as a
        // busy-and-worsening one.
        $last = $n - 1;
        $hasEarlier = $n >= self::RECENT + self::EARLIER;
        $recentAvgs = [];
        foreach ($byBarangay as $name => $series) {
            $recentAvgs[$name] = self::avg($series, $last - self::RECENT + 1, $last);
        }
        $maxRecent = max(1e-9, ...array_values($recentAvgs ?: [0]));

        $barangays = [];
        foreach ($byBarangay as $name => $series) {
            $recent = $recentAvgs[$name];
            $earlier = $hasEarlier ? self::avg($series, $last - self::RECENT - self::EARLIER + 1, $last - self::RECENT) : $recent;
            $change = ($recent - $earlier) / max($earlier, self::MIN_BASE);
            $trendScore = self::clamp(50 - 100 * $change);
            $volumeScore = self::clamp(100 * (1 - $recent / $maxRecent));
            $score = (int) round(($trendScore + $volumeScore) / 2);
            $barangays[] = [
                'barangay' => $name,
                'score' => $score,
                'level' => self::level($score),
                'recentAvg' => round($recent, 1),
                'earlierAvg' => round($earlier, 1),
                'changePct' => $earlier > 0 ? (int) round(($recent - $earlier) / $earlier * 100) : null,
                'latestMonth' => $series[$last],
            ];
        }
        usort($barangays, fn ($a, $b) => $a['score'] <=> $b['score'] ?: $b['recentAvg'] <=> $a['recentAvg']);

        // Where accidents are rising: a real increase of at least one accident a month.
        $rising = array_values(array_filter($barangays, fn ($b) => $hasEarlier && $b['recentAvg'] - $b['earlierAvg'] >= 1));
        usort($rising, fn ($a, $b) => ($b['recentAvg'] - $b['earlierAvg']) <=> ($a['recentAvg'] - $a['earlierAvg']));

        return [
            'overall' => $overall,
            'level' => $overall === null ? 'No data' : self::level($overall),
            'categories' => $categories,
            'excluded' => $excluded,
            'trend' => $trend,
            'byBarangay' => $barangays,
            'rising' => array_slice($rising, 0, 8),
            'window' => [
                'recentFrom' => $months[max(0, $last - self::RECENT + 1)],
                'recentTo' => $months[$last],
                'earlierFrom' => $hasEarlier ? $months[$last - self::RECENT - self::EARLIER + 1] : null,
                'earlierTo' => $hasEarlier ? $months[$last - self::RECENT] : null,
            ],
        ];
    }

    public static function level(int $score): string
    {
        return $score >= 75 ? 'Good' : ($score >= 50 ? 'Fair' : 'Needs attention');
    }

    /** Every month from the first record to the last, with no gaps. */
    public static function monthRange(array $incidents): array
    {
        $first = null;
        $last = null;
        foreach ($incidents as $incident) {
            $month = substr((string) ($incident['date'] ?? ''), 0, 7);
            if (! preg_match('/^\d{4}-\d{2}$/', $month)) {
                continue;
            }
            $first = $first === null || $month < $first ? $month : $first;
            $last = $last === null || $month > $last ? $month : $last;
        }
        if ($first === null) {
            return [];
        }

        $months = [];
        [$y, $m] = array_map('intval', explode('-', $first));
        while (true) {
            $key = sprintf('%04d-%02d', $y, $m);
            $months[] = $key;
            if ($key >= $last) {
                break;
            }
            if (++$m > 12) {
                $m = 1;
                $y++;
            }
        }

        return $months;
    }

    private static function sum(array $series, int $from, int $to): float
    {
        $total = 0;
        for ($i = max(0, $from); $i <= $to; $i++) {
            $total += $series[$i] ?? 0;
        }

        return $total;
    }

    private static function avg(array $series, int $from, int $to): float
    {
        $from = max(0, $from);

        return $to >= $from ? self::sum($series, $from, $to) / ($to - $from + 1) : 0.0;
    }

    private static function clamp(float $value): float
    {
        return max(0.0, min(100.0, $value));
    }
}
