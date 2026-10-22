<?php

namespace App\Http\Controllers\Api;

use App\Exceptions\RimasException;
use App\Models\InsightAction;
use App\Services\AccountService;
use Illuminate\Http\Request;

/**
 * Administrators record what the TPMO or the city did about an insight. The public reads
 * these inside each insight (GET /api/insights attaches them), so there is no public list.
 */
class InsightActionController extends ApiController
{
    /** GET /api/insight-actions — administrators: every action, grouped by insight id. */
    public function index()
    {
        return response()->json((object) InsightAction::byInsight(true));
    }

    /** POST /api/insight-actions */
    public function store(Request $request)
    {
        return $this->attempt(function () use ($request) {
            return InsightAction::create($this->validated($this->body($request)) + [
                'created_by' => $this->actor($request)->email,
                'created_at_iso' => AccountService::isoNow(),
            ])->toApi(true);
        }, 400, 201);
    }

    /** PUT /api/insight-actions/{id} */
    public function update(Request $request, string $id)
    {
        return $this->attempt(function () use ($request, $id) {
            $row = InsightAction::find($id);
            if (! $row) {
                return response()->json(['error' => 'Action not found.'], 404);
            }
            $row->update($this->validated($this->body($request)) + [
                'updated_by' => $this->actor($request)->email,
                'updated_at_iso' => AccountService::isoNow(),
            ]);

            return $row->toApi(true);
        });
    }

    /** DELETE /api/insight-actions/{id} */
    public function destroy(string $id)
    {
        $row = InsightAction::find($id);
        if (! $row) {
            return response()->json(['error' => 'Action not found.'], 404);
        }
        $row->delete();

        return response()->json(['ok' => true]);
    }

    private function validated(array $body): array
    {
        $body = array_map(fn ($v) => is_string($v) ? trim($v) : $v, $body);
        $this->requireFields($body, ['insightId', 'title', 'details', 'status']);

        // The ids InsightService gives: city-<topic> or brgy-<barangay>.
        if (! preg_match('/^(city|brgy)-[a-z0-9-]{1,80}$/', $body['insightId'])) {
            throw new RimasException('Unknown insight.');
        }
        if (! in_array($body['status'], InsightAction::STATUSES, true)) {
            throw new RimasException('Please choose Planned, Ongoing or Completed.');
        }
        if (mb_strlen($body['title']) > 150 || mb_strlen($body['details']) > 3000) {
            throw new RimasException('Please keep the title under 150 and the details under 3000 characters.');
        }
        $date = (string) ($body['date'] ?? '');
        if ($date !== '' && ! preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
            throw new RimasException('Please enter the date as a calendar date.');
        }

        return [
            'insight_id' => $body['insightId'],
            'title' => $body['title'],
            'details' => $body['details'],
            'status' => $body['status'],
            'action_date' => $date === '' ? null : $date,
        ];
    }
}
