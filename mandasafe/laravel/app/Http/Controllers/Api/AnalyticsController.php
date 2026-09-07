<?php

namespace App\Http\Controllers\Api;

use App\Services\AnalyticsService;
use App\Services\OtpService;
use Illuminate\Http\Request;

/**
 * The open, read-only endpoints: forecasts, city statistics, the hotspot surface, the single
 * summary payload the resident pages use, and the barangay boundaries every map draws.
 */
class AnalyticsController extends ApiController
{
    public function __construct(private AnalyticsService $analytics)
    {
    }

    /** GET /api/predictions */
    public function predictions()
    {
        return response()->json($this->analytics->predictions());
    }

    /** GET /api/stats */
    public function stats()
    {
        return response()->json($this->analytics->stats());
    }

    /** GET /api/summary — totals, per-barangay counts, trend, mix, forecasts, newest reports. */
    public function summary()
    {
        return response()->json($this->analytics->summary());
    }

    /** GET /api/hotspots */
    public function hotspots()
    {
        return response()->json($this->analytics->hotspots());
    }

    /** GET /api/barangays — the 27 official barangay polygons, served verbatim. */
    public function barangays()
    {
        $path = config('mandasafe.geojson');

        if (! is_string($path) || ! is_file($path)) {
            return response()->json(['error' => 'Barangay boundary data is missing.'], 500);
        }

        return response()->file($path, ['Content-Type' => 'application/geo+json']);
    }

    /** GET /api/otp-status — which verification channels are configured. */
    public function otpStatus(OtpService $otp)
    {
        return response()->json($otp->status());
    }

    /** POST /api/send-otp */
    public function sendOtp(Request $request, OtpService $otp)
    {
        return $this->attempt(fn () => $otp->send($this->body($request)), 502);
    }
}
