<?php

namespace App\Http\Controllers\Api;

use App\Services\AccountService;
use Illuminate\Http\Request;

class AuthController extends ApiController
{
    public function __construct(private AccountService $accounts)
    {
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

    /** POST /api/auth/register — public sign-up; new accounts are always residents. */
    public function register(Request $request)
    {
        return $this->attempt(function () use ($request) {
            $body = $this->body($request);
            $this->requireFields($body, ['name', 'email', 'phone', 'password']);

            return $this->accounts->registerAccount($body);
        }, 400, 201);
    }

    /** PUT /api/auth/profile — a signed-in account editing its own name, email or phone. */
    public function updateProfile(Request $request)
    {
        $account = $this->accounts->accountForToken($this->accounts->tokenFromRequest($request));
        if (! $account) {
            return response()->json(['error' => 'Please sign in to continue.'], 401);
        }

        return $this->attempt(fn () => $this->accounts->updateOwnProfile($account, $this->body($request)));
    }

    /** POST /api/auth/login — returns the session token the pages keep in localStorage. */
    public function login(Request $request)
    {
        return $this->attempt(function () use ($request) {
            $body = $this->body($request);
            $this->requireFields($body, ['identifier', 'password']);
            $account = $this->accounts->verifyCredentials($body['identifier'], $body['password']);

            return $this->accounts->createSession($account);
        }, 401);
    }

    /** POST /api/auth/contact — confirms an identifier exists and returns the masked contacts. */
    public function contact(Request $request)
    {
        return $this->attempt(function () use ($request) {
            $body = $this->body($request);
            $this->requireFields($body, ['identifier']);

            return $this->accounts->contactDetails($body['identifier']);
        }, 404);
    }

    /** POST /api/auth/reset-password — used by "Forgot password?" once the OTP is accepted. */
    public function resetPassword(Request $request)
    {
        return $this->attempt(function () use ($request) {
            $body = $this->body($request);
            $this->requireFields($body, ['identifier', 'password']);

            return $this->accounts->resetPassword($body['identifier'], $body['password']);
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
