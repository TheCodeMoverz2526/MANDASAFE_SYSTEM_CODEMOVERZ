<?php

namespace App\Models;

use Illuminate\Foundation\Auth\User as Authenticatable;

/**
 * A RIMAS account. Roles are exactly the two the console knows about:
 *   admin — may create/edit/delete incidents and prediction baseline data, manage users
 *   user  — read-only: sees the incidents, hotspots and predictions the admins produced
 */
class Account extends Authenticatable
{
    protected $table = 'accounts';
    protected $primaryKey = 'id';
    public $incrementing = false;
    protected $keyType = 'string';
    public $timestamps = false;

    protected $guarded = [];

    protected $hidden = ['password'];

    public function isAdmin(): bool
    {
        return $this->role === 'admin';
    }

    public static function normaliseEmail($value): string
    {
        return strtolower(trim((string) $value));
    }

    public static function normalisePhone($value): string
    {
        $digits = preg_replace('/[^+\d]/', '', (string) $value);

        return preg_replace('/^00/', '+', $digits);
    }

    public static function initials($name): string
    {
        $parts = array_values(array_filter(preg_split('/\s+/', (string) $name)));
        $letters = '';
        foreach (array_slice($parts, 0, 2) as $part) {
            $letters .= mb_substr($part, 0, 1);
        }

        return $letters === '' ? 'RU' : mb_strtoupper($letters);
    }

    /**
     * The same colour the browser used to compute: a 32-bit rolling string hash, kept
     * bit-for-bit identical to the JavaScript so avatars don't change colour on migration.
     */
    public static function avatarColor($email): string
    {
        $colors = ['#1a56db', '#22c55e', '#f59e0b', '#7c3aed', '#0891b2', '#dc2626'];
        $hash = 0;
        foreach (str_split((string) $email) as $char) {
            $hash = (($hash << 5) - $hash + ord($char)) & 0xFFFFFFFF;
            if ($hash & 0x80000000) {
                $hash -= 0x100000000;
            }
        }

        return $colors[abs($hash) % count($colors)];
    }

    /** Shape sent to the browser — never includes the password hash. */
    public function toApi(): array
    {
        return [
            'id' => $this->id,
            'name' => $this->name,
            'email' => $this->email,
            'phone' => $this->phone,
            'role' => $this->role,
            'dept' => $this->dept,
            'status' => $this->status,
            'avatar' => static::initials($this->name),
            'color' => static::avatarColor($this->email),
            'createdAt' => $this->created_at_iso,
            'lastLoginAt' => $this->last_login_at_iso,
        ];
    }
}
