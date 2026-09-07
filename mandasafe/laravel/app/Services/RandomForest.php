<?php

namespace App\Services;

/**
 * A small dependency-free Random Forest classifier (bagged CART trees with per-node random
 * feature subsets), used to classify incident severity from contextual features (barangay,
 * road, type, hour, day-of-week, month). A direct port of randomForest.js — no external ML
 * package is installed in this project, so this implements the standard algorithm directly.
 *
 * Features are given as [['key' => 'barangay', 'type' => 'categorical'], ...].
 */
class RandomForest
{
    private static function gini(array $rows, string $labelKey, array $classes): float
    {
        $n = count($rows);
        if ($n === 0) {
            return 0.0;
        }

        $counts = array_fill_keys($classes, 0);
        foreach ($rows as $row) {
            $label = $row[$labelKey];
            if (isset($counts[$label])) {
                $counts[$label]++;
            }
        }

        $impurity = 1.0;
        foreach ($classes as $class) {
            $p = $counts[$class] / $n;
            $impurity -= $p * $p;
        }

        return $impurity;
    }

    /** @return array{0: array, 1: array} the left and right partitions */
    private static function splitRows(array $rows, array $feature, $value): array
    {
        $left = [];
        $right = [];
        $key = $feature['key'];
        $numeric = $feature['type'] === 'numeric';

        foreach ($rows as $row) {
            $goLeft = $numeric ? ((float) $row[$key] <= (float) $value) : ($row[$key] === $value);
            if ($goLeft) {
                $left[] = $row;
            } else {
                $right[] = $row;
            }
        }

        return [$left, $right];
    }

    /** Draws `count` distinct features at random — the "random subspace" half of the forest. */
    private static function sampleFeatures(array $features, int $count): array
    {
        $pool = $features;
        $picked = [];

        while (count($picked) < $count && $pool !== []) {
            $index = random_int(0, count($pool) - 1);
            $picked[] = $pool[$index];
            array_splice($pool, $index, 1);
        }

        return $picked;
    }

    private static function findBestSplit(array $rows, array $features, string $labelKey, array $classes, int $featureSampleSize): ?array
    {
        $candidates = self::sampleFeatures($features, $featureSampleSize);
        $parentImpurity = self::gini($rows, $labelKey, $classes);
        $total = count($rows);
        $best = null;

        foreach ($candidates as $feature) {
            $seen = [];
            $values = [];
            foreach ($rows as $row) {
                $value = $row[$feature['key']];
                if (! array_key_exists((string) $value, $seen)) {
                    $seen[(string) $value] = true;
                    $values[] = $value;
                }
            }

            foreach ($values as $value) {
                [$left, $right] = self::splitRows($rows, $feature, $value);
                if ($left === [] || $right === []) {
                    continue;
                }

                $weighted = (count($left) / $total) * self::gini($left, $labelKey, $classes)
                    + (count($right) / $total) * self::gini($right, $labelKey, $classes);
                $gain = $parentImpurity - $weighted;

                if ($best === null || $gain > $best['gain']) {
                    $best = ['feature' => $feature, 'value' => $value, 'gain' => $gain, 'left' => $left, 'right' => $right];
                }
            }
        }

        return ($best !== null && $best['gain'] > 1e-9) ? $best : null;
    }

    private static function leafDistribution(array $rows, string $labelKey, array $classes): array
    {
        $n = count($rows) ?: 1;
        $distribution = array_fill_keys($classes, 0.0);

        foreach ($rows as $row) {
            $label = $row[$labelKey];
            $distribution[$label] = ($distribution[$label] ?? 0) + 1;
        }
        foreach ($classes as $class) {
            $distribution[$class] = $distribution[$class] / $n;
        }

        return ['leaf' => true, 'distribution' => $distribution, 'n' => count($rows)];
    }

    private static function buildTree(array $rows, array $features, string $labelKey, array $classes, int $depth, int $maxDepth, int $minSamplesSplit, int $featureSampleSize): array
    {
        $isPure = true;
        $firstLabel = $rows[0][$labelKey] ?? null;
        foreach ($rows as $row) {
            if ($row[$labelKey] !== $firstLabel) {
                $isPure = false;
                break;
            }
        }

        if ($depth >= $maxDepth || count($rows) < $minSamplesSplit || $isPure) {
            return self::leafDistribution($rows, $labelKey, $classes);
        }

        $split = self::findBestSplit($rows, $features, $labelKey, $classes, $featureSampleSize);
        if ($split === null) {
            return self::leafDistribution($rows, $labelKey, $classes);
        }

        return [
            'leaf' => false,
            'feature' => $split['feature'],
            'value' => $split['value'],
            'left' => self::buildTree($split['left'], $features, $labelKey, $classes, $depth + 1, $maxDepth, $minSamplesSplit, $featureSampleSize),
            'right' => self::buildTree($split['right'], $features, $labelKey, $classes, $depth + 1, $maxDepth, $minSamplesSplit, $featureSampleSize),
        ];
    }

    private static function predictTree(array $node, array $sample): array
    {
        while (! $node['leaf']) {
            $feature = $node['feature'];
            $goLeft = $feature['type'] === 'numeric'
                ? ((float) $sample[$feature['key']] <= (float) $node['value'])
                : ($sample[$feature['key']] === $node['value']);
            $node = $goLeft ? $node['left'] : $node['right'];
        }

        return $node['distribution'];
    }

    private static function bootstrapSample(array $rows): array
    {
        $n = count($rows);
        $sample = [];
        for ($i = 0; $i < $n; $i++) {
            $sample[] = $rows[random_int(0, $n - 1)];
        }

        return $sample;
    }

    /**
     * Returns null when there is not enough labeled, class-diverse data to train meaningfully —
     * callers fall back to a heuristic in that case rather than trust a degenerate model.
     */
    public static function train(array $rows, array $options): ?array
    {
        $features = $options['features'];
        $labelKey = $options['labelKey'];
        $nTrees = $options['nTrees'] ?? 41;
        $maxDepth = $options['maxDepth'] ?? 6;
        $minSamplesSplit = $options['minSamplesSplit'] ?? 4;

        $classes = [];
        foreach ($rows as $row) {
            $classes[$row[$labelKey]] = true;
        }
        $classes = array_keys($classes);

        if (count($rows) < 8 || count($classes) < 2) {
            return null;
        }

        $featureSampleSize = max(1, (int) round(sqrt(count($features))));
        $trees = [];
        for ($t = 0; $t < $nTrees; $t++) {
            $trees[] = self::buildTree(self::bootstrapSample($rows), $features, $labelKey, $classes, 0, $maxDepth, $minSamplesSplit, $featureSampleSize);
        }

        return ['trees' => $trees, 'features' => $features, 'labelKey' => $labelKey, 'classes' => $classes, 'trainedOn' => count($rows)];
    }

    /** @return array<string, float>|null class => probability, averaged across the trees */
    public static function predictProbabilities(?array $forest, array $sample): ?array
    {
        if ($forest === null) {
            return null;
        }

        $totals = array_fill_keys($forest['classes'], 0.0);
        foreach ($forest['trees'] as $tree) {
            $distribution = self::predictTree($tree, $sample);
            foreach ($forest['classes'] as $class) {
                $totals[$class] += $distribution[$class] ?? 0;
            }
        }

        $n = count($forest['trees']);
        $probabilities = [];
        foreach ($forest['classes'] as $class) {
            $probabilities[$class] = $totals[$class] / $n;
        }

        return $probabilities;
    }

    public static function predictClass(?array $forest, array $sample): ?array
    {
        $probabilities = self::predictProbabilities($forest, $sample);
        if ($probabilities === null) {
            return null;
        }

        arsort($probabilities);
        $label = array_key_first($probabilities);

        return ['label' => $label, 'confidence' => $probabilities[$label], 'probabilities' => $probabilities];
    }
}
