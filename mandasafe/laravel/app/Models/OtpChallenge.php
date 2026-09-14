<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * A verification in flight. See the migration for why the code is not stored here.
 *
 * The sign-up details (name, email, phone and the chosen password) are held in `payload`
 * encrypted with the application key: the account does not exist yet at that point, so the
 * details have to survive between "send the code" and "code accepted", and nothing readable
 * should sit in the database while they wait.
 */
class OtpChallenge extends Model
{
    protected $table = 'otp_challenges';
    protected $primaryKey = 'id';
    public $incrementing = false;
    protected $keyType = 'string';
    public $timestamps = false;

    protected $guarded = [];

    protected $hidden = ['payload', 'code_hash', 'provider_uuid', 'provider_ref'];

    protected function casts(): array
    {
        return ['payload' => 'encrypted:array'];
    }
}
