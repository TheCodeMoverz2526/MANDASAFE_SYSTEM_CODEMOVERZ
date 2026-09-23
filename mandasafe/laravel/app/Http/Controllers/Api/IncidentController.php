<?php

namespace App\Http\Controllers\Api;

use App\Models\Incident;
use App\Models\Setting;
use App\Services\AccountService;
use App\Services\NotificationService;
use Illuminate\Http\Request;
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
    public function index()
    {
        return response()->json(Incident::listApi());
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

            $api = $incident->toApi();
            $this->notifications->notifyIncidentCreated($api, $this->actor($request)->email);

            return $api;
        }, 400, 201);
    }

    /** PUT /api/incidents/{id} */
    public function update(Request $request, string $id)
    {
        return $this->attempt(function () use ($request, $id) {
            $incident = Incident::find(rawurldecode($id));
            if (! $incident) {
                return response()->json(['error' => 'Incident not found.'], 404);
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

            $api = $incident->toApi();
            $this->notifications->notifyIncidentUpdated($api, $this->actor($request)->email);

            return $api;
        });
    }

    /** DELETE /api/incidents/{id} */
    public function destroy(string $id)
    {
        $incident = Incident::find(rawurldecode($id));
        if (! $incident) {
            return response()->json(['error' => 'Incident not found.'], 404);
        }

        $incident->delete();
        Setting::touchDataVersion();

        return response()->json(['deleted' => $incident->id]);
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
                            $skipped[] = ['index' => $index, 'reason' => 'Duplicate of an existing incident'];

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
                        ])->toApi();
                    } catch (\App\Exceptions\RimasException $exception) {
                        $skipped[] = ['index' => $index, 'reason' => $exception->getMessage()];
                    }
                }
            });

            Setting::touchDataVersion();
            $this->notifications->notifyIncidentsImported(count($created), $actorEmail);

            return [
                'created' => $created,
                'skipped' => $skipped,
                'createdCount' => count($created),
                'skippedCount' => count($skipped),
            ];
        }, 400, 201);
    }
}
