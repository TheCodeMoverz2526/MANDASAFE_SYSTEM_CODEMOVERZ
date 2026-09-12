<?php

namespace App\Http\Controllers\Api;

use App\Services\AccountService;
use App\Services\VerificationService;
use Illuminate\Http\Request;

/**
 * Signing in, signing up and resetting a password. All three go through the same three
 * steps, because all three end with something worth protecting:
 *
 *   1. POST /api/auth/login | /register | /contact   states the intent and proves what can be
 *      proved now (the password, the sign-up details, that the account exists). Answers with
 *      a challenge id and the masked contacts — never with a session.
 *   2. POST /api/auth/otp/send      sends the code to the chosen channel.
 *   3. POST /api/auth/otp/verify    checks the code and only then issues the session, creates
 *      the account, or unlocks POST /api/auth/reset-password.
 *
 * The code is never returned to the browser and never compared there.
 */
class AuthController extends ApiController
{
    public function __construct(
        private AccountService $accounts,
        private VerificationService $verification,
    ) {
    }

    /** GET /api/auth/me — the account behind the bearer token, straight from the database. */
    public function me(Request $request)
    {
        $account = $this->accounts->accountForToken($this->accounts->tokenFromRequest($request));

        if (! $account) {
            return response()->json(['error' => 'Not signed in.'], 401);
        }

        return response()->json($account->toApi());
    }

    /**
     * POST /api/auth/login — step one: the password is checked here, the session is not
     * issued until the code sent in step three is accepted.
     */
    public function login(Request $request)
    {
        return $this->attempt(function () use ($request) {
            $body = $this->body($request);
            $this->requireFields($body, ['identifier', 'password']);

            return $this->verification->startLogin($body, (string) $request->ip());
        }, 401);
    }

    /**
     * POST /api/auth/register — step one of signing up. The details are validated now; the
     * account is written only once the code is accepted, so every account has a verified
     * email address or contact number behind it.
     */
    public function register(Request $request)
    {
        return $this->attempt(function () use ($request) {
            $body = $this->body($request);
            $this->requireFields($body, ['name', 'email', 'phone', 'password']);

            return $this->verification->startRegistration($body, (string) $request->ip());
        }, 400);
    }

    /** POST /api/auth/contact — step one of "Forgot password?". */
    public function contact(Request $request)
    {
        return $this->attempt(function () use ($request) {
            $body = $this->body($request);
            $this->requireFields($body, ['identifier']);

            return $this->verification->startReset($body, (string) $request->ip());
        }, 404);
    }

    /** POST /api/auth/otp/send — step two: deliver the code by email or SMS. */
    public function sendOtp(Request $request)
    {
        return $this->attempt(function () use ($request) {
            $body = $this->body($request);
            $this->requireFields($body, ['challengeId', 'channel']);

            return $this->verification->send($body, (string) $request->ip());
        }, 400);
    }

    /** POST /api/auth/otp/verify — step three: check the code and complete the flow. */
    public function verifyOtp(Request $request)
    {
        return $this->attempt(function () use ($request) {
            $body = $this->body($request);
            $this->requireFields($body, ['challengeId', 'code']);

            return $this->verification->verify($body, (string) $request->ip());
        }, 400);
    }

    /** POST /api/auth/otp/cancel — leaving the page should not leave a live challenge behind. */
    public function cancelOtp(Request $request)
    {
        return $this->attempt(fn () => $this->verification->cancel($this->body($request)), 400);
    }

    /**
     * POST /api/auth/reset-password — the last step of "Forgot password?". Accepted only for
     * a challenge that was verified in the last few minutes, which is what stops anyone from
     * setting a new password for an account simply by naming it.
     */
    public function resetPassword(Request $request)
    {
        return $this->attempt(function () use ($request) {
            $body = $this->body($request);
            $this->requireFields($body, ['challengeId', 'password']);

            return $this->verification->completeReset($body);
        }, 400);
    }

    /** POST /api/auth/logout */
    public function logout(Request $request)
    {
        $this->accounts->destroySession($this->accounts->tokenFromRequest($request));

        return response()->json(['signedOut' => true]);
    }

    /** Anything else under /api/auth/ */
    public function missing()
    {
        return response()->json(['error' => 'Unknown auth endpoint.'], 404);
    }
}
