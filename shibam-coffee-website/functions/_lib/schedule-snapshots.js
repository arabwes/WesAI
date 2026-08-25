import { newId, nowIso, sha256Hex } from './http.js';

export async function captureScheduleVersion(env, scheduleId, actorId, reason) {
  const schedule = await env.TEAM_DB.prepare('SELECT * FROM schedules WHERE id = ?').bind(scheduleId).first();
  if (!schedule) return null;
  const { results: shifts } = await env.TEAM_DB.prepare(`SELECT id, employee_id, position_id, shift_date,
      start_time, end_time, break_minutes, notes, status, version, override_reason
    FROM shifts WHERE schedule_id = ? ORDER BY shift_date, start_time, id`).bind(scheduleId).all();
  const snapshot = JSON.stringify({
    schedule: {
      id: schedule.id,
      locationId: schedule.location_id,
      weekStart: schedule.week_start,
      status: schedule.status,
      version: Number(schedule.version),
      publishedAt: schedule.published_at || ''
    },
    shifts: shifts.map((shift) => ({
      id: shift.id,
      employeeId: shift.employee_id || '',
      positionId: shift.position_id || '',
      date: shift.shift_date,
      startTime: shift.start_time,
      endTime: shift.end_time,
      breakMinutes: Number(shift.break_minutes || 0),
      notes: shift.notes || '',
      status: shift.status,
      version: Number(shift.version || 1),
      overrideReason: shift.override_reason || ''
    }))
  });
  const checksum = await sha256Hex(snapshot);
  await env.TEAM_DB.prepare(`INSERT OR IGNORE INTO schedule_versions
    (id, schedule_id, version_number, reason, snapshot_json, checksum, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(newId('schedule_version'), schedule.id, Number(schedule.version), String(reason || 'Schedule changed').slice(0, 120),
      snapshot, checksum, actorId || null, nowIso()).run();
  return { version: Number(schedule.version), checksum };
}

