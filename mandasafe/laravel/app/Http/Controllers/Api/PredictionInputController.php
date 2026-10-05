<?php

namespace App\Http\Controllers\Api;

use App\Exceptions\RimasException;
use App\Models\PredictionInput;
use App\Models\Setting;
use App\Services\AccountService;
use Illuminate\Http\Request;

/**
 * Baseline prediction data is admin-entered — it drives every forecast users see — so only
 * the read route is open. Reading is public for the same reason the incident list is.
 */
class PredictionInputController extends ApiController
{
    private function nextInputId(): string
    {
        return 'RF-' . (1000 + Setting::nextSequence('nextInputSeq'));
    }

    private function assertMonth($month): void
    {
        if (! preg_match('/^\d{4}-\d{2}$/', (string) $month)) {
            throw new RimasException('Month must be in YYYY-MM format.');
        }
    }

    private function assertCount($value): int
    {
        if (! is_numeric($value) || (float) $value < 0) {
            throw new RimasException('Accident count must be a non-negative number.');
        }

        return (int) $value;
    }

    /** GET /api/prediction-inputs */
    /** GET /api/prediction-inputs — open to everyone; who edited each entry is for admins only. */
    public function index(Request $request)
    {
        $withAudit = $this->requestIsAdmin($request);

        return response()->json(PredictionInput::newestFirst()->get()->map(fn ($input) => $input->toApi($withAudit))->all());
    }

    /** POST /api/prediction-inputs */
    public function store(Request $request)
    {
        return $this->attempt(function () use ($request) {
            $body = $this->body($request);
            $this->requireFields($body, ['barangay', 'month', 'incidentCount']);
            $this->assertMonth($body['month']);
            // Validate before drawing an id, so a rejected entry leaves no gap in the sequence.
            $count = $this->assertCount($body['incidentCount']);

            $input = PredictionInput::create([
                'id' => $this->nextInputId(),
                'barangay' => $body['barangay'],
                'road' => $body['road'] ?? 'All Roads',
                'month' => $body['month'],
                'incident_count' => $count,
                'notes' => $body['notes'] ?? '',
                'updated_by' => $this->actor($request)->email,
                'updated_at_iso' => AccountService::isoNow(),
                'sort_key' => ((int) PredictionInput::max('sort_key')) + 1,
            ]);

            Setting::touchDataVersion();

            return $input->toApi(true);
        }, 400, 201);
    }

    /** PUT /api/prediction-inputs/{id} */
    public function update(Request $request, string $id)
    {
        return $this->attempt(function () use ($request, $id) {
            $input = PredictionInput::find(rawurldecode($id));
            if (! $input) {
                return response()->json(['error' => 'Prediction data entry not found.'], 404);
            }

            $body = $this->body($request);
            if (! empty($body['month'])) {
                $this->assertMonth($body['month']);
            }

            $input->fill([
                'barangay' => $body['barangay'] ?? $input->barangay,
                'road' => $body['road'] ?? $input->road,
                'month' => $body['month'] ?? $input->month,
                'incident_count' => array_key_exists('incidentCount', $body)
                    ? $this->assertCount($body['incidentCount'])
                    : $input->incident_count,
                'notes' => $body['notes'] ?? $input->notes,
                'updated_by' => $this->actor($request)->email,
                'updated_at_iso' => AccountService::isoNow(),
            ])->save();

            Setting::touchDataVersion();

            return $input->toApi(true);
        });
    }

    /** DELETE /api/prediction-inputs/{id} */
    public function destroy(string $id)
    {
        $input = PredictionInput::find(rawurldecode($id));
        if (! $input) {
            return response()->json(['error' => 'Prediction data entry not found.'], 404);
        }

        $input->delete();
        Setting::touchDataVersion();

        return response()->json(['deleted' => $input->id]);
    }
}
