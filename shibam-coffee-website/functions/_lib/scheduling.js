import { audit, hasRole, requireRole } from './auth.js';
import {
  ApiError, addDays, asBoolean, clampInt, minutesBetween, newId, normalizeDate,
  normalizeTime, nowIso, publicUser, safeJsonParse, weekStartFor
} from './http.js';

function scheduleDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    weekStart: row.week_start,
    status: row.status,
    version: Number(row.version),
    publishedAt: row.published_at || '',
    publishedBy: row.published_by || '',
    updatedAt: row.updated_at
  };
}

function shiftDto(row) {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    employeeId: row.employee_id || '',
    employeeName: row.employee_name || '',
    positionId: row.position_id || '',
    positionName: row.position_name || '',
    positionColor: row.position_color || '#A56A24',
    date: row.shift_date,
    startTime: row.start_time,
    endTime: row.end_time,
    breakMinutes: Number(row.break_minutes || 0),
    notes: row.notes || '',
    status: row.status,
    version: Number(row.version || 1),
    overrideReason: row.override_reason || '',
    confirmedAt: row.confirmed_at || ''
  };
}

async function listShifts(db, scheduleId, viewerId) {
  const { results } = await db.prepare(`SELECT sh.*, u.name AS employee_name,
      p.name AS position_name, p.color AS position_color, sc.confirmed_at
    FROM shifts sh
    LEFT JOIN users u ON u.id = sh.employee_id
    LEFT JOIN positions p ON p.id = sh.position_id
    LEFT JOIN shift_confirmations sc ON sc.shift_id = sh.id AND sc.employee_id = ?
    WHERE sh.schedule_id = ? AND sh.status != 'cancelled'
    ORDER BY sh.shift_date, sh.start_time, u.name`).bind(viewerId || '', scheduleId).all();
  return results.map(shiftDto);
}

async function listTeam(db) {
  const { results } = await db.prepare(`SELECT u.*,
      COALESCE(GROUP_CONCAT(ep.position_id), '') AS position_ids
    FROM users u LEFT JOIN employee_positions ep ON ep.user_id = u.id
    WHERE u.active = 1 GROUP BY u.id ORDER BY u.name`).all();
  return results.map((row) => {
    const user = publicUser(row);
    delete user.email;
    return { ...user, positionIds: row.position_ids ? row.position_ids.split(',') : [] };
  });
}

async function listPositions(db) {
  const { results } = await db.prepare('SELECT id, name, color FROM positions WHERE active = 1 ORDER BY name').all();
  return results;
}

async function getOrCreateSchedule(db, actor, weekStart, create) {
  let schedule = await db.prepare("SELECT * FROM schedules WHERE location_id = 'atlanta' AND week_start = ?")
    .bind(weekStart).first();
  if (!schedule && create) {
    const id = newId('schedule');
    const now = nowIso();
    await db.prepare(`INSERT INTO schedules
      (id, location_id, week_start, status, version, created_by, created_at, updated_at)
      VALUES (?, 'atlanta', ?, 'draft', 1, ?, ?, ?)`)
      .bind(id, weekStart, actor.id, now, now).run();
    schedule = await db.prepare('SELECT * FROM schedules WHERE id = ?').bind(id).first();
  }
  return schedule;
}

export async function getManagerSchedule(request, payload, env) {
  const actor = await requireRole(request, payload, env, 'lead');
  const weekStart = weekStartFor(payload.weekStart || new Date().toISOString().slice(0, 10));
  const schedule = await getOrCreateSchedule(env.TEAM_DB, actor, weekStart, asBoolean(payload.create));
  const [team, positions] = await Promise.all([listTeam(env.TEAM_DB), listPositions(env.TEAM_DB)]);
  if (!schedule) return { ok: true, schedule: null, shifts: [], team, positions, availability: [], availabilityExceptions: [], timeOff: [], requests: [] };
  const weekEnd = addDays(weekStart, 6);
  const [shifts, availabilityResult, exceptionResult, timeOffResult, requestResult] = await Promise.all([
    listShifts(env.TEAM_DB, schedule.id, actor.id),
    env.TEAM_DB.prepare(`SELECT * FROM availability_rules
      WHERE (effective_from IS NULL OR effective_from <= ?) AND (effective_to IS NULL OR effective_to >= ?)
      ORDER BY employee_id, weekday, start_time`).bind(weekEnd, weekStart).all(),
    env.TEAM_DB.prepare(`SELECT * FROM availability_exceptions
      WHERE exception_date BETWEEN ? AND ? ORDER BY employee_id, exception_date, start_time`)
      .bind(weekStart, weekEnd).all(),
    env.TEAM_DB.prepare(`SELECT tor.*, u.name AS employee_name FROM time_off_requests tor
      JOIN users u ON u.id = tor.employee_id
      WHERE tor.status IN ('pending', 'approved') AND tor.start_date <= ? AND tor.end_date >= ?
      ORDER BY tor.start_date, u.name`).bind(weekEnd, weekStart).all(),
    env.TEAM_DB.prepare(`SELECT sr.*, u.name AS employee_name, sh.shift_date, sh.start_time, sh.end_time,
      p.name AS position_name FROM shift_requests sr
      JOIN users u ON u.id = sr.employee_id JOIN shifts sh ON sh.id = sr.shift_id
      LEFT JOIN positions p ON p.id = sh.position_id
      WHERE sh.schedule_id = ? AND sr.status = 'pending' ORDER BY sr.submitted_at`).bind(schedule.id).all()
  ]);
  return {
    ok: true,
    schedule: scheduleDto(schedule),
    shifts,
    team,
    positions,
    availability: availabilityResult.results.map(availabilityDto),
    availabilityExceptions: exceptionResult.results.map(availabilityExceptionDto),
    timeOff: timeOffResult.results.map((row) => {
      const item = timeOffDto(row);
      if (!hasRole(actor, 'management')) {
        item.reason = '';
        item.reviewNote = '';
      }
      return item;
    }),
    requests: hasRole(actor, 'management') ? requestResult.results.map(shiftRequestDto) : []
  };
}

export async function getMySchedule(request, payload, env) {
  const actor = await requireRole(request, payload, env);
  const weekStart = weekStartFor(payload.weekStart || new Date().toISOString().slice(0, 10));
  const schedule = await env.TEAM_DB.prepare(`SELECT * FROM schedules
    WHERE location_id = 'atlanta' AND week_start = ? AND status = 'published'`).bind(weekStart).first();
  const [positions, notifications, availability, availabilityExceptions, timeOff, requests] = await Promise.all([
    listPositions(env.TEAM_DB),
    env.TEAM_DB.prepare(`SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 25`).bind(actor.id).all(),
    env.TEAM_DB.prepare(`SELECT * FROM availability_rules WHERE employee_id = ? ORDER BY weekday, start_time`).bind(actor.id).all(),
    env.TEAM_DB.prepare(`SELECT * FROM availability_exceptions WHERE employee_id = ?
      ORDER BY exception_date, start_time`).bind(actor.id).all(),
    env.TEAM_DB.prepare(`SELECT * FROM time_off_requests WHERE employee_id = ? ORDER BY submitted_at DESC LIMIT 50`).bind(actor.id).all(),
    env.TEAM_DB.prepare(`SELECT sr.*, sh.shift_date, sh.start_time, sh.end_time, p.name AS position_name
      FROM shift_requests sr JOIN shifts sh ON sh.id = sr.shift_id
      LEFT JOIN positions p ON p.id = sh.position_id WHERE sr.employee_id = ?
      ORDER BY sr.submitted_at DESC LIMIT 50`).bind(actor.id).all()
  ]);
  return {
    ok: true,
    schedule: scheduleDto(schedule),
    shifts: schedule ? await listShifts(env.TEAM_DB, schedule.id, actor.id) : [],
    positions,
    availability: availability.results.map(availabilityDto),
    availabilityExceptions: availabilityExceptions.results.map(availabilityExceptionDto),
    timeOff: timeOff.results.map(timeOffDto),
    requests: requests.results.map(shiftRequestDto),
    notifications: notifications.results.map(notificationDto),
    user: actor
  };
}

async function scheduleWarnings(db, input, shiftId, schedule) {
  if (!input.employeeId) return [];
  const employee = await db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').bind(input.employeeId).first();
  if (!employee) throw new ApiError('invalid_employee', 400);
  const warnings = [];
  const overlap = await db.prepare(`SELECT id FROM shifts WHERE employee_id = ? AND shift_date = ?
    AND status = 'active' AND id != ? AND start_time < ? AND end_time > ? LIMIT 1`)
    .bind(input.employeeId, input.date, shiftId || '', input.endTime, input.startTime).first();
  if (overlap) warnings.push({ code: 'overlapping_shift', message: 'This employee already has an overlapping shift.' });

  const timeOff = await db.prepare(`SELECT id FROM time_off_requests WHERE employee_id = ? AND status = 'approved'
    AND start_date <= ? AND end_date >= ? LIMIT 1`).bind(input.employeeId, input.date, input.date).first();
  if (timeOff) warnings.push({ code: 'approved_time_off', message: 'This employee has approved time off.' });

  const weekday = new Date(`${input.date}T12:00:00Z`).getUTCDay();
  const unavailable = await db.prepare(`SELECT id FROM availability_rules WHERE employee_id = ? AND weekday = ?
    AND preference = 'unavailable' AND start_time < ? AND end_time > ?
    AND (effective_from IS NULL OR effective_from <= ?) AND (effective_to IS NULL OR effective_to >= ?) LIMIT 1`)
    .bind(input.employeeId, weekday, input.endTime, input.startTime, input.date, input.date).first();
  const unavailableException = await db.prepare(`SELECT id FROM availability_exceptions WHERE employee_id = ?
    AND exception_date = ? AND preference = 'unavailable' AND start_time < ? AND end_time > ? LIMIT 1`)
    .bind(input.employeeId, input.date, input.endTime, input.startTime).first();
  if (unavailable || unavailableException) warnings.push({ code: 'unavailable', message: 'This shift conflicts with the employee’s availability.' });

  if (input.positionId) {
    const qualified = await db.prepare(`SELECT 1 AS found FROM employee_positions
      WHERE user_id = ? AND position_id = ?`).bind(input.employeeId, input.positionId).first();
    if (!qualified) warnings.push({ code: 'position_mismatch', message: 'This employee is not assigned to that position.' });
  }

  const { results } = await db.prepare(`SELECT start_time, end_time, break_minutes FROM shifts
    WHERE schedule_id = ? AND employee_id = ? AND status = 'active' AND id != ?`)
    .bind(schedule.id, input.employeeId, shiftId || '').all();
  const existingMinutes = results.reduce((sum, row) => sum + minutesBetween(row.start_time, row.end_time, row.break_minutes), 0);
  const total = existingMinutes + minutesBetween(input.startTime, input.endTime, input.breakMinutes);
  if (employee.max_weekly_minutes > 0 && total > employee.max_weekly_minutes) {
    warnings.push({ code: 'max_weekly_hours', message: `This assignment brings the employee to ${(total / 60).toFixed(1)} hours.` });
  }
  return warnings;
}

export async function saveShift(request, payload, env) {
  const actor = await requireRole(request, payload, env, 'lead');
  const input = payload.shift || {};
  const schedule = await env.TEAM_DB.prepare('SELECT * FROM schedules WHERE id = ?').bind(input.scheduleId).first();
  if (!schedule) throw new ApiError('schedule_not_found', 404);
  if (schedule.status === 'published' && !hasRole(actor, 'management')) throw new ApiError('published_schedule_management_only', 403);
  const date = normalizeDate(input.date, 'shift_date');
  if (date < schedule.week_start || date > addDays(schedule.week_start, 6)) throw new ApiError('shift_outside_schedule_week', 400);
  const normalized = {
    scheduleId: schedule.id,
    employeeId: String(input.employeeId || '') || null,
    positionId: String(input.positionId || '') || null,
    date,
    startTime: normalizeTime(input.startTime, 'start_time'),
    endTime: normalizeTime(input.endTime, 'end_time'),
    breakMinutes: clampInt(input.breakMinutes, 0, 720, 0),
    notes: String(input.notes || '').trim().slice(0, 350)
  };
  minutesBetween(normalized.startTime, normalized.endTime, normalized.breakMinutes);
  const existing = input.id
    ? await env.TEAM_DB.prepare('SELECT * FROM shifts WHERE id = ? AND schedule_id = ?').bind(input.id, schedule.id).first()
    : null;
  if (input.id && !existing) throw new ApiError('shift_not_found', 404);
  const warnings = await scheduleWarnings(env.TEAM_DB, normalized, input.id, schedule);
  const overrideReason = String(payload.overrideReason || '').trim();
  if (warnings.length && (!hasRole(actor, 'management') || !overrideReason)) {
    throw new ApiError('schedule_conflict', 409, { warnings, canOverride: hasRole(actor, 'management') });
  }

  const now = nowIso();
  let shiftId = input.id;
  if (existing) {
    const expectedVersion = clampInt(input.version, 1, Number.MAX_SAFE_INTEGER, Number(existing.version));
    const result = await env.TEAM_DB.prepare(`UPDATE shifts SET employee_id = ?, position_id = ?, shift_date = ?,
      start_time = ?, end_time = ?, break_minutes = ?, notes = ?, version = version + 1,
      override_reason = ?, updated_by = ?, updated_at = ? WHERE id = ? AND version = ?`)
      .bind(normalized.employeeId, normalized.positionId, normalized.date, normalized.startTime, normalized.endTime,
        normalized.breakMinutes, normalized.notes, overrideReason || null, actor.id, now, existing.id, expectedVersion).run();
    if (!result.meta.changes) throw new ApiError('version_conflict', 409);
  } else {
    shiftId = newId('shift');
    await env.TEAM_DB.prepare(`INSERT INTO shifts
      (id, schedule_id, employee_id, position_id, shift_date, start_time, end_time, break_minutes, notes,
       status, version, override_reason, created_by, created_at, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?, ?, ?)`)
      .bind(shiftId, schedule.id, normalized.employeeId, normalized.positionId, normalized.date,
        normalized.startTime, normalized.endTime, normalized.breakMinutes, normalized.notes,
        overrideReason || null, actor.id, now, actor.id, now).run();
  }
  await env.TEAM_DB.prepare('UPDATE schedules SET version = version + 1, updated_at = ? WHERE id = ?').bind(now, schedule.id).run();
  await audit(env.TEAM_DB, actor.id, existing ? 'shift.update' : 'shift.create', 'shift', shiftId, { warnings, overrideReason });
  if (schedule.status === 'published') {
    const affected = new Set([existing?.employee_id, normalized.employeeId].filter(Boolean));
    for (const userId of affected) {
      await notifyUser(env, userId, 'shift_changed', 'Your schedule changed',
        `A shift on ${normalized.date} was updated.`, '/team/schedule.html', `${shiftId}:v${Number(existing?.version || 0) + 1}:${userId}`);
    }
    if (!normalized.employeeId) {
      const eligibilityQuery = normalized.positionId
        ? `SELECT u.id FROM users u JOIN employee_positions ep ON ep.user_id = u.id
           WHERE u.active = 1 AND ep.position_id = ?`
        : 'SELECT id FROM users WHERE active = 1';
      const eligible = normalized.positionId
        ? await env.TEAM_DB.prepare(eligibilityQuery).bind(normalized.positionId).all()
        : await env.TEAM_DB.prepare(eligibilityQuery).all();
      for (const user of eligible.results) {
        await notifyUser(env, user.id, 'open_shift', 'Open shift available',
          `An open shift is available on ${normalized.date}.`, '/team/schedule.html', `${shiftId}:open:v${Number(existing?.version || 0) + 1}:${user.id}`);
      }
    }
  }
  const row = await env.TEAM_DB.prepare(`SELECT sh.*, u.name AS employee_name, p.name AS position_name,
    p.color AS position_color FROM shifts sh LEFT JOIN users u ON u.id = sh.employee_id
    LEFT JOIN positions p ON p.id = sh.position_id WHERE sh.id = ?`).bind(shiftId).first();
  return { ok: true, shift: shiftDto(row), warnings };
}

export async function cancelShift(request, payload, env) {
  const actor = await requireRole(request, payload, env, 'lead');
  const shift = await env.TEAM_DB.prepare(`SELECT sh.*, s.status AS schedule_status FROM shifts sh
    JOIN schedules s ON s.id = sh.schedule_id WHERE sh.id = ?`).bind(payload.shiftId).first();
  if (!shift) throw new ApiError('shift_not_found', 404);
  if (shift.schedule_status === 'published' && !hasRole(actor, 'management')) throw new ApiError('forbidden', 403);
  const now = nowIso();
  await env.TEAM_DB.batch([
    env.TEAM_DB.prepare(`UPDATE shifts SET status = 'cancelled', version = version + 1, updated_by = ?, updated_at = ? WHERE id = ?`)
      .bind(actor.id, now, shift.id),
    env.TEAM_DB.prepare('UPDATE schedules SET version = version + 1, updated_at = ? WHERE id = ?').bind(now, shift.schedule_id)
  ]);
  await audit(env.TEAM_DB, actor.id, 'shift.cancel', 'shift', shift.id, { reason: String(payload.reason || '') });
  if (shift.schedule_status === 'published' && shift.employee_id) {
    await notifyUser(env, shift.employee_id, 'shift_cancelled', 'Shift cancelled',
      `Your shift on ${shift.shift_date} was cancelled.`, '/team/schedule.html', `${shift.id}:cancelled:${shift.version + 1}`);
  }
  return { ok: true };
}

export async function copySchedule(request, payload, env) {
  const actor = await requireRole(request, payload, env, 'lead');
  const sourceWeek = weekStartFor(payload.sourceWeekStart);
  const targetWeek = weekStartFor(payload.targetWeekStart);
  if (sourceWeek === targetWeek) throw new ApiError('same_schedule_week', 400);
  const source = await env.TEAM_DB.prepare("SELECT * FROM schedules WHERE location_id = 'atlanta' AND week_start = ?").bind(sourceWeek).first();
  if (!source) throw new ApiError('source_schedule_not_found', 404);
  let target = await getOrCreateSchedule(env.TEAM_DB, actor, targetWeek, true);
  if (target.status !== 'draft') throw new ApiError('target_already_published', 409);
  const count = await env.TEAM_DB.prepare("SELECT COUNT(*) AS total FROM shifts WHERE schedule_id = ? AND status = 'active'").bind(target.id).first();
  if (Number(count.total) > 0) throw new ApiError('target_not_empty', 409);
  const { results } = await env.TEAM_DB.prepare("SELECT * FROM shifts WHERE schedule_id = ? AND status = 'active'").bind(source.id).all();
  const now = nowIso();
  const dayOffset = Math.round((new Date(`${targetWeek}T12:00:00Z`) - new Date(`${sourceWeek}T12:00:00Z`)) / 86400000);
  const statements = results.map((shift) => env.TEAM_DB.prepare(`INSERT INTO shifts
    (id, schedule_id, employee_id, position_id, shift_date, start_time, end_time, break_minutes, notes,
     status, version, created_by, created_at, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?, ?)`)
    .bind(newId('shift'), target.id, shift.employee_id, shift.position_id, addDays(shift.shift_date, dayOffset),
      shift.start_time, shift.end_time, shift.break_minutes, shift.notes, actor.id, now, actor.id, now));
  if (statements.length) await env.TEAM_DB.batch(statements);
  await env.TEAM_DB.prepare('UPDATE schedules SET version = version + 1, updated_at = ? WHERE id = ?').bind(now, target.id).run();
  await audit(env.TEAM_DB, actor.id, 'schedule.copy', 'schedule', target.id, { sourceWeek, targetWeek, shifts: statements.length });
  target = await env.TEAM_DB.prepare('SELECT * FROM schedules WHERE id = ?').bind(target.id).first();
  return { ok: true, schedule: scheduleDto(target), copiedShifts: statements.length };
}

export async function publishSchedule(request, payload, env) {
  const actor = await requireRole(request, payload, env, 'management');
  const schedule = await env.TEAM_DB.prepare('SELECT * FROM schedules WHERE id = ?').bind(payload.scheduleId).first();
  if (!schedule) throw new ApiError('schedule_not_found', 404);
  const shifts = await env.TEAM_DB.prepare("SELECT COUNT(*) AS total FROM shifts WHERE schedule_id = ? AND status = 'active'").bind(schedule.id).first();
  if (!Number(shifts.total)) throw new ApiError('empty_schedule', 409);
  const now = nowIso();
  const newVersion = Number(schedule.version) + 1;
  await env.TEAM_DB.prepare(`UPDATE schedules SET status = 'published', version = ?, published_at = ?,
    published_by = ?, updated_at = ? WHERE id = ?`).bind(newVersion, now, actor.id, now, schedule.id).run();
  const { results: employees } = await env.TEAM_DB.prepare('SELECT id FROM users WHERE active = 1').all();
  for (const employee of employees) {
    await notifyUser(env, employee.id, 'schedule_published', 'New schedule published',
      `Your schedule for the week of ${schedule.week_start} is ready.`, '/team/schedule.html', `${schedule.id}:published:v${newVersion}:${employee.id}`);
  }
  await audit(env.TEAM_DB, actor.id, 'schedule.publish', 'schedule', schedule.id, { version: newVersion, notified: employees.length });
  return { ok: true, version: newVersion, publishedAt: now };
}

function availabilityDto(row) {
  return {
    id: row.id,
    employeeId: row.employee_id,
    weekday: Number(row.weekday),
    preference: row.preference,
    startTime: row.start_time,
    endTime: row.end_time,
    effectiveFrom: row.effective_from || '',
    effectiveTo: row.effective_to || ''
  };
}

function availabilityExceptionDto(row) {
  return {
    id: row.id,
    employeeId: row.employee_id,
    date: row.exception_date,
    preference: row.preference,
    startTime: row.start_time,
    endTime: row.end_time,
    note: row.note || '',
    allDay: row.start_time === '00:00' && row.end_time === '23:59'
  };
}

export async function replaceAvailability(request, payload, env) {
  const actor = await requireRole(request, payload, env);
  const inputRules = Array.isArray(payload.availability) ? payload.availability : [];
  if (inputRules.length > 35) throw new ApiError('too_many_availability_rules', 400);

  const rules = inputRules.map((input) => {
    const weekday = clampInt(input.weekday, 0, 6, -1);
    if (weekday < 0 || !['preferred', 'unavailable'].includes(input.preference)) {
      throw new ApiError('invalid_availability', 400);
    }
    const startTime = normalizeTime(input.startTime, 'start_time');
    const endTime = normalizeTime(input.endTime, 'end_time');
    minutesBetween(startTime, endTime, 0);
    return { weekday, preference: input.preference, startTime, endTime };
  }).sort((left, right) => left.weekday - right.weekday || left.startTime.localeCompare(right.startTime));

  rules.forEach((rule, index) => {
    const previous = rules[index - 1];
    if (previous && previous.weekday === rule.weekday && previous.endTime > rule.startTime) {
      throw new ApiError('overlapping_availability', 400);
    }
  });

  const now = nowIso();
  const statements = [env.TEAM_DB.prepare('DELETE FROM availability_rules WHERE employee_id = ?').bind(actor.id)];
  rules.forEach((rule) => {
    statements.push(env.TEAM_DB.prepare(`INSERT INTO availability_rules
      (id, employee_id, weekday, preference, start_time, end_time, effective_from, effective_to, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`)
      .bind(newId('availability'), actor.id, rule.weekday, rule.preference, rule.startTime, rule.endTime, now, now));
  });
  await env.TEAM_DB.batch(statements);
  await audit(env.TEAM_DB, actor.id, 'availability.replace_week', 'availability', actor.id, { ruleCount: rules.length });
  return { ok: true };
}

export async function saveAvailability(request, payload, env) {
  const actor = await requireRole(request, payload, env);
  const input = payload.availability || {};
  const weekday = clampInt(input.weekday, 0, 6, -1);
  if (weekday < 0 || !['preferred', 'unavailable'].includes(input.preference)) throw new ApiError('invalid_availability', 400);
  const startTime = normalizeTime(input.startTime, 'start_time');
  const endTime = normalizeTime(input.endTime, 'end_time');
  minutesBetween(startTime, endTime, 0);
  const id = input.id || newId('availability');
  const now = nowIso();
  if (input.id) {
    const result = await env.TEAM_DB.prepare(`UPDATE availability_rules SET weekday = ?, preference = ?, start_time = ?,
      end_time = ?, effective_from = ?, effective_to = ?, updated_at = ? WHERE id = ? AND employee_id = ?`)
      .bind(weekday, input.preference, startTime, endTime, input.effectiveFrom || null, input.effectiveTo || null, now, id, actor.id).run();
    if (!result.meta.changes) throw new ApiError('not_found', 404);
  } else {
    await env.TEAM_DB.prepare(`INSERT INTO availability_rules
      (id, employee_id, weekday, preference, start_time, end_time, effective_from, effective_to, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, actor.id, weekday, input.preference, startTime, endTime, input.effectiveFrom || null, input.effectiveTo || null, now, now).run();
  }
  await audit(env.TEAM_DB, actor.id, input.id ? 'availability.update' : 'availability.create', 'availability', id, {});
  return { ok: true, id };
}

export async function deleteAvailability(request, payload, env) {
  const actor = await requireRole(request, payload, env);
  const result = await env.TEAM_DB.prepare('DELETE FROM availability_rules WHERE id = ? AND employee_id = ?')
    .bind(payload.availabilityId, actor.id).run();
  if (!result.meta.changes) throw new ApiError('not_found', 404);
  await audit(env.TEAM_DB, actor.id, 'availability.delete', 'availability', payload.availabilityId, {});
  return { ok: true };
}

export async function saveAvailabilityException(request, payload, env) {
  const actor = await requireRole(request, payload, env);
  const input = payload.exception || {};
  const date = normalizeDate(input.date, 'exception_date');
  if (!['preferred', 'unavailable'].includes(input.preference)) throw new ApiError('invalid_availability', 400);
  const allDay = asBoolean(input.allDay);
  const startTime = allDay ? '00:00' : normalizeTime(input.startTime, 'start_time');
  const endTime = allDay ? '23:59' : normalizeTime(input.endTime, 'end_time');
  minutesBetween(startTime, endTime, 0);
  const note = String(input.note || '').trim().slice(0, 350);
  const existing = input.id
    ? await env.TEAM_DB.prepare('SELECT * FROM availability_exceptions WHERE id = ? AND employee_id = ?')
      .bind(input.id, actor.id).first()
    : await env.TEAM_DB.prepare('SELECT * FROM availability_exceptions WHERE employee_id = ? AND exception_date = ? ORDER BY updated_at DESC LIMIT 1')
      .bind(actor.id, date).first();
  const now = nowIso();
  const id = existing?.id || newId('availability_exception');
  if (existing) {
    await env.TEAM_DB.prepare(`UPDATE availability_exceptions SET exception_date = ?, preference = ?, start_time = ?,
      end_time = ?, note = ?, updated_at = ? WHERE id = ? AND employee_id = ?`)
      .bind(date, input.preference, startTime, endTime, note, now, id, actor.id).run();
  } else {
    await env.TEAM_DB.prepare(`INSERT INTO availability_exceptions
      (id, employee_id, exception_date, preference, start_time, end_time, note, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, actor.id, date, input.preference, startTime, endTime, note, now, now).run();
  }
  await audit(env.TEAM_DB, actor.id, existing ? 'availability_exception.update' : 'availability_exception.create',
    'availability_exception', id, { date, allDay });
  return { ok: true, id };
}

export async function deleteAvailabilityException(request, payload, env) {
  const actor = await requireRole(request, payload, env);
  const id = String(payload.exceptionId || '');
  const result = await env.TEAM_DB.prepare('DELETE FROM availability_exceptions WHERE id = ? AND employee_id = ?')
    .bind(id, actor.id).run();
  if (!result.meta.changes) throw new ApiError('not_found', 404);
  await audit(env.TEAM_DB, actor.id, 'availability_exception.delete', 'availability_exception', id, {});
  return { ok: true };
}

function timeOffDto(row) {
  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeName: row.employee_name || '',
    startDate: row.start_date,
    endDate: row.end_date,
    startTime: row.start_time || '',
    endTime: row.end_time || '',
    type: row.request_type,
    reason: row.reason,
    status: row.status,
    submittedAt: row.submitted_at,
    reviewedAt: row.reviewed_at || '',
    reviewNote: row.review_note || ''
  };
}

export async function submitTimeOff(request, payload, env) {
  const actor = await requireRole(request, payload, env);
  const input = payload.request || {};
  const startDate = normalizeDate(input.startDate, 'start_date');
  const endDate = normalizeDate(input.endDate || input.startDate, 'end_date');
  if (endDate < startDate) throw new ApiError('invalid_date_range', 400);
  const type = ['unpaid', 'pto', 'sick', 'other'].includes(input.type) ? input.type : 'unpaid';
  const startTime = input.startTime ? normalizeTime(input.startTime, 'start_time') : null;
  const endTime = input.endTime ? normalizeTime(input.endTime, 'end_time') : null;
  if ((startTime && !endTime) || (!startTime && endTime)) throw new ApiError('incomplete_time_range', 400);
  if (startTime) minutesBetween(startTime, endTime, 0);
  const id = newId('timeoff');
  await env.TEAM_DB.prepare(`INSERT INTO time_off_requests
    (id, employee_id, start_date, end_date, start_time, end_time, request_type, reason, status, submitted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
    .bind(id, actor.id, startDate, endDate, startTime, endTime, type, String(input.reason || '').trim().slice(0, 500), nowIso()).run();
  await audit(env.TEAM_DB, actor.id, 'timeoff.submit', 'time_off_request', id, { startDate, endDate, type });
  return { ok: true, id };
}

export async function reviewTimeOff(request, payload, env) {
  const actor = await requireRole(request, payload, env, 'management');
  const status = String(payload.status || '');
  if (!['approved', 'declined'].includes(status)) throw new ApiError('invalid_status', 400);
  const existing = await env.TEAM_DB.prepare("SELECT * FROM time_off_requests WHERE id = ? AND status = 'pending'").bind(payload.requestId).first();
  if (!existing) throw new ApiError('request_not_pending', 409);
  const now = nowIso();
  await env.TEAM_DB.prepare(`UPDATE time_off_requests SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?`)
    .bind(status, actor.id, now, String(payload.note || '').trim().slice(0, 500), existing.id).run();
  await notifyUser(env, existing.employee_id, 'time_off_reviewed', `Time off ${status}`,
    `Your ${existing.start_date}–${existing.end_date} request was ${status}.`, '/team/schedule.html', `${existing.id}:${status}`);
  await audit(env.TEAM_DB, actor.id, `timeoff.${status}`, 'time_off_request', existing.id, {});
  return { ok: true };
}

function shiftRequestDto(row) {
  return {
    id: row.id,
    shiftId: row.shift_id,
    employeeId: row.employee_id,
    employeeName: row.employee_name || '',
    type: row.request_type,
    note: row.note,
    status: row.status,
    submittedAt: row.submitted_at,
    date: row.shift_date,
    startTime: row.start_time,
    endTime: row.end_time,
    positionName: row.position_name || '',
    reviewNote: row.review_note || ''
  };
}

export async function requestOpenShift(request, payload, env) {
  const actor = await requireRole(request, payload, env);
  const shift = await env.TEAM_DB.prepare(`SELECT sh.*, s.status AS schedule_status FROM shifts sh
    JOIN schedules s ON s.id = sh.schedule_id WHERE sh.id = ? AND sh.status = 'active'`).bind(payload.shiftId).first();
  if (!shift || shift.schedule_status !== 'published') throw new ApiError('shift_not_available', 409);
  if (shift.employee_id) throw new ApiError('shift_already_assigned', 409);
  const warnings = await scheduleWarnings(env.TEAM_DB, {
    employeeId: actor.id,
    positionId: shift.position_id,
    date: shift.shift_date,
    startTime: shift.start_time,
    endTime: shift.end_time,
    breakMinutes: shift.break_minutes
  }, shift.id, { id: shift.schedule_id });
  if (warnings.length) throw new ApiError('not_eligible', 409, { warnings });
  const id = newId('shiftrequest');
  try {
    await env.TEAM_DB.prepare(`INSERT INTO shift_requests
      (id, shift_id, employee_id, request_type, note, status, submitted_at)
      VALUES (?, ?, ?, 'open_pickup', ?, 'pending', ?)`)
      .bind(id, shift.id, actor.id, String(payload.note || '').trim().slice(0, 350), nowIso()).run();
  } catch (error) {
    if (String(error).includes('UNIQUE')) throw new ApiError('request_already_pending', 409);
    throw error;
  }
  await audit(env.TEAM_DB, actor.id, 'shift_request.submit', 'shift_request', id, { shiftId: shift.id });
  return { ok: true, id };
}

export async function reviewShiftRequest(request, payload, env) {
  const actor = await requireRole(request, payload, env, 'management');
  const status = String(payload.status || '');
  if (!['approved', 'declined'].includes(status)) throw new ApiError('invalid_status', 400);
  const existing = await env.TEAM_DB.prepare(`SELECT sr.*, sh.employee_id AS assigned_employee_id,
    sh.shift_date, sh.start_time, sh.end_time, sh.break_minutes, sh.position_id, sh.schedule_id
    FROM shift_requests sr JOIN shifts sh ON sh.id = sr.shift_id
    WHERE sr.id = ? AND sr.status = 'pending'`).bind(payload.requestId).first();
  if (!existing) throw new ApiError('request_not_pending', 409);
  const now = nowIso();
  if (status === 'approved') {
    const warnings = await scheduleWarnings(env.TEAM_DB, {
      employeeId: existing.employee_id,
      positionId: existing.position_id,
      date: existing.shift_date,
      startTime: existing.start_time,
      endTime: existing.end_time,
      breakMinutes: existing.break_minutes
    }, existing.shift_id, { id: existing.schedule_id });
    if (warnings.length) throw new ApiError('request_no_longer_eligible', 409, { warnings });
    const { results: otherPending } = await env.TEAM_DB.prepare(`SELECT id, employee_id FROM shift_requests
      WHERE shift_id = ? AND id != ? AND status = 'pending'`).bind(existing.shift_id, existing.id).all();
    const assignment = await env.TEAM_DB.prepare(`UPDATE shifts SET employee_id = ?, version = version + 1,
      updated_by = ?, updated_at = ? WHERE id = ? AND employee_id IS NULL AND status = 'active'`)
      .bind(existing.employee_id, actor.id, now, existing.shift_id).run();
    if (!assignment.meta.changes) throw new ApiError('shift_already_assigned', 409);
    await env.TEAM_DB.batch([
      env.TEAM_DB.prepare(`UPDATE shift_requests SET status = 'approved', reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?`)
        .bind(actor.id, now, String(payload.note || '').trim().slice(0, 500), existing.id),
      env.TEAM_DB.prepare(`UPDATE shift_requests SET status = 'declined', reviewed_by = ?, reviewed_at = ?,
        review_note = 'Another employee was approved.' WHERE shift_id = ? AND id != ? AND status = 'pending'`)
        .bind(actor.id, now, existing.shift_id, existing.id)
    ]);
    for (const other of otherPending) {
      await notifyUser(env, other.employee_id, 'shift_request_reviewed', 'Open shift request declined',
        `Another employee was assigned the ${existing.shift_date} shift.`, '/team/schedule.html', `${other.id}:declined`);
    }
  } else {
    await env.TEAM_DB.prepare(`UPDATE shift_requests SET status = 'declined', reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?`)
      .bind(actor.id, now, String(payload.note || '').trim().slice(0, 500), existing.id).run();
  }
  await notifyUser(env, existing.employee_id, 'shift_request_reviewed', `Open shift request ${status}`,
    `Your request for the ${existing.shift_date} shift was ${status}.`, '/team/schedule.html', `${existing.id}:${status}`);
  await audit(env.TEAM_DB, actor.id, `shift_request.${status}`, 'shift_request', existing.id, {});
  return { ok: true };
}

export async function confirmShift(request, payload, env) {
  const actor = await requireRole(request, payload, env);
  const shift = await env.TEAM_DB.prepare(`SELECT sh.id FROM shifts sh JOIN schedules s ON s.id = sh.schedule_id
    WHERE sh.id = ? AND sh.employee_id = ? AND sh.status = 'active' AND s.status = 'published'`)
    .bind(payload.shiftId, actor.id).first();
  if (!shift) throw new ApiError('shift_not_found', 404);
  const now = nowIso();
  await env.TEAM_DB.prepare(`INSERT INTO shift_confirmations (shift_id, employee_id, confirmed_at)
    VALUES (?, ?, ?) ON CONFLICT(shift_id, employee_id) DO UPDATE SET confirmed_at = excluded.confirmed_at`)
    .bind(shift.id, actor.id, now).run();
  await audit(env.TEAM_DB, actor.id, 'shift.confirm', 'shift', shift.id, {});
  return { ok: true, confirmedAt: now };
}

function notificationDto(row) {
  return {
    id: row.id,
    type: row.notification_type,
    title: row.title,
    message: row.message,
    link: row.link || '',
    readAt: row.read_at || '',
    createdAt: row.created_at
  };
}

export async function markNotificationsRead(request, payload, env) {
  const actor = await requireRole(request, payload, env);
  const ids = Array.isArray(payload.notificationIds) ? payload.notificationIds.slice(0, 100) : [];
  if (!ids.length) return { ok: true };
  const statements = ids.map((id) => env.TEAM_DB.prepare(`UPDATE notifications SET read_at = ?
    WHERE id = ? AND user_id = ? AND read_at IS NULL`).bind(nowIso(), id, actor.id));
  await env.TEAM_DB.batch(statements);
  return { ok: true };
}

async function notifyUser(env, userId, type, title, message, link, idempotencyKey) {
  const id = newId('notification');
  const result = await env.TEAM_DB.prepare(`INSERT OR IGNORE INTO notifications
    (id, user_id, notification_type, title, message, link, idempotency_key, email_status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
    .bind(id, userId, type, title, message, link || null, idempotencyKey, nowIso()).run();
  if (result.meta.changes && env.NOTIFICATIONS?.send) {
    try {
      await env.NOTIFICATIONS.send({ notificationId: id });
      await env.TEAM_DB.prepare("UPDATE notifications SET email_status = 'queued' WHERE id = ?").bind(id).run();
    } catch (error) {
      await env.TEAM_DB.prepare("UPDATE notifications SET email_status = 'failed', email_last_error = ? WHERE id = ?")
        .bind(String(error).slice(0, 500), id).run();
    }
  }
}

export async function getAuditLog(request, payload, env) {
  await requireRole(request, payload, env, 'management');
  const limit = clampInt(payload.limit, 1, 500, 100);
  const { results } = await env.TEAM_DB.prepare(`SELECT ae.*, u.name AS actor_name FROM audit_events ae
    LEFT JOIN users u ON u.id = ae.actor_user_id ORDER BY ae.created_at DESC LIMIT ?`).bind(limit).all();
  return { ok: true, events: results.map((row) => ({
    id: row.id,
    actorName: row.actor_name || 'System',
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id || '',
    details: safeJsonParse(row.details_json),
    createdAt: row.created_at
  })) };
}
