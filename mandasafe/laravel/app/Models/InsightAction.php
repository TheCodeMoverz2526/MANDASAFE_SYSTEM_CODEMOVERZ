<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/** Something the TPMO or the city did about one insight, posted from the RIMAS console. */
class InsightAction extends Model
{
    public const STATUSES = ['planned', 'ongoing', 'completed'];

    protected $table = 'insight_actions';
    public $timestamps = false;

    protected $guarded = [];

    /** Every action, newest first, grouped by the insight it belongs to. */
    public static function byInsight(bool $withAudit = false): array
    {
        return static::orderByDesc('action_date')->orderByDesc('id')->get()
            ->groupBy('insight_id')
            ->map(fn ($rows) => $rows->map(fn (InsightAction $row) => $row->toApi($withAudit))->values()->all())
            ->all();
    }

    public function toApi(bool $withAudit = false): array
    {
        $record = [
            'id' => $this->id,
            'insightId' => $this->insight_id,
            'title' => $this->title,
            'details' => $this->details,
            'status' => $this->status,
            'date' => $this->action_date,
            'createdAt' => $this->created_at_iso,
            'updatedAt' => $this->updated_at_iso,
        ];

        if ($withAudit) {
            $record['createdBy'] = $this->created_by;
            $record['updatedBy'] = $this->updated_by;
        }

        return $record;
    }
}
