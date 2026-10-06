<?php

namespace App\Http\Controllers\Api;

use App\Models\AccountActivity;
use App\Models\Incident;
use App\Models\Setting;
use App\Services\AccountService;
use App\Services\NotificationService;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;

/**
 * Accident reports. Reading is open — that is how the public landing page and signed-in
 * residents see what the administrators recorded. Everything that changes data sits behind
 * the RimasAdmin middleware.
 */
class IncidentController extends ApiController
{
    public function __construct(private NotificationService $notifications)
    {
    }

    private function nextIncidentId(): string
    {
        return '#A' . (10000 + Setting::nextSequence('nextIncidentSeq'));
    }

    private function nextSortKey(): int
    {
        return ((int) Incident::max('sort_key')) + 1;
    }

    /** Optional coordinate: kept as a float when given, null when blank or absent. */
    private function coordinate(array $body, string $key, $fallback = null)
    {
        if (! array_key_exists($key, $body)) {
            return $fallback;
        }

        $value = $body[$key];

        return ($value === null || $value === '') ? null : (float) $value;
    }

    /** GET /api/incidents — newest first, the order the console and the maps expect. */
    /** GET /api/incidents — open to everyone; who entered each record is for admins only. */
    public function index(Request $request)
    {
        $admin = $this->requestIsAdmin($request);
        $seconds = (int) config('mandasafe.analytics_cache_seconds');
        if ($seconds <= 0) {
            return response()->json(Incident::listApi($admin));
        }

        // Every map and the console load this whole list — 1.6 MB of JSON, ~130 KB gzipped.
        // It is kept gzipped, ready to send, until the next write bumps the data version, so
        // a visit costs one cache read instead of reading every row, encoding and compressing.
        // That matters most on a remote database (Vercel + Aiven), where each is a round-trip.
        // One entry per audience, overwritten on change, so old versions never pile up.
        // Base64 because the MySQL cache table is a text column and gzip is binary.
        $key = 'mandasafe:incidents-gz:' . ($admin ? 'admin' : 'public');
        $version = Setting::dataVersion();
        $cached = Cache::get($key);
        if (! is_array($cached) || ($cached['version'] ?? null) !== $version) {
            $json = json_encode(Incident::listApi($admin));
            $cached = ['version' => $version, 'gzip' => base64_encode(gzencode($json, 6))];
            Cache::put($key, $cached, $seconds);
        }

        $gzip = base64_decode($cached['gzip']);
        if (str_contains(strtolower((string) $request->header('Accept-Encoding', '')), 'gzip')) {
            return response($gzip, 200, [
                'Content-Type' => 'application/json',
                'Content-Encoding' => 'gzip',   // CompressResponse leaves an encoded response alone
                'Content-Length' => (string) strlen($gzip),
                'Vary' => 'Accept-Encoding',
            ]);
        }

        return response(gzdecode($gzip), 200, ['Content-Type' => 'application/json', 'Vary' => 'Accept-Encoding']);
    }

    /** POST /api/incidents */
    public function store(Request $request)
    {
        return $this->attempt(function () use ($request) {
            $body = $this->body($request);
            $this->requireFields($body, ['barangay', 'road', 'sev', 'type', 'date']);

            $incident = Incident::create([
                'id' => $this->nextIncidentId(),
                'date' => $body['date'],
                'time' => $body['time'] ?? '',
                'loc' => $body['loc'] ?? 'Mandaluyong',
                'barangay' => $body['barangay'],
                'road' => $body['road'],
                'sev' => $body['sev'],
                'type' => $body['type'],
                'lat' => $this->coordinate($body, 'lat'),
                'lng' => $this->coordinate($body, 'lng'),
                'status' => $body['status'] ?? 'active',
                'created_by' => $this->actor($request)->email,
                'created_at_iso' => AccountService::isoNow(),
                'sort_key' => $this->nextSortKey(),
            ]);

            Setting::touchDataVersion();

            $api = $incident->toApi(true);
            $this->notifications->notifyIncidentCreated($api, $this->actor($request)->email);
            AccountActivity::record($this->actor($request)->id, 'incident_created', "Added accident {$api['id']} ({$api['barangay']}, {$api['date']}).");

            return $api;
        }, 400, 201);
    }

    /** PUT /api/incidents/{id} */
    public function update(Request $request, string $id)
    {
        return $this->attempt(function () use ($request, $id) {
            $incident = Incident::find(rawurldecode($id));
            if (! $incident) {
                return response()->json(['error' => 'Accident not found.'], 404);
            }

            $body = $this->body($request);
            $incident->fill([
                'date' => $body['date'] ?? $incident->date,
                'time' => $body['time'] ?? $incident->time,
                'barangay' => $body['barangay'] ?? $incident->barangay,
                'road' => $body['road'] ?? $incident->road,
                'sev' => $body['sev'] ?? $incident->sev,
                'type' => $body['type'] ?? $incident->type,
                'lat' => $this->coordinate($body, 'lat', $incident->lat),
                'lng' => $this->coordinate($body, 'lng', $incident->lng),
                'status' => $body['status'] ?? $incident->status,
                'updated_by' => $this->actor($request)->email,
                'updated_at_iso' => AccountService::isoNow(),
            ])->save();

            Setting::touchDataVersion();

            $api = $incident->toApi(true);
            $this->notifications->notifyIncidentUpdated($api, $this->actor($request)->email);
            AccountActivity::record($this->actor($request)->id, 'incident_updated', "Edited accident {$api['id']} ({$api['barangay']}, {$api['date']}).");

            return $api;
        });
    }

    /** DELETE /api/incidents/{id} */
    public function destroy(Request $request, string $id)
    {
        $incident = Incident::find(rawurldecode($id));
        if (! $incident) {
            return response()->json(['error' => 'Accident not found.'], 404);
        }

        $api = $incident->toApi(true);
        $incident->delete();
        Setting::touchDataVersion();
        $this->notifications->notifyIncidentDeleted($api, $this->actor($request)->email);
        AccountActivity::record($this->actor($request)->id, 'incident_deleted', "Deleted accident {$api['id']} ({$api['barangay']}, {$api['date']}).");

        return response()->json(['deleted' => $incident->id]);
    }

    /**
     * POST /api/incidents/bulk-delete — removes every listed accident in one transaction, for
     * the console's "delete filtered" button (e.g. every record from one date or one year).
     * Either all of them go or, on an error, none do.
     */
    public function bulkDestroy(Request $request)
    {
        return $this->attempt(function () use ($request) {
            $ids = $this->body($request)['ids'] ?? null;
            if (! is_array($ids) || $ids === []) {
                throw new \App\Exceptions\RimasException('No accidents selected to delete.');
            }
            $ids = array_values(array_unique(array_filter($ids, fn ($id) => is_string($id) && $id !== '')));

            $deleted = 0;
            $removed = [];
            DB::transaction(function () use ($ids, &$deleted, &$removed) {
                foreach (array_chunk($ids, 500) as $chunk) {
                    // What is about to go, for the notification.
                    foreach (Incident::whereIn('id', $chunk)->get(['id', 'date', 'barangay']) as $row) {
                        $removed[] = ['id' => $row->id, 'date' => $row->date, 'barangay' => $row->barangay];
                    }
                    $deleted += Incident::whereIn('id', $chunk)->delete();
                }
            });

            if ($deleted > 0) {
                Setting::touchDataVersion();
                usort($removed, fn ($a, $b) => strcmp((string) $a['date'], (string) $b['date']));
                $this->notifications->notifyIncidentsDeleted($removed, $this->actor($request)->email);
                AccountActivity::record($this->actor($request)->id, 'incident_deleted', "Deleted {$deleted} accident record(s) in bulk.");
            }

            return ['deletedCount' => $deleted, 'notFoundCount' => count($ids) - $deleted];
        });
    }

    /**
     * POST /api/incidents/bulk — the console's CSV/Excel import. Records that repeat an
     * existing date/time/barangay/road/type combination are skipped rather than duplicated,
     * and every skipped row is reported back with its reason and its position in the file.
     */
    public function bulk(Request $request)
    {
        return $this->attempt(function () use ($request) {
            $records = $this->body($request)['records'] ?? null;
            if (! is_array($records) || $records === []) {
                throw new \App\Exceptions\RimasException('No records to import.');
            }

            $existingKeys = [];
            foreach (Incident::select('date', 'time', 'barangay', 'road', 'type')->cursor() as $row) {
                $existingKeys[strtolower(implode('||', [$row->date, $row->time, $row->barangay, $row->road, $row->type]))] = true;
            }

            $actorEmail = $this->actor($request)->email;
            $created = [];
            $skipped = [];

            DB::transaction(function () use ($records, &$existingKeys, &$created, &$skipped, $actorEmail) {
                $sortKey = $this->nextSortKey();

                foreach ($records as $index => $body) {
                    try {
                        if (! is_array($body)) {
                            throw new \App\Exceptions\RimasException('Row is not a record.');
                        }
                        $this->requireFields($body, ['barangay', 'road', 'sev', 'type', 'date']);

                        $key = strtolower(implode('||', [$body['date'], $body['time'] ?? '', $body['barangay'], $body['road'], $body['type']]));
                        if (isset($existingKeys[$key])) {
                            $skipped[] = ['index' => $index, 'reason' => 'Duplicate of an existing accident'];

                            continue;
                        }
                        $existingKeys[$key] = true;

                        $created[] = Incident::create([
                            'id' => $this->nextIncidentId(),
                            'date' => $body['date'],
                            'time' => $body['time'] ?? '',
                            'loc' => $body['loc'] ?? 'Mandaluyong',
                            'barangay' => $body['barangay'],
                            'road' => $body['road'],
                            'sev' => $body['sev'],
                            'type' => $body['type'],
                            'lat' => $this->coordinate($body, 'lat'),
                            'lng' => $this->coordinate($body, 'lng'),
                            'status' => $body['status'] ?? 'active',
                            'created_by' => $actorEmail,
                            'created_at_iso' => AccountService::isoNow(),
                            'sort_key' => $sortKey++,
                        ])->toApi(true);
                    } catch (\App\Exceptions\RimasException $exception) {
                        $skipped[] = ['index' => $index, 'reason' => $exception->getMessage()];
                    }
                }
            });

            Setting::touchDataVersion();
            $this->notifications->notifyIncidentsImported(count($created), $actorEmail);
            AccountActivity::record($this->actor($request)->id, 'incident_imported', 'Imported ' . count($created) . ' accident record(s), skipped ' . count($skipped) . '.');

            return [
                'created' => $created,
                'skipped' => $skipped,
                'createdCount' => count($created),
                'skippedCount' => count($skipped),
            ];
        }, 400, 201);
    }
}
