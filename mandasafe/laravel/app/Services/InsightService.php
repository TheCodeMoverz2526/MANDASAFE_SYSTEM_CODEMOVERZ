<?php

namespace App\Services;

/**
 * The homepage Insight card: plain-language findings written from the accident records —
 * a handful about Mandaluyong as a whole, then one for every barangay. Nothing here is
 * typed by hand; each insight is recomputed whenever the records change, so the wording
 * always matches the figures.
 *
 * Periods are counted back from the latest month on record, not from today: the records
 * arrive in batches, and "the last three months" of an empty stretch would say nothing.
 */
class InsightService
{
    private const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    private const RECENT = 3;     // months in "recently"
    private const CHART_MONTHS = 12;

    /**
     * @param  array  $incidents     every incident, as Incident::toApi() shapes them
     * @param  array  $predictions   AnalyticsService::barangayPredictions()
     * @param  array  $safety        SafetyIndexService::compute()
     */
    public static function build(array $incidents, array $predictions, array $safety): array
    {
        $months = SafetyIndexService::monthRange($incidents);
        if ($incidents === [] || $months === []) {
            return ['generatedFrom' => null, 'insights' => []];
        }

        $city = self::profile($incidents, $months);
        $byBarangay = [];
        foreach ($incidents as $incident) {
            $byBarangay[$incident['barangay'] ?: 'Unknown'][] = $incident;
        }
        $profiles = [];
        foreach ($byBarangay as $name => $rows) {
            $profiles[$name] = self::profile($rows, $months);
        }
        $forecasts = [];
        foreach ($predictions as $p) {
            $forecasts[$p['barangay']] = $p;
        }

        $insights = array_values(array_filter([
            self::cityTrend($city, $months),
            self::cityForecast($city, $months, $predictions),
            self::cityHours($city),
            self::cityDays($city),
            self::cityBarangays($profiles, count($incidents)),
            self::citySeverity($city),
            self::citySafety($safety),
            self::cityRising($safety),
        ]));

        // Barangays: the riskiest first, the same order the forecast ranks them in.
        $ranking = array_keys($profiles);
        usort($ranking, fn ($a, $b) => $profiles[$b]['total'] <=> $profiles[$a]['total']);
        $cityRank = array_flip($ranking);
        usort($ranking, fn ($a, $b) => ($forecasts[$b]['riskScore'] ?? 0) <=> ($forecasts[$a]['riskScore'] ?? 0)
            ?: $profiles[$b]['total'] <=> $profiles[$a]['total']);
        foreach ($ranking as $name) {
            if ($name === 'Unknown') {
                continue;
            }
            $insights[] = self::barangay($name, $profiles[$name], $months, $forecasts[$name] ?? null,
                $cityRank[$name] + 1, count($profiles), count($incidents));
        }

        return [
            'generatedFrom' => ['from' => $months[0], 'to' => end($months), 'records' => count($incidents)],
            'insights' => $insights,
        ];
    }

    /* ------------------------------------------------------------------ figures */

    /** Counts by month, hour, weekday and severity for one set of records. */
    private static function profile(array $rows, array $months): array
    {
        $byMonth = array_fill_keys($months, 0);
        $byHour = array_fill(0, 24, 0);
        $byDay = array_fill(0, 7, 0);
        $bySev = ['Damage' => 0, 'Injury' => 0, 'Fatal' => 0];
        $severeByMonth = array_fill_keys($months, 0);

        foreach ($rows as $row) {
            $month = substr((string) ($row['date'] ?? ''), 0, 7);
            if (isset($byMonth[$month])) {
                $byMonth[$month]++;
            }
            if (preg_match('/^(\d{1,2}):\d{2}/', (string) ($row['time'] ?? ''), $t) && (int) $t[1] < 24) {
                $byHour[(int) $t[1]]++;
            }
            $stamp = strtotime(substr((string) ($row['date'] ?? ''), 0, 10));
            if ($stamp !== false) {
                $byDay[(int) date('N', $stamp) - 1]++;
            }
            $sev = (string) ($row['sev'] ?? '');
            if ($sev === 'Minor') {
                $sev = 'Damage';
            }
            if (isset($bySev[$sev])) {
                $bySev[$sev]++;
                if ($sev !== 'Damage' && isset($severeByMonth[$month])) {
                    $severeByMonth[$month]++;
                }
            }
        }

        $series = array_values($byMonth);
        $n = count($series);
        $recent = array_sum(array_slice($series, max(0, $n - self::RECENT)));
        $earlier = $n >= 2 * self::RECENT ? array_sum(array_slice($series, $n - 2 * self::RECENT, self::RECENT)) : null;

        return [
            'total' => count($rows),
            'byMonth' => $byMonth,
            'byHour' => $byHour,
            'byDay' => $byDay,
            'bySev' => $bySev,
            'severeByMonth' => $severeByMonth,
            'latest' => $series[$n - 1] ?? 0,
            'previous' => $series[$n - 2] ?? null,
            'recent' => $recent,
            'earlier' => $earlier,
            'peakHour' => self::peak($byHour),
            'peakDay' => self::peak($byDay),
        ];
    }

    private static function peak(array $counts): ?int
    {
        $max = max($counts);

        return $max > 0 ? array_search($max, $counts, true) : null;
    }

    private static function pct(?float $now, ?float $before): ?int
    {
        return $before ? (int) round(($now - $before) / $before * 100) : null;
    }

    private static function monthLabel(string $month): string
    {
        return date('M Y', strtotime($month . '-01'));
    }

    private static function span(array $months): string
    {
        $first = reset($months);
        $last = end($months);

        return $first === $last ? self::monthLabel($first)
            : date('M', strtotime($first . '-01')) . (substr($first, 0, 4) === substr($last, 0, 4) ? '' : date(' Y', strtotime($first . '-01')))
                . '–' . self::monthLabel($last);
    }

    private static function hourLabel(int $h): string
    {
        $f = fn ($x) => ($x % 12 ?: 12) . ($x < 12 ? ' AM' : ' PM');

        return $f($h) . '–' . $f(($h + 1) % 24);
    }

    /** "▲ 12%", "▼ 5%", or "no change" — the arrows the forecast cards already use. */
    private static function change(?int $pct): string
    {
        if ($pct === null) {
            return 'no earlier period to compare';
        }

        return $pct === 0 ? 'no change' : ($pct > 0 ? '▲ ' : '▼ ') . abs($pct) . '%';
    }

    private static function share(int $part, int $whole): string
    {
        return $whole ? (round($part / $whole * 1000) / 10) . '%' : '0%';
    }

    /** The last CHART_MONTHS months as a line chart. */
    private static function monthChart(array $byMonth, string $title): array
    {
        $tail = array_slice($byMonth, -self::CHART_MONTHS, null, true);

        return [
            'kind' => 'line',
            'title' => $title,
            'labels' => array_map(fn ($m) => date('M y', strtotime($m . '-01')), array_keys($tail)),
            'values' => array_values($tail),
            'highlight' => count($tail) - 1,
        ];
    }

    private static function hourChart(array $byHour, ?int $peak): array
    {
        return [
            'kind' => 'bars',
            'title' => 'Accidents by hour of day',
            'labels' => array_map(fn ($h) => ($h % 12 ?: 12) . ($h < 12 ? 'a' : 'p'), range(0, 23)),
            'values' => $byHour,
            'highlight' => $peak,
        ];
    }

    private static function dayChart(array $byDay, ?int $peak): array
    {
        return [
            'kind' => 'bars',
            'title' => 'Accidents by day of the week',
            'labels' => array_map(fn ($d) => substr($d, 0, 3), self::DAYS),
            'values' => $byDay,
            'highlight' => $peak,
        ];
    }

    /** Rush-hour share: 7–10 AM and 5–9 PM, the city's commuting peaks. */
    private static function rushShare(array $byHour): float
    {
        $total = array_sum($byHour);
        $rush = array_sum(array_slice($byHour, 7, 3)) + array_sum(array_slice($byHour, 17, 4));

        return $total ? $rush / $total : 0;
    }

    /**
     * What usually drives road accidents at a given hour, and what the city can do about it.
     * The records say when and where accidents happened, not why, so these are the common
     * reasons for the pattern — the pages present them as possible causes, never as findings.
     *
     * @return array{period: string, causes: array, solutions: array}
     */
    private static function hourContext(int $h): array
    {
        if ($h >= 6 && $h <= 9) {
            return [
                'period' => 'the morning rush',
                'causes' => [
                    ['title' => 'Heavy commuter volume', 'text' => 'Workers and students head to Ortigas, Makati and Manila at the same time, so main roads like EDSA, Shaw Blvd and Boni Ave run at full capacity and small mistakes turn into collisions.'],
                    ['title' => 'Rushing and aggressive driving', 'text' => 'Drivers running late tailgate, cut lanes and beat red lights; motorcycles weave between slow lanes.'],
                    ['title' => 'Loading and unloading outside stops', 'text' => 'Jeepneys, buses and tricycles stopping wherever passengers wait force sudden braking and lane changes behind them.'],
                ],
                'solutions' => [
                    'Post traffic enforcers at the busiest intersections from 6 to 10 AM, before queues build up.',
                    'Enforce designated loading bays for jeepneys and buses, with no-stopping zones at intersections.',
                    'Review signal timing on the main corridors for morning flows.',
                ],
            ];
        }
        if ($h >= 10 && $h <= 14) {
            return [
                'period' => 'midday',
                'causes' => [
                    ['title' => 'Commercial and delivery traffic', 'text' => 'Trucks, delivery vans and riders make their rounds around malls, markets and offices, double-parking and stopping in traffic lanes.'],
                    ['title' => 'Errands and lunch trips', 'text' => 'Short trips in and out of parking areas and side streets create many conflict points at driveways and corners.'],
                    ['title' => 'Pedestrians crossing outside lanes', 'text' => 'Foot traffic peaks around commercial areas at midday, and crossings away from pedestrian lanes are common.'],
                ],
                'solutions' => [
                    'Set loading windows and clear no-parking zones for delivery vehicles on busy streets.',
                    'Paint and light pedestrian crossings near malls, markets and offices; add barriers where people jaywalk.',
                    'Run roving enforcement against double-parking and obstruction at midday.',
                ],
            ];
        }
        if ($h >= 15 && $h <= 16) {
            return [
                'period' => 'the mid-afternoon',
                'causes' => [
                    ['title' => 'School dismissal', 'text' => 'Many schools let out between 3 and 5 PM: school service vans, parents picking up children and students crossing the street crowd the roads near campuses.'],
                    ['title' => 'Traffic building up before the evening rush', 'text' => 'Early commuters, delivery vehicles finishing routes and PUVs repositioning all overlap, so volume rises fast while drivers still move at midday speeds.'],
                    ['title' => 'Fatigue and heat', 'text' => 'By mid-afternoon drivers and riders have been on the road for hours; tiredness and the heat slow reactions.'],
                ],
                'solutions' => [
                    'Deploy enforcers and crossing guards at school zones from 2:30 to 5 PM.',
                    'Enforce school-zone speed limits and drop-off rules for school service vehicles.',
                    'Start evening-rush enforcement earlier, at 3 PM instead of 5 PM, at the known hotspots.',
                ],
            ];
        }
        if ($h >= 17 && $h <= 20) {
            return [
                'period' => 'the evening rush',
                'causes' => [
                    ['title' => 'Peak traffic going home', 'text' => 'The heaviest flows of the day leave the business districts through the city, and stop-and-go queues on main roads produce rear-end and side-swipe collisions.'],
                    ['title' => 'Fading light and fatigue', 'text' => 'Dusk lowers visibility while drivers are tired after work; pedestrians and riders without lights are harder to see.'],
                    ['title' => 'Crowded PUV stops', 'text' => 'Long lines for jeepneys and buses spill onto the road, and vehicles stop anywhere to pick up passengers.'],
                ],
                'solutions' => [
                    'Keep enforcers on the main corridors from 5 to 9 PM, focused on the hotspots on the map.',
                    'Organise PUV loading at designated stops with marshals during the evening peak.',
                    'Check that street lights and pedestrian crossings on the main roads are working and visible.',
                ],
            ];
        }

        return [
            'period' => 'late night',
            'causes' => [
                ['title' => 'Speeding on empty roads', 'text' => 'With little traffic, drivers and riders go much faster than the limit, which makes any collision more serious.'],
                ['title' => 'Low visibility', 'text' => 'Dark stretches, unlit vehicles and pedestrians in dark clothing are hard to see in time.'],
                ['title' => 'Drunk, sleepy or tired driving', 'text' => 'Late-night trips include more drivers who have been drinking or are short on sleep.'],
            ],
            'solutions' => [
                'Run night-time speed and drunk-driving checkpoints at the hotspots.',
                'Repair and add street lights on dark stretches where accidents cluster.',
                'Install rumble strips and reflective markings before dangerous intersections.',
            ],
        ];
    }

    /* ------------------------------------------------------------------ city */

    private static function cityTrend(array $city, array $months): array
    {
        $latest = end($months);
        $monthPct = self::pct($city['latest'], $city['previous']);
        $quarterPct = self::pct($city['recent'], $city['earlier']);
        $recentSpan = self::span(array_slice($months, -self::RECENT));
        $level = $quarterPct === null ? 'info' : ($quarterPct >= 10 ? 'alert' : ($quarterPct <= -10 ? 'good' : 'watch'));
        $direction = $quarterPct === null ? '' : ($quarterPct > 0 ? 'more' : 'fewer');

        return [
            'id' => 'city-trend',
            'scope' => 'city',
            'barangay' => null,
            'topic' => 'Monthly trend',
            'level' => $level,
            'title' => sprintf('%s accidents recorded in %s', number_format($city['latest']), self::monthLabel($latest)),
            'headline' => sprintf('%s from %s', self::change($monthPct), $city['previous'] === null ? 'the month before' : number_format($city['previous']) . ' the month before'),
            'body' => sprintf(
                'Mandaluyong recorded %s road accidents in %s, the latest month on record. Over %s the city logged %s accidents%s. ' .
                'Month-to-month numbers move around, so the three-month comparison is the steadier sign of where the city is heading.',
                number_format($city['latest']), self::monthLabel($latest), $recentSpan, number_format($city['recent']),
                $quarterPct === null ? '' : sprintf(' — %d%% %s than the three months before (%s)', abs($quarterPct), $direction, number_format($city['earlier']))
            ),
            'stats' => [
                ['label' => self::monthLabel($latest), 'value' => number_format($city['latest'])],
                ['label' => 'Month before', 'value' => $city['previous'] === null ? '—' : number_format($city['previous'])],
                ['label' => 'Last 3 months', 'value' => number_format($city['recent'])],
                ['label' => '3 months before', 'value' => $city['earlier'] === null ? '—' : number_format($city['earlier'])],
                ['label' => 'Average per month', 'value' => number_format($city['total'] / max(1, count($months)), 1)],
                ['label' => 'All recorded', 'value' => number_format($city['total'])],
            ],
            'charts' => [self::monthChart($city['byMonth'], 'Accidents per month, citywide')],
            'causes' => array_values(array_filter([
                in_array((int) substr($latest, 5, 2), [6, 7, 8, 9, 10, 11], true)
                    ? ['title' => 'Rainy season', 'text' => 'June to November brings wet, slippery roads, flooding and poor visibility, which raise stopping distances and cause skids — and push more people into cars and onto crowded roads.']
                    : null,
                in_array((int) substr($latest, 5, 2), [11, 12, 1], true)
                    ? ['title' => 'Holiday season', 'text' => 'Shopping, parties and year-end travel put more vehicles and pedestrians around malls and markets, often late at night.']
                    : null,
                $quarterPct !== null && $quarterPct > 0
                    ? ['title' => 'More traffic or new disruptions', 'text' => 'A rise across several months usually follows more vehicles on the road, road works or closures that push traffic onto side streets, or new developments that draw crowds.']
                    : ['title' => 'Enforcement, works finished or fewer trips', 'text' => 'A fall can follow stricter enforcement, finished road works, holidays or class breaks that take trips off the road — or records still being added for the latest month.'],
                ['title' => 'Through-traffic', 'text' => 'Mandaluyong sits between Ortigas, Makati, San Juan and Manila, so much of its traffic only passes through on EDSA, Shaw Blvd, Boni Ave and Ortigas Ave.'],
            ])),
            'solutions' => [
                'Review this trend every month and move enforcers to the barangays where accidents are rising (see the barangay insights).',
                'Schedule road works and closures outside the busiest months, and announce reroutes early.',
                'Clear drainage and repaint lane markings before the rainy season starts.',
            ],
            'tips' => $quarterPct !== null && $quarterPct > 0
                ? ['Accidents are rising citywide — leave earlier and avoid rushing through intersections.', 'Check the barangay insights to see which areas drive the increase.']
                : ['Keep it up: follow speed limits and traffic signs even on familiar routes.', 'Check the barangay insights for areas that still need extra care.'],
        ];
    }

    private static function cityForecast(array $city, array $months, array $predictions): ?array
    {
        if ($predictions === []) {
            return null;
        }
        $next = (int) round(array_sum(array_column($predictions, 'predictedNextMonth')));
        $nextMonth = $predictions[0]['forecastMonth'] ?? date('Y-m', strtotime(end($months) . '-01 +1 month'));
        $pct = self::pct($next, $city['latest']);
        $high = array_values(array_filter($predictions, fn ($p) => ($p['riskLevel'] ?? '') === 'high'));
        $rising = array_values(array_filter($predictions, fn ($p) => ($p['trend'] ?? '') === 'up'));

        // Recorded months, then the next three forecast months summed over every barangay.
        $tail = array_slice($city['byMonth'], -9, null, true);
        $labels = array_map(fn ($m) => date('M y', strtotime($m . '-01')), array_keys($tail));
        $values = array_values($tail);
        $forecastMonths = array_slice($predictions[0]['forecastMonths'] ?? [$nextMonth], 0, 3);
        foreach ($forecastMonths as $i => $month) {
            $labels[] = date('M y', strtotime($month . '-01'));
            $values[] = (int) round(array_sum(array_map(fn ($p) => $p['forecastPath'][$i] ?? $p['predictedNextMonth'], $predictions)));
        }

        return [
            'id' => 'city-forecast',
            'scope' => 'city',
            'barangay' => null,
            'topic' => 'Forecast',
            'level' => $pct !== null && $pct >= 10 ? 'alert' : 'watch',
            'title' => sprintf('About %s accidents expected in %s', number_format($next), self::monthLabel($nextMonth)),
            'headline' => sprintf('%s against %s', self::change($pct), self::monthLabel(end($months))),
            'body' => sprintf(
                'MandaSafe\'s forecast model expects roughly %s road accidents across Mandaluyong in %s, compared with %s in %s. ' .
                '%s rated high risk for next month%s. A forecast is an estimate from past patterns, not a certainty.',
                number_format($next), self::monthLabel($nextMonth), number_format($city['latest']), self::monthLabel(end($months)),
                count($high) === 0 ? 'No barangay is' : (count($high) === 1 ? 'One barangay is' : count($high) . ' barangays are'),
                $high === [] ? '' : ': ' . implode(', ', array_map(fn ($p) => $p['barangay'], array_slice($high, 0, 5)))
            ),
            'stats' => [
                ['label' => 'Expected ' . self::monthLabel($nextMonth), 'value' => number_format($next)],
                ['label' => 'Recorded ' . self::monthLabel(end($months)), 'value' => number_format($city['latest'])],
                ['label' => 'High-risk barangays', 'value' => (string) count($high)],
                ['label' => 'Barangays trending up', 'value' => (string) count($rising)],
            ],
            'charts' => [[
                'kind' => 'line',
                'title' => 'Recorded months, then the forecast',
                'labels' => $labels,
                'values' => $values,
                'highlight' => count($tail),
                'forecastFrom' => count($tail),
            ]],
            'causes' => [
                ['title' => 'Recent months carry forward', 'text' => 'The forecast learns from each barangay\'s recent months, its long-run trend and the season. If the last few months were busy, it expects the next one to be busy too.'],
                ['title' => 'Where the risk is concentrated', 'text' => sprintf('Most of the expected accidents come from a few barangays: %s.',
                    implode(', ', array_map(fn ($p) => sprintf('%s (~%d)', $p['barangay'], $p['predictedNextMonth']), array_slice($predictions, 0, 3))))],
                ['title' => 'What the forecast cannot see', 'text' => 'It does not know about planned road works, events or new enforcement, so the real number can differ.'],
            ],
            'solutions' => [
                'Assign enforcers for next month in proportion to each barangay\'s forecast, starting with the high-risk ones.',
                'Plan road works, events and closures away from the high-risk barangays during the forecast month.',
                'Compare the forecast with the actual count each month to see whether actions taken are working.',
            ],
            'tips' => ['Sign in and open the Forecast page for every barangay and up to 12 months ahead.',
                'Plan trips through high-risk barangays outside rush hour when you can.'],
        ];
    }

    private static function cityHours(array $city): ?array
    {
        if ($city['peakHour'] === null) {
            return null;
        }
        $h = $city['peakHour'];
        $rush = self::rushShare($city['byHour']);
        $night = array_sum(array_slice($city['byHour'], 0, 5)) + $city['byHour'][23] + $city['byHour'][22];
        $total = array_sum($city['byHour']);

        return [
            'id' => 'city-hours',
            'scope' => 'city',
            'barangay' => null,
            'topic' => 'Time of day',
            'level' => 'watch',
            'title' => sprintf('Most accidents happen between %s', self::hourLabel($h)),
            'headline' => sprintf('%s of accidents fall in the morning and evening rush', self::share((int) round($rush * $total), $total)),
            'body' => sprintf(
                'Across every record, the single busiest hour for road accidents in Mandaluyong is %s, with %s accidents. ' .
                'The morning rush (7–10 AM) and evening rush (5–9 PM) together account for %s of all accidents, while late night (10 PM–5 AM) accounts for %s.',
                self::hourLabel($h), number_format($city['byHour'][$h]), self::share((int) round($rush * $total), $total), self::share($night, $total)
            ),
            'stats' => [
                ['label' => 'Peak hour', 'value' => self::hourLabel($h)],
                ['label' => 'Accidents in peak hour', 'value' => number_format($city['byHour'][$h])],
                ['label' => 'Rush-hour share', 'value' => self::share((int) round($rush * $total), $total)],
                ['label' => 'Late-night share', 'value' => self::share($night, $total)],
            ],
            'charts' => [self::hourChart($city['byHour'], $h)],
            'causes' => self::hourContext($h)['causes'],
            'solutions' => self::hourContext($h)['solutions'],
            'tips' => ['Give yourself extra travel time during the rush hours.', 'At night, slow down and watch for pedestrians and unlit vehicles.'],
        ];
    }

    private static function cityDays(array $city): ?array
    {
        if ($city['peakDay'] === null) {
            return null;
        }
        $d = $city['peakDay'];
        $quiet = array_search(min($city['byDay']), $city['byDay'], true);
        $total = array_sum($city['byDay']);
        $weekend = $city['byDay'][5] + $city['byDay'][6];

        return [
            'id' => 'city-days',
            'scope' => 'city',
            'barangay' => null,
            'topic' => 'Day of the week',
            'level' => 'info',
            'title' => sprintf('%s is the busiest day for accidents', self::DAYS[$d]),
            'headline' => sprintf('%s accidents on %ss vs %s on %ss', number_format($city['byDay'][$d]), self::DAYS[$d], number_format($city['byDay'][$quiet]), self::DAYS[$quiet]),
            'body' => sprintf(
                '%ss have the most recorded accidents in Mandaluyong (%s of the total) and %ss the fewest (%s). Weekends account for %s of all accidents.',
                self::DAYS[$d], self::share($city['byDay'][$d], $total), self::DAYS[$quiet], self::share($city['byDay'][$quiet], $total), self::share($weekend, $total)
            ),
            'stats' => [
                ['label' => 'Busiest day', 'value' => self::DAYS[$d]],
                ['label' => 'Quietest day', 'value' => self::DAYS[$quiet]],
                ['label' => 'Weekday share', 'value' => self::share($total - $weekend, $total)],
                ['label' => 'Weekend share', 'value' => self::share($weekend, $total)],
            ],
            'charts' => [self::dayChart($city['byDay'], $d)],
            'causes' => [
                ['title' => 'Work and school days', 'text' => 'Weekdays carry commuting, school runs and business deliveries all at once, while Sundays have the fewest trips.'],
                $d >= 5
                    ? ['title' => 'Weekend outings', 'text' => 'Malls, churches, markets and night spots draw heavy weekend traffic, with more drinking and late-night driving.']
                    : ['title' => 'Mid-week peak', 'text' => sprintf('Office attendance, meetings and deliveries tend to peak mid-week, so %s gathers the most vehicles on the road.', self::DAYS[$d])],
            ],
            'solutions' => [
                sprintf('Schedule the most enforcers on %ss and the fewest on %ss, instead of the same strength every day.', self::DAYS[$d], self::DAYS[$quiet]),
                sprintf('Avoid planned road works and closures on %ss.', self::DAYS[$d]),
            ],
            'tips' => [sprintf('Be extra careful on %ss, especially during the rush hours.', self::DAYS[$d])],
        ];
    }

    private static function cityBarangays(array $profiles, int $total): ?array
    {
        unset($profiles['Unknown']);
        if ($profiles === []) {
            return null;
        }
        uasort($profiles, fn ($a, $b) => $b['total'] <=> $a['total']);
        $top = array_slice($profiles, 0, 8, true);
        $first = array_key_first($top);
        $top5 = array_sum(array_column(array_slice($profiles, 0, 5), 'total'));

        return [
            'id' => 'city-barangays',
            'scope' => 'city',
            'barangay' => null,
            'topic' => 'Where accidents happen',
            'level' => 'watch',
            'title' => sprintf('%s has the most accidents in the city', $first),
            'headline' => sprintf('The top 5 barangays hold %s of all accidents', self::share($top5, $total)),
            'body' => sprintf(
                '%s accounts for %s of every recorded accident in Mandaluyong (%s accidents). Accidents are concentrated: the five busiest barangays — %s — together hold %s of the city total, out of %d barangays with records.',
                $first, self::share($profiles[$first]['total'], $total), number_format($profiles[$first]['total']),
                implode(', ', array_keys(array_slice($profiles, 0, 5, true))), self::share($top5, $total), count($profiles)
            ),
            'stats' => array_map(fn ($name) => ['label' => $name, 'value' => number_format($profiles[$name]['total'])], array_keys(array_slice($profiles, 0, 6, true))),
            'charts' => [[
                'kind' => 'hbars',
                'title' => 'Barangays with the most accidents',
                'labels' => array_keys($top),
                'values' => array_column($top, 'total'),
                'highlight' => 0,
            ]],
            'causes' => [
                ['title' => 'Business districts and malls', 'text' => sprintf('The busiest barangays, led by %s, hold business districts, malls and offices that draw people from all over Metro Manila every day.', $first)],
                ['title' => 'Major roads', 'text' => 'They are crossed by EDSA, Shaw Blvd, Ortigas Ave and Boni Ave, where through-traffic, buses and motorcycles mix with local trips.'],
                ['title' => 'Many conflict points', 'text' => 'Mall entrances, parking exits, U-turn slots and PUV stops close together create constant merging and crossing.'],
            ],
            'solutions' => [
                sprintf('Concentrate enforcement and road-safety audits on %s and the other top barangays.', $first),
                'Fix the worst intersections first: signal phasing, clear lane markings, protected pedestrian crossings.',
                'Work with malls and offices on traffic marshals at their entrances during peak hours.',
            ],
            'tips' => ['Busy commercial barangays see the most traffic — and the most accidents. Stay alert there.'],
        ];
    }

    private static function citySeverity(array $city): ?array
    {
        $sev = $city['bySev'];
        $total = array_sum($sev);
        // A column where every record has the same value is not being recorded.
        if ($total === 0 || count(array_filter($sev)) < 2) {
            return null;
        }
        $severe = $sev['Injury'] + $sev['Fatal'];
        $recentSevere = array_sum(array_slice($city['severeByMonth'], -self::CHART_MONTHS));

        return [
            'id' => 'city-severity',
            'scope' => 'city',
            'barangay' => null,
            'topic' => 'Severity',
            'level' => $sev['Fatal'] > 0 ? 'alert' : 'watch',
            'title' => sprintf('%s of accidents caused injury or death', self::share($severe, $total)),
            'headline' => sprintf('%s fatal and %s injury accidents on record', number_format($sev['Fatal']), number_format($sev['Injury'])),
            'body' => sprintf(
                'Most recorded accidents in Mandaluyong caused property damage only (%s). %s caused injuries and %s were fatal. ' .
                'In the last 12 months on record, %s accidents involved an injury or a death.',
                self::share($sev['Damage'], $total), number_format($sev['Injury']), number_format($sev['Fatal']), number_format($recentSevere)
            ),
            'stats' => [
                ['label' => 'Damage only', 'value' => number_format($sev['Damage'])],
                ['label' => 'Injury', 'value' => number_format($sev['Injury'])],
                ['label' => 'Fatal', 'value' => number_format($sev['Fatal'])],
                ['label' => 'Injury or fatal, last 12 mo.', 'value' => number_format($recentSevere)],
            ],
            'charts' => [
                ['kind' => 'hbars', 'title' => 'Accidents by severity', 'labels' => ['Damage only', 'Injury', 'Fatal'],
                    'values' => [$sev['Damage'], $sev['Injury'], $sev['Fatal']], 'highlight' => 2],
                self::monthChart($city['severeByMonth'], 'Injury and fatal accidents per month'),
            ],
            'causes' => [
                ['title' => 'Unprotected road users', 'text' => 'Motorcycle riders, cyclists and pedestrians have no protection in a crash, so collisions involving them are far more likely to cause injury or death.'],
                ['title' => 'Speed', 'text' => 'The faster a vehicle goes, the harder the impact — which is why late-night accidents on empty roads are often the most serious.'],
                ['title' => 'No helmet or seatbelt', 'text' => 'Riding without a proper helmet or not buckling up turns minor crashes into injuries.'],
            ],
            'solutions' => [
                'Strictly enforce helmet and seatbelt laws, with regular checkpoints.',
                'Build safer crossings — pedestrian lanes with signals, refuge islands, footbridges where needed.',
                'Lower and enforce speed limits near schools, markets and residential streets.',
                'Keep emergency response quick: ambulances and responders stationed near the barangays with the most injuries.',
            ],
            'tips' => ['Always wear a helmet and seatbelt — they turn many injuries into damage-only accidents.',
                'Slow down near schools, markets and crossings, where pedestrians are most at risk.'],
        ];
    }

    private static function citySafety(array $safety): ?array
    {
        if ($safety['overall'] === null) {
            return null;
        }
        $score = (int) $safety['overall'];
        $categories = $safety['categories'] ?? [];

        return [
            'id' => 'city-safety',
            'scope' => 'city',
            'barangay' => null,
            'topic' => 'Safety index',
            'level' => $score >= 75 ? 'good' : ($score >= 50 ? 'watch' : 'alert'),
            'title' => sprintf('Mandaluyong road safety index: %d / 100', $score),
            'headline' => sprintf('Rated "%s"', $safety['level']),
            'body' => sprintf(
                'The MandaSafe Safety Index scores how safe the city\'s roads have been lately, from 0 (worst) to 100 (best). It is currently %d, rated "%s". ' .
                'It combines %s.',
                $score, $safety['level'],
                $categories === [] ? 'the available measures' : implode(', ', array_map(fn ($c) => strtolower($c['name']) . ' (' . $c['score'] . ')', $categories))
            ),
            'stats' => array_merge(
                [['label' => 'Overall', 'value' => $score . ' / 100']],
                array_map(fn ($c) => ['label' => $c['name'], 'value' => $c['score'] . ' / 100'], $categories)
            ),
            'charts' => $categories === [] ? [] : [[
                'kind' => 'hbars',
                'title' => 'Safety index by measure (higher is safer)',
                'labels' => array_column($categories, 'name'),
                'values' => array_column($categories, 'score'),
                'highlight' => null,
                'max' => 100,
            ]],
            'causes' => array_map(fn ($c) => [
                'title' => sprintf('%s: %d / 100', $c['name'], $c['score']),
                'text' => trim($c['why'] . ($c['detail'] !== '' ? ' — ' . $c['detail'] : '') . '.'),
            ], $categories),
            'solutions' => array_values(array_filter([
                $categories === [] ? null : sprintf('Start with the weakest measure, %s, since it pulls the overall score down the most.',
                    strtolower(array_reduce($categories, fn ($low, $c) => $low === null || $c['score'] < $low['score'] ? $c : $low)['name'])),
                'Track the index every month after each action to see whether it is working.',
            ])),
            'tips' => ['Sign in and open the Safety Index page to see each barangay\'s score.'],
        ];
    }

    private static function cityRising(array $safety): ?array
    {
        $rising = $safety['rising'] ?? [];
        if ($rising === []) {
            return null;
        }
        $window = $safety['window'] ?? [];

        return [
            'id' => 'city-rising',
            'scope' => 'city',
            'barangay' => null,
            'topic' => 'Rising areas',
            'level' => 'alert',
            'title' => sprintf('%d barangay%s with rising accidents', count($rising), count($rising) === 1 ? '' : 's'),
            'headline' => sprintf('Led by %s', $rising[0]['barangay']),
            'body' => sprintf(
                'These barangays averaged at least one more accident a month in %s than in %s: %s.',
                self::span(array_filter([$window['recentFrom'] ?? null, $window['recentTo'] ?? null])),
                self::span(array_filter([$window['earlierFrom'] ?? null, $window['earlierTo'] ?? null])),
                implode(', ', array_map(fn ($b) => sprintf('%s (%s → %s a month)', $b['barangay'], $b['earlierAvg'], $b['recentAvg']), $rising))
            ),
            'stats' => array_map(fn ($b) => ['label' => $b['barangay'], 'value' => sprintf('%s → %s / mo', $b['earlierAvg'], $b['recentAvg'])], array_slice($rising, 0, 6)),
            'charts' => [[
                'kind' => 'hbars',
                'title' => 'Extra accidents per month, recent vs earlier',
                'labels' => array_column($rising, 'barangay'),
                'values' => array_map(fn ($b) => round($b['recentAvg'] - $b['earlierAvg'], 1), $rising),
                'highlight' => 0,
            ]],
            'causes' => [
                ['title' => 'Something changed on the ground', 'text' => 'A steady rise in one barangay usually follows a local change: road works or a closure diverting traffic there, a new development or business drawing crowds, or a new route used by PUVs.'],
                ['title' => 'Less enforcement', 'text' => 'Enforcers moved elsewhere can leave a barangay with more violations and more crashes.'],
            ],
            'solutions' => [
                'Inspect the rising barangays on the ground to find what changed, using the accident spots on the GIS map.',
                'Put temporary enforcement there until the monthly count comes back down.',
                'Check whether any road closure or reroute sent traffic into these barangays, and adjust it.',
            ],
            'tips' => ['Take extra care when passing through these barangays until the numbers come back down.'],
        ];
    }

    /* ------------------------------------------------------------------ barangay */

    private static function barangay(string $name, array $p, array $months, ?array $forecast, int $rank, int $ranked, int $cityTotal): array
    {
        $recentSpan = self::span(array_slice($months, -self::RECENT));
        $pct = self::pct($p['recent'], $p['earlier']);
        $risk = $forecast['riskLevel'] ?? null;
        $level = $risk === 'high' ? 'alert' : ($risk === 'medium' ? 'watch' : ($risk === 'low' ? 'good' : 'info'));
        // A low forecast still deserves a flag when accidents jumped lately (and not by one or two).
        if ($level === 'good' && $pct !== null && $pct >= 25 && $p['recent'] - $p['earlier'] >= 5) {
            $level = 'watch';
        }
        $severe = $p['bySev']['Injury'] + $p['bySev']['Fatal'];
        $h = $p['peakHour'];
        $d = $p['peakDay'];

        $sentences = [sprintf(
            '%s recorded %s road accident%s in %s%s, and %s in all — %s of the city total, ranking #%d of %d barangays.',
            $name, number_format($p['recent']), $p['recent'] === 1 ? '' : 's', $recentSpan,
            $pct === null ? '' : sprintf(' (%s compared with the three months before)', self::change($pct)),
            number_format($p['total']), self::share($p['total'], $cityTotal), $rank, $ranked
        )];
        if ($h !== null && $d !== null) {
            $sentences[] = sprintf('Accidents here happen most often between %s and on %ss.', self::hourLabel($h), self::DAYS[$d]);
        }
        if ($severe > 0) {
            $sentences[] = sprintf('%s of its accidents caused injury or death (%s injury, %s fatal).',
                self::share($severe, $p['total']), number_format($p['bySev']['Injury']), number_format($p['bySev']['Fatal']));
        }
        if ($forecast) {
            $sentences[] = sprintf('The forecast expects about %s accidents in %s, a %s risk rating (score %s / 10).',
                number_format($forecast['predictedNextMonth']), self::monthLabel($forecast['forecastMonth'] ?? end($months)),
                ['high' => 'high', 'medium' => 'moderate', 'low' => 'low'][$risk] ?? 'unrated',
                number_format((float) $forecast['riskScore'], 1));
        }

        $tips = [];
        if ($h !== null) {
            $tips[] = $h >= 22 || $h < 5
                ? sprintf('Most accidents here happen late at night (%s): slow down and use your headlights.', self::hourLabel($h))
                : sprintf('Expect heavier risk around %s — allow extra time or travel outside that hour.', self::hourLabel($h));
        }
        if ($pct !== null && $pct >= 10) {
            $tips[] = 'Accidents are rising here — drive defensively and watch the intersections.';
        }
        if ($p['bySev']['Fatal'] > 0) {
            $tips[] = 'Fatal accidents have happened here: wear a helmet or seatbelt every trip.';
        }
        $tips[] = 'Use the GIS map below to see exactly where these accidents happened.';

        $context = $h === null ? null : self::hourContext($h);
        $causes = $context ? array_slice($context['causes'], 0, 2) : [];
        if ($p['total'] / max(1, $cityTotal) >= 0.08) {
            array_unshift($causes, ['title' => 'A busy part of the city', 'text' => sprintf('%s has %s of all the city\'s accidents — a sign of heavy traffic from major roads, commercial areas or both passing through it.', $name, self::share($p['total'], $cityTotal))]);
        }
        if ($pct !== null && $pct >= 25 && $p['recent'] - $p['earlier'] >= 5) {
            $causes[] = ['title' => 'A recent jump', 'text' => sprintf('Accidents rose %d%% in the last three months. A rise this sharp usually follows a local change such as road works, a closure, a new development or a new PUV route.', $pct)];
        }
        if ($p['bySev']['Fatal'] > 0) {
            $causes[] = ['title' => 'Serious crashes', 'text' => sprintf('Fatal accidents on record here (%s) point to high speeds or unprotected road users — riders and pedestrians.', number_format($p['bySev']['Fatal']))];
        }
        $solutions = array_values(array_filter([
            $h === null ? null : sprintf('Deploy enforcers in %s around %s, the hour with the most accidents here.', $name, self::hourLabel($h)),
            'Inspect the accident spots on the GIS map: check signs, lane markings, street lights and pedestrian crossings there.',
            $context['solutions'][1] ?? null,
            $pct !== null && $pct >= 25 ? 'Find out what changed recently (works, closures, new routes) and correct it while the rise is still fresh.' : null,
        ]));

        return [
            'id' => 'brgy-' . trim(preg_replace('/[^a-z0-9]+/', '-', strtolower($name)), '-'),
            'scope' => 'barangay',
            'barangay' => $name,
            'topic' => 'Barangay report',
            'level' => $level,
            'title' => sprintf('%s: %s accident%s in %s', $name, number_format($p['recent']), $p['recent'] === 1 ? '' : 's', $recentSpan),
            'headline' => $pct === null ? sprintf('%s recorded in all', number_format($p['total']))
                : sprintf('%s vs the 3 months before', self::change($pct)),
            'body' => implode(' ', $sentences),
            'stats' => array_values(array_filter([
                ['label' => 'Last 3 months', 'value' => number_format($p['recent'])],
                ['label' => 'All recorded', 'value' => number_format($p['total'])],
                ['label' => 'Share of city', 'value' => self::share($p['total'], $cityTotal)],
                ['label' => 'City rank', 'value' => "#{$rank} of {$ranked}"],
                $h === null ? null : ['label' => 'Peak hour', 'value' => self::hourLabel($h)],
                $d === null ? null : ['label' => 'Peak day', 'value' => self::DAYS[$d]],
                ['label' => 'Injury / fatal', 'value' => number_format($p['bySev']['Injury']) . ' / ' . number_format($p['bySev']['Fatal'])],
                $forecast ? ['label' => 'Expected next month', 'value' => number_format($forecast['predictedNextMonth'])] : null,
                $forecast ? ['label' => 'Risk score', 'value' => number_format((float) $forecast['riskScore'], 1) . ' / 10'] : null,
            ])),
            'charts' => [
                self::monthChart($p['byMonth'], 'Accidents per month in ' . $name),
                self::hourChart($p['byHour'], $h),
            ],
            'causes' => $causes,
            'solutions' => $solutions,
            'tips' => $tips,
        ];
    }
}
