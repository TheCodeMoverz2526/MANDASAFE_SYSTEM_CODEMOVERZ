<?php

namespace App\Services;

use App\Models\Account;
use App\Models\Incident;
use App\Models\ResidentNotification;
use App\Models\Setting;
use Illuminate\Support\Facades\Cache;

/**
 * The residents' bell: new accident reports and newly appeared hotspots. Unlike the admin
 * inbox (NotificationService) it never says who entered a record.
 */
class ResidentNotificationService
{
    /** How many the bell's list shows. */
    private const LIST_SIZE = 30;

    private function create(string $type, string $title, ?string $desc, ?string $link): ResidentNotification
    {
        return ResidentNotification::create([
            'type' => $type,
            'title' => $title,
            'desc' => $desc,
            'link' => $link,
            'created_at_iso' => AccountService::isoNow(),
        ]);
    }

    /** Raised when an administrator logs one new accident report. */
    public function notifyIncidentAdded(array $incident): ResidentNotification
    {
        return $this->create(
            'incident_added',
            'New accident reported',
            "{$incident['sev']} {$incident['type']} on {$incident['road']}, {$incident['barangay']} ({$incident['date']}).",
            'incident-map.html'
        );
    }

    /**
     * Raised once per CSV/Excel import rather than once per row, naming the barangays that
     * had the most of the new reports.
     *
     * @param  array<int, array>  $incidents  the records actually created
     */
    public function notifyIncidentsImported(array $incidents): ?ResidentNotification
    {
        $count = count($incidents);
        if ($count === 0) {
            return null;
        }
        if ($count === 1) {
            return $this->notifyIncidentAdded($incidents[0]);
        }

        $byBarangay = array_count_values(array_column($incidents, 'barangay'));
        arsort($byBarangay);
        $top = array_slice(array_keys($byBarangay), 0, 3);
        $more = count($byBarangay) - count($top);
        $where = implode(', ', $top) . ($more > 0 ? " and {$more} more barangay" . ($more === 1 ? '' : 's') : '');

        return $this->create(
            'incident_added',
            "{$count} new accident reports",
            "New reports were added for {$where}.",
            'incident-map.html'
        );
    }

    /**
     * Compares the current KDE hotspot peaks with the ones seen last time and announces any
     * barangay/road pair that has newly become a hotspot. Runs after the background warm, and
     * again from the bell's poll in case no warm ran (it is a no-op until the data changes).
     *
     * The very first run only records the peaks: every hotspot would be "new" otherwise.
     */
    public function checkForNewHotspots(AnalyticsService $analytics): ?ResidentNotification
    {
        $version = Setting::dataVersion();
        if ((int) Setting::get('hotspotsCheckedVersion', -1) === $version) {
            return null;
        }

        // Two polls arriving together must not both announce the same hotspot.
        $lock = Cache::lock('mandasafe:hotspot-check', 120);
        if (! $lock->get()) {
            return null;
        }

        try {
            $peaks = $analytics->hotspots();

            // No peaks while there are accidents on file means the KDE could not run (Python
            // unavailable). Keep the last good snapshot and try again on the next check.
            if ($peaks === [] && Incident::query()->exists()) {
                return null;
            }

            $current = [];
            foreach ($peaks as $peak) {
                $current[self::hotspotKey($peak)] = $peak;
            }

            $stored = Setting::get('hotspotKeys');
            Setting::put('hotspotKeys', json_encode(array_keys($current)));
            Setting::put('hotspotsCheckedVersion', $version);

            if ($stored === null) {
                return null;
            }

            $new = array_values(array_diff_key($current, array_flip(json_decode($stored, true) ?: [])));

            return $new === [] ? null : $this->notifyNewHotspots($new);
        } finally {
            $lock->release();
        }
    }

    private static function hotspotKey(array $peak): string
    {
        return strtolower(($peak['barangay'] ?? '') . '||' . ($peak['road'] ?? ''));
    }

    private function notifyNewHotspots(array $peaks): ResidentNotification
    {
        if (count($peaks) === 1) {
            $peak = $peaks[0];
            $count = (int) ($peak['incidentCount'] ?? 0);

            return $this->create(
                'hotspot_new',
                'New accident hotspot',
                "{$peak['road']}, {$peak['barangay']} is now a hotspot, with {$count} accident"
                    . ($count === 1 ? '' : 's') . ' recorded nearby. Take extra care in this area.',
                'hotspots.html'
            );
        }

        $places = array_map(fn ($p) => "{$p['road']} ({$p['barangay']})", array_slice($peaks, 0, 3));
        $more = count($peaks) - count($places);

        return $this->create(
            'hotspot_new',
            count($peaks) . ' new accident hotspots',
            'New hotspots: ' . implode(', ', $places) . ($more > 0 ? " and {$more} more" : '') . '.',
            'hotspots.html'
        );
    }

    /**
     * What the bell asks for: the newest items, how many this account has not seen, and the
     * newest id so the page can tell when something new arrives between polls.
     */
    public function feedFor(Account $account): array
    {
        $latest = (int) ResidentNotification::max('id');

        if ($account->alerts_seen_id === null) {
            $account->alerts_seen_id = $latest;
            $account->save();
        }
        $seen = (int) $account->alerts_seen_id;

        return [
            'latest' => $latest,
            'unread' => ResidentNotification::where('id', '>', $seen)->count(),
            'items' => ResidentNotification::orderByDesc('id')->limit(self::LIST_SIZE)->get()
                ->map(fn (ResidentNotification $n) => $n->toApi($seen))->all(),
        ];
    }

    public function markAllRead(Account $account): void
    {
        $account->alerts_seen_id = (int) ResidentNotification::max('id');
        $account->save();
    }
}
