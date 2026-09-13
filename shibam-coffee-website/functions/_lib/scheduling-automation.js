import { audit, hasRole, requireRole } from './auth.js';
import { ApiError, addDays, clampInt, minutesBetween, nowIso } from './http.js';
import { captureScheduleVersion } from './schedule-snapshots.js';
import { notifyUser } from './scheduling.js';

function minuteOfDay(value, endBoundary = false) {
  const [hour, minute] = String(value).split(':').map(Number);
  return endBoundary && hour === 0 && minute === 0 ? 1440 : hour * 60 + minute;
}

function absoluteInterval(date, startTime, endTime) {
  const day = Math.floor(Date.parse(`${date}T00:00:00Z`) / 86400000);
  const start = day * 1440 + minuteOfDay(startTime);
  let end = day * 1440 + minuteOfDay(endTime);
  if (end <= start) end += 1440;
  return { start, end };
}

function overlaps(left, right) {
  return left.start < right.end && right.start < left.end;
}

function shiftSegments(shift) {
  const start = minuteOfDay(shift.start_time);
  const end = minuteOfDay(shift.end_time);
  if (end > start) return [{ date: shift.shift_date, start, end }];
  const segments = [{ date: shift.shift_date, start, end: 1440 }];
  if (end > 0) segments.push({ date: addDays(shift.shift_date, 1), start: 0, end });
  return segments;
}

function availabilityRange(row) {
  return { start: minuteOfDay(row.start_time), end: minuteOfDay(row.end_time, true) };
}

function ruleApplies(rule, employeeId, date, weekday, segment) {
  return rule.employee_id === employeeId && Number(rule.weekday) === weekday &&
    (!rule.effective_from || rule.effective_from <= date) && (!rule.effective_to || rule.effective_to >= date) &&
    overlaps(availabilityRange(rule), segment);
}

function exceptionApplies(item, employeeId, date, segment) {
  return item.employee_id === employeeId && item.exception_date === date && overlaps(availabilityRange(item), segment);
}

function availabilityState(employeeId, shift, rules, exceptions) {
  let preferred = false;
  for (const segment of shiftSegments(shift)) {
    const weekday = new Date(`${segment.date}T12:00:00Z`).getUTCDay();
    const dateExceptions = exceptions.filter((item) => exceptionApplies(item, employeeId, segment.date, segment));
    const applicable = dateExceptions.length
      ? dateExceptions
      : rules.filter((item) => ruleApplies(item, employeeId, segment.date, weekday, segment));
    if (applicable.some((item) => item.preference === 'unavailable')) return { blocked: true, preferred: false };
    preferred ||= applicable.some((item) => item.preference === 'preferred');
  }
  return { blocked: false, preferred };
}

function hasTimeOff(employeeId, shift, timeOff) {
  return shiftSegments(shift).some((segment) => timeOff.some((item) => {
    if (item.employee_id !== employeeId || item.start_date > segment.date || item.end_date < segment.date) return false;
    if (!item.start_time || !item.end_time) return true;
    return overlaps({ start: minuteOfDay(item.start_time), end: minuteOfDay(item.end_time, true) }, segment);
  }));
}

function normalizeCriteria(payload) {
  const input = payload.criteria || {};
  const uniqueStrings = (value, limit) => [...new Set((Array.isArray(value) ? value : [])
    .map((item) => String(item || '').trim()).filter(Boolean))].slice(0, limit);
  return {
    shiftIds: uniqueStrings(input.shiftIds, 100),
    employeeIds: uniqueStrings(input.employeeIds, 100),
    positionIds: uniqueStrings(input.positionIds, 20),
    maxNewShiftsPerEmployee: clampInt(input.maxNewShiftsPerEmployee, 1, 14, 7),
    prioritizePreferred: input.prioritizePreferred !== false
  };
}

async function scheduleForAutomation(request, payload, env, actor) {
  const schedule = await env.TEAM_DB.prepare('SELECT * FROM schedules WHERE id = ?').bind(payload.scheduleId).first();
  if (!schedule) throw new ApiError('schedule_not_found', 404);
  if (schedule.status === 'published' && !hasRole(actor, 'management')) {
    throw new ApiError('published_schedule_management_only', 403);
  }
  const expectedVersion = clampInt(payload.expectedScheduleVersion, 1, Number.MAX_SAFE_INTEGER, Number(schedule.version));
  if (Number(schedule.version) !== expectedVersion) throw new ApiError('version_conflict', 409);
  return schedule;
}

async function buildPlan(request, payload, env) {
  const actor = await requireRole(request, payload, env, 'lead');
  const schedule = await scheduleForAutomation(request, payload, env, actor);
  const criteria = normalizeCriteria(payload);
  const weekEnd = addDays(schedule.week_start, 6);
  const [shiftResult, teamResult, rulesResult, exceptionsResult, timeOffResult, nearbyResult] = await Promise.all([
    env.TEAM_DB.prepare(`SELECT sh.*, p.name AS position_name FROM shifts sh
      LEFT JOIN positions p ON p.id = sh.position_id
      WHERE sh.schedule_id = ? AND sh.status = 'active' AND sh.employee_id IS NULL
      ORDER BY sh.shift_date, sh.start_time, sh.id`).bind(schedule.id).all(),
    env.TEAM_DB.prepare(`SELECT u.id, u.name, u.max_weekly_minutes,
        COALESCE(GROUP_CONCAT(ep.position_id), '') AS position_ids
      FROM users u LEFT JOIN employee_positions ep ON ep.user_id = u.id
      WHERE u.active = 1 AND LOWER(u.username) <> 'admin'
      GROUP BY u.id ORDER BY u.name`).all(),
    env.TEAM_DB.prepare(`SELECT * FROM availability_rules
      WHERE (effective_from IS NULL OR effective_from <= ?) AND (effective_to IS NULL OR effective_to >= ?)`)
      .bind(weekEnd, schedule.week_start).all(),
    env.TEAM_DB.prepare('SELECT * FROM availability_exceptions WHERE exception_date BETWEEN ? AND ?')
      .bind(schedule.week_start, addDays(weekEnd, 1)).all(),
    env.TEAM_DB.prepare(`SELECT * FROM time_off_requests WHERE status = 'approved'
      AND start_date <= ? AND end_date >= ?`).bind(addDays(weekEnd, 1), schedule.week_start).all(),
    env.TEAM_DB.prepare(`SELECT id, employee_id, shift_date, start_time, end_time, break_minutes
      FROM shifts WHERE employee_id IS NOT NULL AND status = 'active' AND shift_date BETWEEN ? AND ?`)
      .bind(addDays(schedule.week_start, -1), weekEnd).all()
  ]);

  let openShifts = shiftResult.results;
  if (criteria.shiftIds.length) {
    const selected = new Set(criteria.shiftIds);
    openShifts = openShifts.filter((shift) => selected.has(shift.id));
    if (openShifts.length !== selected.size) throw new ApiError('shift_selection_changed', 409);
  }
  if (criteria.positionIds.length) {
    const positions = new Set(criteria.positionIds);
    openShifts = openShifts.filter((shift) => positions.has(shift.position_id));
  }

  let team = teamResult.results.map((row) => ({
    ...row,
    positionIds: row.position_ids ? String(row.position_ids).split(',') : [],
    currentMinutes: nearbyResult.results
      .filter((shift) => shift.employee_id === row.id && shift.shift_date >= schedule.week_start && shift.shift_date <= weekEnd)
      .reduce((sum, shift) => sum + minutesBetween(shift.start_time, shift.end_time, shift.break_minutes, true), 0),
    plannedMinutes: 0,
    plannedCount: 0
  }));
  if (criteria.employeeIds.length) {
    const employees = new Set(criteria.employeeIds);
    team = team.filter((employee) => employees.has(employee.id));
  }

  const planned = [];
  const assignments = [];
  const unassigned = [];
  for (const shift of openShifts) {
    const duration = minutesBetween(shift.start_time, shift.end_time, shift.break_minutes, true);
    const interval = absoluteInterval(shift.shift_date, shift.start_time, shift.end_time);
    const candidates = team.filter((employee) => {
      if (employee.plannedCount >= criteria.maxNewShiftsPerEmployee) return false;
      if (shift.position_id && !employee.positionIds.includes(shift.position_id)) return false;
      if (hasTimeOff(employee.id, shift, timeOffResult.results)) return false;
      const availability = availabilityState(employee.id, shift, rulesResult.results, exceptionsResult.results);
      if (availability.blocked) return false;
      const conflicts = nearbyResult.results.concat(planned).some((item) => item.employee_id === employee.id &&
        overlaps(interval, absoluteInterval(item.shift_date, item.start_time, item.end_time)));
      if (conflicts) return false;
      const weeklyLimit = Number(employee.max_weekly_minutes || 0);
      return !weeklyLimit || employee.currentMinutes + employee.plannedMinutes + duration <= weeklyLimit;
    }).map((employee) => ({
      employee,
      preferred: availabilityState(employee.id, shift, rulesResult.results, exceptionsResult.results).preferred
    }));

    candidates.sort((left, right) => {
      if (criteria.prioritizePreferred && left.preferred !== right.preferred) return left.preferred ? -1 : 1;
      const leftMinutes = left.employee.currentMinutes + left.employee.plannedMinutes;
      const rightMinutes = right.employee.currentMinutes + right.employee.plannedMinutes;
      return leftMinutes - rightMinutes || left.employee.plannedCount - right.employee.plannedCount ||
        String(left.employee.name).localeCompare(String(right.employee.name));
    });
    const selected = candidates[0];
    if (!selected) {
      unassigned.push({ shiftId: shift.id, date: shift.shift_date, startTime: shift.start_time,
        endTime: shift.end_time, positionName: shift.position_name || 'Shift', reason: 'No eligible employee met all selected criteria.' });
      continue;
    }
    selected.employee.plannedMinutes += duration;
    selected.employee.plannedCount += 1;
    planned.push({ ...shift, employee_id: selected.employee.id });
    assignments.push({ shiftId: shift.id, shiftVersion: Number(shift.version), employeeId: selected.employee.id,
      employeeName: selected.employee.name, date: shift.shift_date, startTime: shift.start_time,
      endTime: shift.end_time, positionName: shift.position_name || 'Shift', preferred: selected.preferred });
  }
  return { actor, schedule, criteria, assignments, unassigned, consideredShifts: openShifts.length };
}

export async function previewAutoAssign(request, payload, env) {
  const plan = await buildPlan(request, payload, env);
  return { ok: true, scheduleVersion: Number(plan.schedule.version), criteria: plan.criteria,
    assignments: plan.assignments, unassigned: plan.unassigned, consideredShifts: plan.consideredShifts };
}

export async function applyAutoAssign(request, payload, env) {
  const plan = await buildPlan(request, payload, env);
  if (!plan.assignments.length) return { ok: true, assignedCount: 0, unassigned: plan.unassigned };
  const values = plan.assignments.map(() => '(?, ?, ?)').join(', ');
  const valueBindings = plan.assignments.flatMap((item) => [item.shiftId, item.shiftVersion, item.employeeId]);
  const now = nowIso();
  const update = await env.TEAM_DB.prepare(`WITH assignments(id, version, employee_id) AS (VALUES ${values})
    UPDATE shifts SET employee_id = (SELECT employee_id FROM assignments WHERE id = shifts.id),
      version = version + 1, override_reason = NULL, updated_by = ?, updated_at = ?
    WHERE id IN (SELECT id FROM assignments) AND schedule_id = ? AND status = 'active' AND employee_id IS NULL
      AND EXISTS (SELECT 1 FROM schedules WHERE id = ? AND version = ?)
      AND (SELECT COUNT(*) FROM shifts sh JOIN assignments a ON a.id = sh.id AND a.version = sh.version
        WHERE sh.schedule_id = ? AND sh.status = 'active' AND sh.employee_id IS NULL) = ?`)
    .bind(...valueBindings, plan.actor.id, now, plan.schedule.id, plan.schedule.id, Number(plan.schedule.version),
      plan.schedule.id, plan.assignments.length).run();
  if (Number(update.meta.changes) !== plan.assignments.length) throw new ApiError('version_conflict', 409);
  await env.TEAM_DB.prepare('UPDATE schedules SET version = version + 1, updated_at = ? WHERE id = ? AND version = ?')
    .bind(now, plan.schedule.id, Number(plan.schedule.version)).run();
  for (const assignment of plan.assignments) {
    await audit(env.TEAM_DB, plan.actor.id, 'shift.auto_assign', 'shift', assignment.shiftId, {
      employeeId: assignment.employeeId, criteria: plan.criteria
    });
    if (plan.schedule.status === 'published') {
      await notifyUser(env, assignment.employeeId, 'shift_changed', 'You were assigned a shift',
        `You were assigned the ${assignment.date} ${assignment.startTime}–${assignment.endTime} shift.`,
        '/team/schedule.html', `${assignment.shiftId}:auto:${assignment.shiftVersion + 1}`);
    }
  }
  if (plan.schedule.status === 'published') {
    await captureScheduleVersion(env, plan.schedule.id, plan.actor.id, `${plan.assignments.length} shift(s) auto-assigned`);
  }
  return { ok: true, assignedCount: plan.assignments.length, assignments: plan.assignments, unassigned: plan.unassigned };
}

export async function bulkUnassignShifts(request, payload, env) {
  const actor = await requireRole(request, payload, env, 'lead');
  const selected = (Array.isArray(payload.shifts) ? payload.shifts : []).slice(0, 100)
    .map((item) => ({ id: String(item?.id || ''), version: clampInt(item?.version, 1, Number.MAX_SAFE_INTEGER, 0) }))
    .filter((item) => item.id && item.version);
  if (!selected.length || new Set(selected.map((item) => item.id)).size !== selected.length) {
    throw new ApiError('invalid_shift_selection', 400);
  }
  const placeholders = selected.map(() => '?').join(', ');
  const { results } = await env.TEAM_DB.prepare(`SELECT * FROM shifts WHERE id IN (${placeholders})`)
    .bind(...selected.map((item) => item.id)).all();
  if (results.length !== selected.length) throw new ApiError('shift_selection_changed', 409);
  const scheduleIds = new Set(results.map((shift) => shift.schedule_id));
  if (scheduleIds.size !== 1 || results.some((shift) => shift.status !== 'active' || !shift.employee_id)) {
    throw new ApiError('shift_selection_changed', 409);
  }
  const schedule = await scheduleForAutomation(request, {
    scheduleId: results[0].schedule_id, expectedScheduleVersion: payload.expectedScheduleVersion
  }, env, actor);
  const versions = new Map(selected.map((item) => [item.id, item.version]));
  if (results.some((shift) => Number(shift.version) !== versions.get(shift.id))) throw new ApiError('version_conflict', 409);

  const values = selected.map(() => '(?, ?)').join(', ');
  const bindings = selected.flatMap((item) => [item.id, item.version]);
  const now = nowIso();
  const update = await env.TEAM_DB.prepare(`WITH selected(id, version) AS (VALUES ${values})
    UPDATE shifts SET employee_id = NULL, version = version + 1, override_reason = NULL, updated_by = ?, updated_at = ?
    WHERE id IN (SELECT id FROM selected) AND schedule_id = ? AND status = 'active' AND employee_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM schedules WHERE id = ? AND version = ?)
      AND (SELECT COUNT(*) FROM shifts sh JOIN selected s ON s.id = sh.id AND s.version = sh.version
        WHERE sh.schedule_id = ? AND sh.status = 'active' AND sh.employee_id IS NOT NULL) = ?`)
    .bind(...bindings, actor.id, now, schedule.id, schedule.id, Number(schedule.version), schedule.id, selected.length).run();
  if (Number(update.meta.changes) !== selected.length) throw new ApiError('version_conflict', 409);
  await env.TEAM_DB.batch([
    env.TEAM_DB.prepare(`DELETE FROM shift_confirmations WHERE shift_id IN (${placeholders})`).bind(...selected.map((item) => item.id)),
    env.TEAM_DB.prepare('UPDATE schedules SET version = version + 1, updated_at = ? WHERE id = ? AND version = ?')
      .bind(now, schedule.id, Number(schedule.version))
  ]);
  for (const shift of results) {
    await audit(env.TEAM_DB, actor.id, 'shift.bulk_unassign', 'shift', shift.id, { previousEmployeeId: shift.employee_id });
    if (schedule.status === 'published') {
      await notifyUser(env, shift.employee_id, 'shift_changed', 'A shift was unassigned',
        `You were unassigned from the ${shift.shift_date} ${shift.start_time}–${shift.end_time} shift.`,
        '/team/schedule.html', `${shift.id}:unassign:${Number(shift.version) + 1}`);
    }
  }
  if (schedule.status === 'published') {
    await captureScheduleVersion(env, schedule.id, actor.id, `${selected.length} shift(s) bulk-unassigned`);
  }
  return { ok: true, unassignedCount: selected.length };
}
