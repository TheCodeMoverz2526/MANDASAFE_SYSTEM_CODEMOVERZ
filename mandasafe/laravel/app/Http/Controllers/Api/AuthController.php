<?php

namespace App\Http\Controllers\Api;

use App\Services\AccountService;
use App\Services\VerificationService;
use Illuminate\Http\Request;

/**
 * Signing in, signing up and resetting a password. Signing up creates the account at once;
 * a password reset goes through three steps:
 *
 *   1. POST /api/auth/contact       proves the account exists. Answers with a challenge id
 *      and the masked email — never with a session.
 *   2. POST /api/auth/otp/send      emails the code.
 *   3. POST /api/auth/otp/verify    checks the code and only then unlocks
 *      POST /api/auth/reset-password.
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
     * PUT /api/auth/profile — a signed-in account editing its own name, email or contact
     * number from the My Account page. No verification code here: the bearer token already
     * proves who is asking, and nothing about the sign-in credentials changes.
     */
    public function updateProfile(Request $request)
    {
        $account = $this->accounts->accountForToken($this->accounts->tokenFromRequest($request));

        if (! $account) {
            return response()->json(['error' => 'Not signed in.'], 401);
        }

        return $this->attempt(function () use ($request, $account) {
            $body = $this->body($request);
            $this->requireFields($body, ['name', 'email', 'phone']);

            return $this->accounts->updateOwnProfile($account, $body);
        }, 400);
    }

    /** POST /api/auth/login — returns the session token the pages keep in localStorage. */
    public function login(Request $request)
    {
        return $this->attempt(function () use ($request) {
            $body = $this->body($request);
            $this->requireFields($body, ['identifier', 'password']);

            return $this->verification->startLogin($body, (string) $request->ip());
        }, 401);
    }

    /** POST /api/auth/register — creates a resident account straight away, no verification code. */
    public function register(Request $request)
    {
        return $this->attempt(function () use ($request) {
            $body = $this->body($request);
            $this->requireFields($body, ['name', 'email', 'phone', 'password']);

            return $this->verification->register($body, (string) $request->ip());
        }, 400);
    }

    /** POST /api/auth/contact — step one of "Forgot password?": the registered email address. */
    public function contact(Request $request)
    {
        return $this->attempt(function () use ($request) {
            $body = $this->body($request);
            $this->requireFields($body, ['email']);

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

    /** POST /api/auth/totp/verify — an administrator's authenticator code, after the password. */
    public function verifyTotp(Request $request)
    {
        return $this->attempt(function () use ($request) {
            $body = $this->body($request);
            $this->requireFields($body, ['challengeId', 'code']);

            return $this->verification->verifyTotp($body, (string) $request->ip());
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
