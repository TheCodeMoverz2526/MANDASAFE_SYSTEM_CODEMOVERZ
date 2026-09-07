<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class RimasSession extends Model
{
    protected $table = 'rimas_sessions';
    protected $primaryKey = 'token';
    public $incrementing = false;
    protected $keyType = 'string';
    public $timestamps = false;

    protected $guarded = [];

    public function account()
    {
        return $this->belongsTo(Account::class, 'account_id');
    }
}
