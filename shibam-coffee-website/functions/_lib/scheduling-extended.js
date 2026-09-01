import { audit, hasRole, makePassword, requireRole } from './auth.js';
import {
  ApiError, addDays, clampInt, minutesBetween, newId, normalizeDate, normalizeTime,
  nowIso, publicUser, safeJsonParse, sha256Hex, weekStartFor
} from './http.js';
import { captureScheduleVersion } from './schedule-snapshots.js';
import { notifyUser, scheduleWarnings } from './scheduling.js';

const LOCATION_ID = 'atlanta';
const encoder = new TextEncoder();

function randomToken(bytes = 32) {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = '';
  data.forEach((value) => { binary += String.fromCharCode(value); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function normalizePhone(value) {
  const phone = String(value || '').replace(/[\s().-]/g, '');
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw new ApiError('invalid_phone', 400);
  return phone;
}

function timeOverlaps(start, end, slotStart, slotEnd) {
  return start < slotEnd && end > slotStart;
}

function shiftOverlapsDateSlot(shift, date, slotStart, slotEnd) {
  if (shift.shift_date === date) {
    return shift.end_time < shift.start_time
      ? shift.start_time < slotEnd
      : timeOverlaps(shift.start_time, shift.end_time, slotStart, slotEnd);
  }
  return shift.end_time < shift.start_time && addDays(shift.shift_date, 1) === date && shift.end_time > slotStart;
}

async function notifyManagers(env, type, title, message, key) {
  const { results } = await env.TEAM_DB.prepare("SELECT id FROM users WHERE active = 1 AND role = 'management'").all();
  for (const manager of results) {
    await notifyUser(env, manager.id, type, title, message, '/team/manage-schedule.html', `${key}:${manager.id}`);
  }
}

export async function cancelTimeOffRequest(request, payload, env) {
  const actor = await requireRole(request, payload, env);
  const item = await env.TEAM_DB.prepare(`SELECT * FROM time_off_requests
    WHERE id = ? AND employee_id = ? AND status = 'pending'`).bind(payload.requestId, actor.id).first();
  if (!item) throw new ApiError('request_not_pending', 409);
  const now = nowIso();
  const result = await env.TEAM_DB.prepare(`UPDATE time_off_requests SET status = 'cancelled', reviewed_at = ?,
    review_note = 'Cancelled by employee.' WHERE id = ? AND employee_id = ? AND status = 'pending'`)
    .bind(now, item.id, actor.id).run();
  if (!result.meta.changes) throw new ApiError('request_not_pending', 409);
  await audit(env.TEAM_DB, actor.id, 'timeoff.cancel', 'time_off_request', item.id, {});
  await notifyManagers(env, 'time_off_cancelled', 'Time-off request cancelled',
    `${actor.name} cancelled the ${item.start_date}–${item.end_date} request.`, `${item.id}:cancelled`);
  return { ok: true };
}

export async function cancelOpenShiftRequest(request, payload, env) {
  const actor = await requireRole(request, payload, env);
  const item = await env.TEAM_DB.prepare(`SELECT sr.*, sh.shift_date FROM shift_requests sr
    JOIN shifts sh ON sh.id = sr.shift_id WHERE sr.id = ? AND sr.employee_id = ? AND sr.status = 'pending'`)
    .bind(payload.requestId, actor.id).first();
  if (!item) throw new ApiError('request_not_pending', 409);
  const result = await env.TEAM_DB.prepare(`UPDATE shift_requests SET status = 'cancelled', reviewed_at = ?,
    review_note = 'Cancelled by employee.' WHERE id = ? AND employee_id = ? AND status = 'pending'`)
    .bind(nowIso(), item.id, actor.id).run();
  if (!result.meta.changes) throw new ApiError('request_not_pending', 409);
  await audit(env.TEAM_DB, actor.id, 'shift_request.cancel', 'shift_request', item.id, {});
  await notifyManagers(env, 'shift_request_cancelled', 'Open-shift request cancelled',
    `${actor.name} cancelled a request for ${item.shift_date}.`, `${item.id}:cancelled`);
  return { ok: true };
}

function exchangeDto(row) {
  return {
    id: row.id,
    type: row.request_type,
    offeredShiftId: row.offered_shift_id,
    offeredDate: row.offered_date || '',
    offeredStartTime: row.offered_start_time || '',
    offeredEndTime: row.offered_end_time || '',
    offeredPositionName: row.offered_position_name || '',
    requesterId: row.requester_id,
    requesterName: row.requester_name || '',
    requestedShiftId: row.requested_shift_id || '',
    requestedDate: row.requested_date || '',
    requestedStartTime: row.requested_start_time || '',
    requestedEndTime: row.requested_end_time || '',
    targetEmployeeId: row.target_employee_id || '',
    targetEmployeeName: row.target_employee_name || '',
    selectedCandidateId: row.selected_candidate_id || '',
    note: row.note || '',
    status: row.status,
    submittedAt: row.submitted_at,
    reviewNote: row.review_note || ''
  };
}

const EXCHANGE_SELECT = `SELECT ex.*, requester.name AS requester_name, target.name AS target_employee_name,
    offered.shift_date AS offered_date, offered.start_time AS offered_start_time, offered.end_time AS offered_end_time,
    offered.position_id AS offered_position_id, op.name AS offered_position_name,
    requested.shift_date AS requested_date, requested.start_time AS requested_start_time, requested.end_time AS requested_end_time
  FROM shift_exchange_requests ex
  JOIN users requester ON requester.id = ex.requester_id
  LEFT JOIN users target ON target.id = ex.target_employee_id
  JOIN shifts offered ON offered.id = ex.offered_shift_id
  LEFT JOIN positions op ON op.id = offered.position_id
  LEFT JOIN shifts requested ON requested.id = ex.requested_shift_id`;

export async function getExchangeData(request, payload, env) {
  const actor = await requireRole(request, payload, env);
  const { results: exchanges } = await env.TEAM_DB.prepare(`${EXCHANGE_SELECT}
    WHERE ex.status IN ('open', 'employee_accepted') OR ex.requester_id = ? OR ex.target_employee_id = ?
    ORDER BY ex.submitted_at DESC LIMIT 100`).bind(actor.id, actor.id).all();
  const { results: candidates } = await env.TEAM_DB.prepare(`SELECT c.*, u.name AS employee_name
    FROM shift_exchange_candidates c JOIN users u ON u.id = c.employee_id
    JOIN shift_exchange_requests ex ON ex.id = c.request_id
    WHERE ex.requester_id = ? OR ex.target_employee_id = ? OR ? IN
      (SELECT id FROM users WHERE role = 'management' AND id = ?)
    ORDER BY c.created_at`).bind(actor.id, actor.id, actor.id, actor.id).all();
  const candidateMap = new Map();
  candidates.forEach((item) => {
    if (!candidateMap.has(item.request_id)) candidateMap.set(item.request_id, []);
    candidateMap.get(item.request_id).push({ employeeId: item.employee_id, employeeName: item.employee_name, status: item.status, note: item.note });
  });
  return { ok: true, exchanges: exchanges.map((row) => ({ ...exchangeDto(row), candidates: candidateMap.get(row.id) || [] })) };
}

export async function createExchangeRequest(request, payload, env) {
  const actor = await requireRole(request, payload, env);
  const type = String(payload.type || 'drop');
  if (!['drop', 'swap'].includes(type)) throw new ApiError('invalid_exchange_type', 400);
  const offered = await env.TEAM_DB.prepare(`SELECT sh.*, s.status AS schedule_status FROM shifts sh
    JOIN schedules s ON s.id = sh.schedule_id WHERE sh.id = ? AND sh.employee_id = ? AND sh.status = 'active'`)
    .bind(payload.offeredShiftId, actor.id).first();
  if (!offered || offered.schedule_status !== 'published' || offered.shift_date < nowIso().slice(0, 10)) {
    throw new ApiError('shift_not_exchangeable', 409);
  }
  let requested = null;
  if (type === 'swap') {
    requested = await env.TEAM_DB.prepare(`SELECT sh.*, s.status AS schedule_status FROM shifts sh
      JOIN schedules s ON s.id = sh.schedule_id WHERE sh.id = ? AND sh.employee_id IS NOT NULL AND sh.employee_id != ?
      AND sh.status = 'active'`).bind(payload.requestedShiftId, actor.id).first();
    if (!requested || requested.schedule_status !== 'published' || requested.shift_date < nowIso().slice(0, 10)) {
      throw new ApiError('requested_shift_not_exchangeable', 409);
    }
  }
  const id = newId('exchange');
  try {
    await env.TEAM_DB.prepare(`INSERT INTO shift_exchange_requests
      (id, request_type, offered_shift_id, offered_shift_version, requester_id, requested_shift_id,
       requested_shift_version, target_employee_id, note, status, submitted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`)
      .bind(id, type, offered.id, offered.version, actor.id, requested?.id || null, requested?.version || null,
        requested?.employee_id || null, String(payload.note || '').trim().slice(0, 350), nowIso()).run();
  } catch (error) {
    if (String(error).includes('UNIQUE')) throw new ApiError('exchange_already_open', 409);
    throw error;
  }
  await audit(env.TEAM_DB, actor.id, `shift_exchange.${type}.create`, 'shift_exchange', id, { offeredShiftId: offered.id });
  if (requested) {
    await notifyUser(env, requested.employee_id, 'shift_exchange_requested', 'Shift swap requested',
      `${actor.name} asked to swap shifts with you.`, '/team/schedule.html', `${id}:target`);
  } else {
    const eligibility = offered.position_id
      ? await env.TEAM_DB.prepare(`SELECT u.id FROM users u JOIN employee_positions ep ON ep.user_id = u.id
          WHERE u.active = 1 AND u.id != ? AND ep.position_id = ?`).bind(actor.id, offered.position_id).all()
      : await env.TEAM_DB.prepare('SELECT id FROM users WHERE active = 1 AND id != ?').bind(actor.id).all();
    for (const employee of eligibility.results) {
      await notifyUser(env, employee.id, 'shift_exchange_open', 'Shift available for pickup',
        `${actor.name} would like coverage on ${offered.shift_date}.`, '/team/schedule.html', `${id}:open:${employee.id}`);
    }
  }
  return { ok: true, id };
}

export async function volunteerForExchange(request, payload, env) {
  const actor = await requireRole(request, payload, env);
  const exchange = await env.TEAM_DB.prepare(`${EXCHANGE_SELECT} WHERE ex.id = ? AND ex.request_type = 'drop' AND ex.status = 'open'`)
    .bind(payload.exchangeId).first();
  if (!exchange || exchange.requester_id === actor.id) throw new ApiError('exchange_not_open', 409);
  const offered = await env.TEAM_DB.prepare('SELECT * FROM shifts WHERE id = ?').bind(exchange.offered_shift_id).first();
  const warnings = await scheduleWarnings(env.TEAM_DB, {
    employeeId: actor.id, positionId: offered.position_id, date: offered.shift_date,
    startTime: offered.start_time, endTime: offered.end_time, breakMinutes: offered.break_minutes
  }, offered.id, { id: offered.schedule_id });
  if (warnings.length) throw new ApiError('not_eligible', 409, { warnings });
  const now = nowIso();
  await env.TEAM_DB.prepare(`INSERT INTO shift_exchange_candidates
    (request_id, employee_id, note, status, created_at, updated_at) VALUES (?, ?, ?, 'volunteered', ?, ?)
    ON CONFLICT(request_id, employee_id) DO UPDATE SET note = excluded.note, status = 'volunteered', updated_at = excluded.updated_at`)
    .bind(exchange.id, actor.id, String(payload.note || '').trim().slice(0, 350), now, now).run();
  await audit(env.TEAM_DB, actor.id, 'shift_exchange.volunteer', 'shift_exchange', exchange.id, {});
  await notifyUser(env, exchange.requester_id, 'shift_exchange_candidate', 'Someone can cover your shift',
    `${actor.name} volunteered for your ${exchange.offered_date} shift.`, '/team/schedule.html', `${exchange.id}:candidate:${actor.id}`);
  await notifyManagers(env, 'shift_exchange_candidate', 'Shift coverage awaiting review',
    `${actor.name} volunteered for ${exchange.requester_name}’s ${exchange.offered_date} shift.`, `${exchange.id}:candidate-manager:${actor.id}`);
  return { ok: true };
}

export async function respondSwapRequest(request, payload, env) {
  const actor = await requireRole(request, payload, env);
  const accept = payload.accept === true;
  const exchange = await env.TEAM_DB.prepare(`SELECT * FROM shift_exchange_requests
    WHERE id = ? AND request_type = 'swap' AND target_employee_id = ? AND status = 'open'`)
    .bind(payload.exchangeId, actor.id).first();
  if (!exchange) throw new ApiError('exchange_not_open', 409);
  const status = accept ? 'employee_accepted' : 'declined';
  await env.TEAM_DB.prepare(`UPDATE shift_exchange_requests SET status = ?, responded_at = ?, review_note = ?
    WHERE id = ? AND status = 'open'`).bind(status, nowIso(), accept ? '' : 'Declined by coworker.', exchange.id).run();
  await audit(env.TEAM_DB, actor.id, accept ? 'shift_exchange.accept' : 'shift_exchange.decline', 'shift_exchange', exchange.id, {});
  await notifyUser(env, exchange.requester_id, 'shift_exchange_response', `Shift swap ${accept ? 'accepted' : 'declined'}`,
    `${actor.name} ${accept ? 'accepted' : 'declined'} your swap request.`, '/team/schedule.html', `${exchange.id}:${status}`);
  if (accept) await notifyManagers(env, 'shift_exchange_review', 'Shift swap awaiting approval',
    `${actor.name} accepted a shift swap.`, `${exchange.id}:manager-review`);
  return { ok: true };
}

export async function cancelExchangeRequest(request, payload, env) {
  const actor = await requireRole(request, payload, env);
  const exchange = await env.TEAM_DB.prepare(`SELECT * FROM shift_exchange_requests
    WHERE id = ? AND requester_id = ? AND status IN ('open', 'employee_accepted')`).bind(payload.exchangeId, actor.id).first();
  if (!exchange) throw new ApiError('exchange_not_open', 409);
  await env.TEAM_DB.prepare(`UPDATE shift_exchange_requests SET status = 'cancelled', reviewed_at = ?,
    review_note = 'Cancelled by employee.' WHERE id = ? AND status IN ('open', 'employee_accepted')`)
    .bind(nowIso(), exchange.id).run();
  await audit(env.TEAM_DB, actor.id, 'shift_exchange.cancel', 'shift_exchange', exchange.id, {});
  if (exchange.target_employee_id) await notifyUser(env, exchange.target_employee_id, 'shift_exchange_cancelled', 'Shift swap cancelled',
    `${actor.name} cancelled the shift swap request.`, '/team/schedule.html', `${exchange.id}:cancelled-target`);
  return { ok: true };
}

export async function reviewExchangeRequest(request, payload, env) {
  const actor = await requireRole(request, payload, env, 'management');
  const approve = payload.status === 'approved';
  if (!approve && payload.status !== 'declined') throw new ApiError('invalid_status', 400);
  const exchange = await env.TEAM_DB.prepare(`SELECT * FROM shift_exchange_requests
    WHERE id = ? AND status IN ('open', 'employee_accepted')`).bind(payload.exchangeId).first();
  if (!exchange) throw new ApiError('exchange_not_open', 409);
  const offered = await env.TEAM_DB.prepare('SELECT * FROM shifts WHERE id = ?').bind(exchange.offered_shift_id).first();
  if (!offered || offered.employee_id !== exchange.requester_id || Number(offered.version) !== Number(exchange.offered_shift_version)) {
    throw new ApiError('exchange_shift_changed', 409);
  }
  let recipientId = exchange.target_employee_id;
  let requested = null;
  if (exchange.request_type === 'drop') {
    recipientId = String(payload.candidateEmployeeId || exchange.selected_candidate_id || '');
    const candidate = await env.TEAM_DB.prepare(`SELECT * FROM shift_exchange_candidates
      WHERE request_id = ? AND employee_id = ? AND status = 'volunteered'`).bind(exchange.id, recipientId).first();
    if (approve && !candidate) throw new ApiError('candidate_required', 400);
  } else {
    if (approve && exchange.status !== 'employee_accepted') throw new ApiError('coworker_acceptance_required', 409);
    requested = await env.TEAM_DB.prepare('SELECT * FROM shifts WHERE id = ?').bind(exchange.requested_shift_id).first();
    if (approve && (!requested || requested.employee_id !== exchange.target_employee_id ||
        Number(requested.version) !== Number(exchange.requested_shift_version))) throw new ApiError('exchange_shift_changed', 409);
  }
  const now = nowIso();
  if (approve) {
    const offeredWarnings = await scheduleWarnings(env.TEAM_DB, {
      employeeId: recipientId, positionId: offered.position_id, date: offered.shift_date,
      startTime: offered.start_time, endTime: offered.end_time, breakMinutes: offered.break_minutes
    }, offered.id, { id: offered.schedule_id });
    const requestedWarnings = requested ? await scheduleWarnings(env.TEAM_DB, {
      employeeId: exchange.requester_id, positionId: requested.position_id, date: requested.shift_date,
      startTime: requested.start_time, endTime: requested.end_time, breakMinutes: requested.break_minutes
    }, requested.id, { id: requested.schedule_id }) : [];
    if (offeredWarnings.length || requestedWarnings.length) {
      throw new ApiError('request_no_longer_eligible', 409, { warnings: [...offeredWarnings, ...requestedWarnings] });
    }
    const statements = [
      env.TEAM_DB.prepare(`UPDATE shifts SET employee_id = ?, version = version + 1, updated_by = ?, updated_at = ?
        WHERE id = ? AND employee_id = ? AND version = ?`).bind(recipientId, actor.id, now, offered.id, exchange.requester_id, exchange.offered_shift_version),
      env.TEAM_DB.prepare(`UPDATE shift_exchange_requests SET status = 'approved', selected_candidate_id = ?, reviewed_by = ?,
        reviewed_at = ?, review_note = ? WHERE id = ? AND status IN ('open', 'employee_accepted')`)
        .bind(exchange.request_type === 'drop' ? recipientId : null, actor.id, now, String(payload.note || '').trim().slice(0, 500), exchange.id),
      env.TEAM_DB.prepare('UPDATE schedules SET version = version + 1, updated_at = ? WHERE id = ?')
        .bind(now, offered.schedule_id)
    ];
    if (requested) {
      statements.splice(1, 0, env.TEAM_DB.prepare(`UPDATE shifts SET employee_id = ?, version = version + 1, updated_by = ?, updated_at = ?
        WHERE id = ? AND employee_id = ? AND version = ?`).bind(exchange.requester_id, actor.id, now, requested.id,
        exchange.target_employee_id, exchange.requested_shift_version));
      if (requested.schedule_id !== offered.schedule_id) statements.push(env.TEAM_DB.prepare(
        'UPDATE schedules SET version = version + 1, updated_at = ? WHERE id = ?').bind(now, requested.schedule_id));
    }
    const results = await env.TEAM_DB.batch(statements);
    if (results.some((result) => result.meta?.changes === 0)) throw new ApiError('exchange_shift_changed', 409);
    await captureScheduleVersion(env, offered.schedule_id, actor.id, exchange.request_type === 'swap' ? 'Shift swap approved' : 'Shift drop approved');
    if (requested && requested.schedule_id !== offered.schedule_id) {
      await captureScheduleVersion(env, requested.schedule_id, actor.id, 'Shift swap approved');
    }
  } else {
    await env.TEAM_DB.prepare(`UPDATE shift_exchange_requests SET status = 'declined', reviewed_by = ?, reviewed_at = ?,
      review_note = ? WHERE id = ? AND status IN ('open', 'employee_accepted')`)
      .bind(actor.id, now, String(payload.note || '').trim().slice(0, 500), exchange.id).run();
  }
  const status = approve ? 'approved' : 'declined';
  await audit(env.TEAM_DB, actor.id, `shift_exchange.${status}`, 'shift_exchange', exchange.id, { recipientId });
  const recipients = new Set([exchange.requester_id, recipientId, exchange.target_employee_id].filter(Boolean));
  for (const userId of recipients) await notifyUser(env, userId, 'shift_exchange_reviewed', `Shift exchange ${status}`,
    `The shift exchange was ${status}.`, '/team/schedule.html', `${exchange.id}:${status}:${userId}`);
  return { ok: true };
}

function templateDto(row, shifts = []) {
  return { id: row.id, name: row.name, description: row.description || '', active: Number(row.active) === 1,
    updatedAt: row.updated_at, shifts };
}

async function templateShifts(env, templateId) {
  const { results } = await env.TEAM_DB.prepare(`SELECT ts.*, u.name AS employee_name, p.name AS position_name
    FROM schedule_template_shifts ts LEFT JOIN users u ON u.id = ts.employee_id
    LEFT JOIN positions p ON p.id = ts.position_id WHERE ts.template_id = ?
    ORDER BY ts.day_offset, ts.start_time`).bind(templateId).all();
  return results.map((row) => ({ id: row.id, dayOffset: Number(row.day_offset), employeeId: row.employee_id || '',
    employeeName: row.employee_name || '', positionId: row.position_id || '', positionName: row.position_name || '',
    startTime: row.start_time, endTime: row.end_time, breakMinutes: Number(row.break_minutes), notes: row.notes || '' }));
}

export async function listScheduleTemplates(request, payload, env) {
  await requireRole(request, payload, env, 'lead');
  const { results } = await env.TEAM_DB.prepare(`SELECT * FROM schedule_templates
    WHERE location_id = ? AND active = 1 ORDER BY name`).bind(LOCATION_ID).all();
  const templates = [];
  for (const row of results) templates.push(templateDto(row, await templateShifts(env, row.id)));
  const { results: rotations } = await env.TEAM_DB.prepare(`SELECT r.*, GROUP_CONCAT(rw.template_id, '|') AS template_ids
    FROM schedule_rotations r LEFT JOIN schedule_rotation_weeks rw ON rw.rotation_id = r.id
    WHERE r.location_id = ? AND r.active = 1 GROUP BY r.id ORDER BY r.name`).bind(LOCATION_ID).all();
  return { ok: true, templates, rotations: rotations.map((row) => ({ id: row.id, name: row.name,
    startsOn: row.starts_on, endsOn: row.ends_on || '', templateIds: row.template_ids ? row.template_ids.split('|') : [] })) };
}

export async function createTemplateFromSchedule(request, payload, env) {
  const actor = await requireRole(request, payload, env, 'lead');
  const schedule = await env.TEAM_DB.prepare('SELECT * FROM schedules WHERE id = ?').bind(payload.scheduleId).first();
  if (!schedule) throw new ApiError('schedule_not_found', 404);
  const name = String(payload.name || '').trim().slice(0, 80);
  if (!name) throw new ApiError('template_name_required', 400);
  const id = newId('template');
  const now = nowIso();
  const { results: shifts } = await env.TEAM_DB.prepare("SELECT * FROM shifts WHERE schedule_id = ? AND status = 'active'")
    .bind(schedule.id).all();
  const statements = [env.TEAM_DB.prepare(`INSERT INTO schedule_templates
    (id, location_id, name, description, active, created_by, created_at, updated_by, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`).bind(id, schedule.location_id, name,
      String(payload.description || '').trim().slice(0, 350), actor.id, now, actor.id, now)];
  shifts.forEach((shift) => {
    const offset = Math.round((new Date(`${shift.shift_date}T12:00:00Z`) - new Date(`${schedule.week_start}T12:00:00Z`)) / 86400000);
    statements.push(env.TEAM_DB.prepare(`INSERT INTO schedule_template_shifts
      (id, template_id, day_offset, employee_id, position_id, start_time, end_time, break_minutes, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(newId('template_shift'), id, offset, shift.employee_id, shift.position_id,
        shift.start_time, shift.end_time, shift.break_minutes, shift.notes));
  });
  try { await env.TEAM_DB.batch(statements); } catch (error) {
    if (String(error).includes('UNIQUE')) throw new ApiError('template_name_taken', 409);
    throw error;
  }
  await audit(env.TEAM_DB, actor.id, 'schedule_template.create', 'schedule_template', id, { scheduleId: schedule.id, shifts: shifts.length });
  return { ok: true, id };
}

export async function deleteScheduleTemplate(request, payload, env) {
  const actor = await requireRole(request, payload, env, 'management');
  const result = await env.TEAM_DB.prepare('UPDATE schedule_templates SET active = 0, updated_by = ?, updated_at = ? WHERE id = ? AND active = 1')
    .bind(actor.id, nowIso(), payload.templateId).run();
  if (!result.meta.changes) throw new ApiError('not_found', 404);
  await audit(env.TEAM_DB, actor.id, 'schedule_template.archive', 'schedule_template', payload.templateId, {});
  return { ok: true };
}

export async function applyScheduleTemplate(request, payload, env) {
  const actor = await requireRole(request, payload, env, 'lead');
  const schedule = await env.TEAM_DB.prepare('SELECT * FROM schedules WHERE id = ?').bind(payload.scheduleId).first();
  if (!schedule || schedule.status !== 'draft') throw new ApiError('draft_schedule_required', 409);
  const template = await env.TEAM_DB.prepare('SELECT * FROM schedule_templates WHERE id = ? AND active = 1')
    .bind(payload.templateId).first();
  if (!template) throw new ApiError('template_not_found', 404);
  const existing = await env.TEAM_DB.prepare("SELECT COUNT(*) AS total FROM shifts WHERE schedule_id = ? AND status = 'active'")
    .bind(schedule.id).first();
  if (Number(existing.total) && payload.replace !== true) throw new ApiError('target_not_empty', 409);
  const shifts = await templateShifts(env, template.id);
  const warnings = [];
  for (const shift of shifts) {
    if (!shift.employeeId) continue;
    const date = addDays(schedule.week_start, shift.dayOffset);
    const found = await scheduleWarnings(env.TEAM_DB, { ...shift, date }, '', schedule);
    found.forEach((warning) => warnings.push({ ...warning, date, employeeName: shift.employeeName }));
  }
  const overrideReason = String(payload.overrideReason || '').trim();
  if (warnings.length && (!hasRole(actor, 'management') || !overrideReason)) {
    throw new ApiError('template_conflicts', 409, { warnings, canOverride: hasRole(actor, 'management') });
  }
  const now = nowIso();
  const statements = [];
  if (Number(existing.total)) statements.push(env.TEAM_DB.prepare(`UPDATE shifts SET status = 'cancelled', version = version + 1,
    updated_by = ?, updated_at = ? WHERE schedule_id = ? AND status = 'active'`).bind(actor.id, now, schedule.id));
  shifts.forEach((shift) => statements.push(env.TEAM_DB.prepare(`INSERT INTO shifts
    (id, schedule_id, employee_id, position_id, shift_date, start_time, end_time, break_minutes, notes,
     status, version, override_reason, created_by, created_at, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?, ?, ?)`)
    .bind(newId('shift'), schedule.id, shift.employeeId || null, shift.positionId || null, addDays(schedule.week_start, shift.dayOffset),
      shift.startTime, shift.endTime, shift.breakMinutes, shift.notes, overrideReason || null, actor.id, now, actor.id, now)));
  statements.push(env.TEAM_DB.prepare('UPDATE schedules SET version = version + 1, updated_at = ? WHERE id = ?').bind(now, schedule.id));
  await env.TEAM_DB.batch(statements);
  await audit(env.TEAM_DB, actor.id, 'schedule_template.apply', 'schedule', schedule.id, { templateId: template.id, warnings });
  return { ok: true, appliedShifts: shifts.length, warnings };
}

export async function saveScheduleRotation(request, payload, env) {
  const actor = await requireRole(request, payload, env, 'lead');
  const name = String(payload.name || '').trim().slice(0, 80);
  const templateIds = Array.isArray(payload.templateIds) ? payload.templateIds.slice(0, 8).filter(Boolean) : [];
  if (!name || !templateIds.length) throw new ApiError('invalid_rotation', 400);
  const startsOn = weekStartFor(payload.startsOn || nowIso().slice(0, 10));
  const endsOn = payload.endsOn ? weekStartFor(payload.endsOn) : null;
  if (endsOn && endsOn < startsOn) throw new ApiError('invalid_date_range', 400);
  const id = payload.id || newId('rotation');
  const now = nowIso();
  const statements = [];
  if (payload.id) {
    statements.push(env.TEAM_DB.prepare(`UPDATE schedule_rotations SET name = ?, starts_on = ?, ends_on = ?, updated_at = ?
      WHERE id = ? AND location_id = ?`).bind(name, startsOn, endsOn, now, id, LOCATION_ID));
    statements.push(env.TEAM_DB.prepare('DELETE FROM schedule_rotation_weeks WHERE rotation_id = ?').bind(id));
  } else {
    statements.push(env.TEAM_DB.prepare(`INSERT INTO schedule_rotations
      (id, location_id, name, starts_on, ends_on, active, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`).bind(id, LOCATION_ID, name, startsOn, endsOn, actor.id, now, now));
  }
  templateIds.forEach((templateId, index) => statements.push(env.TEAM_DB.prepare(`INSERT INTO schedule_rotation_weeks
    (rotation_id, week_index, template_id) VALUES (?, ?, ?)`).bind(id, index, templateId)));
  await env.TEAM_DB.batch(statements);
  await audit(env.TEAM_DB, actor.id, payload.id ? 'schedule_rotation.update' : 'schedule_rotation.create', 'schedule_rotation', id, { weeks: templateIds.length });
  return { ok: true, id };
}

export async function generateScheduleRotation(request, payload, env) {
  const actor = await requireRole(request, payload, env, 'lead');
  const rotation = await env.TEAM_DB.prepare('SELECT * FROM schedule_rotations WHERE id = ? AND active = 1')
    .bind(payload.rotationId).first();
  if (!rotation) throw new ApiError('rotation_not_found', 404);
  const { results: weeks } = await env.TEAM_DB.prepare(`SELECT * FROM schedule_rotation_weeks
    WHERE rotation_id = ? ORDER BY week_index`).bind(rotation.id).all();
  const count = clampInt(payload.weeks, 1, 26, 4);
  const firstWeek = weekStartFor(payload.firstWeek || rotation.starts_on);
  const created = [];
  for (let index = 0; index < count; index += 1) {
    const weekStart = addDays(firstWeek, index * 7);
    if (rotation.ends_on && weekStart > rotation.ends_on) break;
    let schedule = await env.TEAM_DB.prepare('SELECT * FROM schedules WHERE location_id = ? AND week_start = ?')
      .bind(LOCATION_ID, weekStart).first();
    if (!schedule) {
      const scheduleId = newId('schedule');
      const now = nowIso();
      await env.TEAM_DB.prepare(`INSERT INTO schedules
        (id, location_id, week_start, status, version, created_by, created_at, updated_at)
        VALUES (?, ?, ?, 'draft', 1, ?, ?, ?)`).bind(scheduleId, LOCATION_ID, weekStart, actor.id, now, now).run();
      schedule = await env.TEAM_DB.prepare('SELECT * FROM schedules WHERE id = ?').bind(scheduleId).first();
    }
    const active = await env.TEAM_DB.prepare("SELECT COUNT(*) AS total FROM shifts WHERE schedule_id = ? AND status = 'active'")
      .bind(schedule.id).first();
    if (schedule.status !== 'draft' || Number(active.total)) {
      created.push({ weekStart, status: 'skipped', reason: schedule.status !== 'draft' ? 'published' : 'not_empty' });
      continue;
    }
    const rotationIndex = Math.floor((new Date(`${weekStart}T12:00:00Z`) - new Date(`${rotation.starts_on}T12:00:00Z`)) / 604800000);
    const definition = weeks[((rotationIndex % weeks.length) + weeks.length) % weeks.length];
    const shifts = await templateShifts(env, definition.template_id);
    const now = nowIso();
    const statements = shifts.map((shift) => env.TEAM_DB.prepare(`INSERT INTO shifts
      (id, schedule_id, employee_id, position_id, shift_date, start_time, end_time, break_minutes, notes,
       status, version, created_by, created_at, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?, ?)`)
      .bind(newId('shift'), schedule.id, shift.employeeId || null, shift.positionId || null, addDays(weekStart, shift.dayOffset),
        shift.startTime, shift.endTime, shift.breakMinutes, shift.notes, actor.id, now, actor.id, now));
    statements.push(env.TEAM_DB.prepare('UPDATE schedules SET version = version + 1, updated_at = ? WHERE id = ?').bind(now, schedule.id));
    await env.TEAM_DB.batch(statements);
    created.push({ weekStart, status: 'created', shifts: shifts.length });
  }
  await audit(env.TEAM_DB, actor.id, 'schedule_rotation.generate', 'schedule_rotation', rotation.id, { firstWeek, count, created });
  return { ok: true, weeks: created };
}

function availabilitySetDto(row, rules) {
  return { id: row.id, label: row.label, effectiveFrom: row.effective_from || '', effectiveTo: row.effective_to || '', rules };
}

export async function getAvailabilitySets(request, payload, env) {
  const actor = await requireRole(request, payload, env);
  const { results: sets } = await env.TEAM_DB.prepare(`SELECT * FROM availability_rule_sets
    WHERE employee_id = ? ORDER BY COALESCE(effective_from, '0000-00-00'), created_at`).bind(actor.id).all();
  const output = [];
  for (const set of sets) {
    const { results: rules } = await env.TEAM_DB.prepare(`SELECT * FROM availability_rules WHERE rule_set_id = ?
      ORDER BY weekday, start_time`).bind(set.id).all();
    output.push(availabilitySetDto(set, rules.map((row) => ({ id: row.id, weekday: Number(row.weekday), preference: row.preference,
      startTime: row.start_time, endTime: row.end_time }))));
  }
  const { results: series } = await env.TEAM_DB.prepare(`SELECT * FROM availability_exception_series
    WHERE employee_id = ? ORDER BY starts_on DESC LIMIT 100`).bind(actor.id).all();
  return { ok: true, sets: output, series: series.map((row) => ({ id: row.id, startsOn: row.starts_on, endsOn: row.ends_on,
    intervalWeeks: Number(row.interval_weeks), preference: row.preference, startTime: row.start_time, endTime: row.end_time, note: row.note })) };
}

export async function saveAvailabilitySet(request, payload, env) {
  const actor = await requireRole(request, payload, env);
  const input = payload.set || {};
  const from = input.effectiveFrom ? normalizeDate(input.effectiveFrom, 'effective_from') : null;
  const to = input.effectiveTo ? normalizeDate(input.effectiveTo, 'effective_to') : null;
  if (from && to && to < from) throw new ApiError('invalid_date_range', 400);
  const overlap = await env.TEAM_DB.prepare(`SELECT id FROM availability_rule_sets WHERE employee_id = ? AND id != ?
    AND COALESCE(effective_from, '0000-01-01') <= COALESCE(?, '9999-12-31')
    AND COALESCE(effective_to, '9999-12-31') >= COALESCE(?, '0000-01-01') LIMIT 1`)
    .bind(actor.id, input.id || '', to, from).first();
  if (overlap) throw new ApiError('availability_period_overlap', 409);
  const rules = Array.isArray(input.rules) ? input.rules.slice(0, 35).map((rule) => {
    const weekday = clampInt(rule.weekday, 0, 6, -1);
    if (weekday < 0 || !['preferred', 'unavailable'].includes(rule.preference)) throw new ApiError('invalid_availability', 400);
    const startTime = normalizeTime(rule.startTime, 'start_time');
    const endTime = normalizeTime(rule.endTime, 'end_time');
    minutesBetween(startTime, endTime, 0);
    return { weekday, preference: rule.preference, startTime, endTime };
  }) : [];
  rules.sort((a, b) => a.weekday - b.weekday || a.startTime.localeCompare(b.startTime));
  rules.forEach((rule, index) => {
    const previous = rules[index - 1];
    if (previous && previous.weekday === rule.weekday && previous.endTime > rule.startTime) throw new ApiError('overlapping_availability', 400);
  });
  const id = input.id || newId('availability_set');
  const now = nowIso();
  const statements = [];
  if (input.id) {
    const owned = await env.TEAM_DB.prepare('SELECT id FROM availability_rule_sets WHERE id = ? AND employee_id = ?')
      .bind(id, actor.id).first();
    if (!owned) throw new ApiError('not_found', 404);
    statements.push(env.TEAM_DB.prepare(`UPDATE availability_rule_sets SET label = ?, effective_from = ?, effective_to = ?, updated_at = ?
      WHERE id = ? AND employee_id = ?`).bind(String(input.label || 'Regular availability').trim().slice(0, 80), from, to, now, id, actor.id));
    statements.push(env.TEAM_DB.prepare('DELETE FROM availability_rules WHERE rule_set_id = ? AND employee_id = ?').bind(id, actor.id));
  } else {
    statements.push(env.TEAM_DB.prepare(`INSERT INTO availability_rule_sets
      (id, employee_id, label, effective_from, effective_to, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, actor.id, String(input.label || 'Regular availability').trim().slice(0, 80), from, to, now, now));
  }
  rules.forEach((rule) => statements.push(env.TEAM_DB.prepare(`INSERT INTO availability_rules
    (id, employee_id, weekday, preference, start_time, end_time, effective_from, effective_to, created_at, updated_at, rule_set_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(newId('availability'), actor.id, rule.weekday, rule.preference, rule.startTime, rule.endTime, from, to, now, now, id)));
  await env.TEAM_DB.batch(statements);
  await audit(env.TEAM_DB, actor.id, input.id ? 'availability_set.update' : 'availability_set.create', 'availability_set', id, { from, to, rules: rules.length });
  return { ok: true, id };
}

export async function deleteAvailabilitySet(request, payload, env) {
  const actor = await requireRole(request, payload, env);
  const owned = await env.TEAM_DB.prepare('SELECT id FROM availability_rule_sets WHERE id = ? AND employee_id = ?')
    .bind(payload.setId, actor.id).first();
  if (!owned) throw new ApiError('not_found', 404);
  await env.TEAM_DB.batch([
    env.TEAM_DB.prepare('DELETE FROM availability_rules WHERE rule_set_id = ? AND employee_id = ?').bind(owned.id, actor.id),
    env.TEAM_DB.prepare('DELETE FROM availability_rule_sets WHERE id = ? AND employee_id = ?').bind(owned.id, actor.id)
  ]);
  await audit(env.TEAM_DB, actor.id, 'availability_set.delete', 'availability_set', owned.id, {});
  return { ok: true };
}

export async function saveRepeatingAvailabilityException(request, payload, env) {
  const actor = await requireRole(request, payload, env);
  const input = payload.exception || {};
  const startsOn = normalizeDate(input.startsOn || input.date, 'starts_on');
  const endsOn = normalizeDate(input.endsOn, 'ends_on');
  if (endsOn < startsOn) throw new ApiError('invalid_date_range', 400);
  const intervalWeeks = clampInt(input.intervalWeeks, 1, 12, 1);
  const days = Math.round((new Date(`${endsOn}T12:00:00Z`) - new Date(`${startsOn}T12:00:00Z`)) / 86400000);
  const occurrences = Math.floor(days / (intervalWeeks * 7)) + 1;
  if (occurrences > 104) throw new ApiError('too_many_occurrences', 400);
  if (!['preferred', 'unavailable'].includes(input.preference)) throw new ApiError('invalid_availability', 400);
  const allDay = input.allDay === true;
  const startTime = allDay ? '00:00' : normalizeTime(input.startTime, 'start_time');
  const endTime = allDay ? '23:59' : normalizeTime(input.endTime, 'end_time');
  minutesBetween(startTime, endTime, 0);
  const note = String(input.note || '').trim().slice(0, 350);
  const id = newId('availability_series');
  const now = nowIso();
  const statements = [env.TEAM_DB.prepare(`INSERT INTO availability_exception_series
    (id, employee_id, frequency, interval_weeks, starts_on, ends_on, preference, start_time, end_time, note, created_at, updated_at)
    VALUES (?, ?, 'weekly', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, actor.id, intervalWeeks, startsOn, endsOn, input.preference, startTime, endTime, note, now, now)];
  for (let index = 0; index < occurrences; index += 1) {
    const date = addDays(startsOn, index * intervalWeeks * 7);
    statements.push(env.TEAM_DB.prepare(`INSERT INTO availability_exceptions
      (id, employee_id, exception_date, preference, start_time, end_time, note, created_at, updated_at, series_id, occurrence_index)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(newId('availability_exception'), actor.id, date, input.preference, startTime, endTime, note, now, now, id, index));
  }
  await env.TEAM_DB.batch(statements);
  await audit(env.TEAM_DB, actor.id, 'availability_exception_series.create', 'availability_exception_series', id, { occurrences });
  return { ok: true, id, occurrences };
}

export async function deleteAvailabilityExceptionSeries(request, payload, env) {
  const actor = await requireRole(request, payload, env);
  const series = await env.TEAM_DB.prepare('SELECT * FROM availability_exception_series WHERE id = ? AND employee_id = ?')
    .bind(payload.seriesId, actor.id).first();
  if (!series) throw new ApiError('not_found', 404);
  const fromDate = payload.fromDate ? normalizeDate(payload.fromDate) : null;
  if (fromDate) {
    await env.TEAM_DB.prepare('DELETE FROM availability_exceptions WHERE series_id = ? AND employee_id = ? AND exception_date >= ?')
      .bind(series.id, actor.id, fromDate).run();
    await env.TEAM_DB.prepare('UPDATE availability_exception_series SET ends_on = ?, updated_at = ? WHERE id = ?')
      .bind(addDays(fromDate, -1), nowIso(), series.id).run();
  } else {
    await env.TEAM_DB.batch([
      env.TEAM_DB.prepare('DELETE FROM availability_exceptions WHERE series_id = ? AND employee_id = ?').bind(series.id, actor.id),
      env.TEAM_DB.prepare('DELETE FROM availability_exception_series WHERE id = ? AND employee_id = ?').bind(series.id, actor.id)
    ]);
  }
  await audit(env.TEAM_DB, actor.id, 'availability_exception_series.delete', 'availability_exception_series', series.id, { fromDate });
  return { ok: true };
}

export async function getTeamCoverage(request, payload, env) {
  await requireRole(request, payload, env, 'lead');
  const weekStart = weekStartFor(payload.weekStart || nowIso().slice(0, 10));
  const weekEnd = addDays(weekStart, 6);
  const positionId = String(payload.positionId || '');
  const teamQuery = positionId
    ? `SELECT DISTINCT u.id, u.name FROM users u JOIN employee_positions ep ON ep.user_id = u.id
       WHERE u.active = 1 AND ep.position_id = ? ORDER BY u.name`
    : 'SELECT id, name FROM users WHERE active = 1 ORDER BY name';
  const team = positionId ? await env.TEAM_DB.prepare(teamQuery).bind(positionId).all() : await env.TEAM_DB.prepare(teamQuery).all();
  const [rules, exceptions, timeOff, schedules] = await Promise.all([
    env.TEAM_DB.prepare(`SELECT * FROM availability_rules WHERE (effective_from IS NULL OR effective_from <= ?)
      AND (effective_to IS NULL OR effective_to >= ?) ORDER BY employee_id, weekday`).bind(weekEnd, weekStart).all(),
    env.TEAM_DB.prepare(`SELECT * FROM availability_exceptions WHERE exception_date BETWEEN ? AND ?`)
      .bind(weekStart, weekEnd).all(),
    env.TEAM_DB.prepare(`SELECT * FROM time_off_requests WHERE status = 'approved' AND start_date <= ? AND end_date >= ?`)
      .bind(weekEnd, weekStart).all(),
    env.TEAM_DB.prepare(`SELECT sh.* FROM shifts sh
      WHERE sh.shift_date BETWEEN ? AND ? AND sh.status = 'active'`).bind(addDays(weekStart, -1), weekEnd).all()
  ]);
  const slots = [];
  for (let day = 0; day < 7; day += 1) {
    const date = addDays(weekStart, day);
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    for (let minute = 5 * 60; minute < 23 * 60; minute += 30) {
      const time = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
      const end = `${String(Math.floor((minute + 30) / 60)).padStart(2, '0')}:${String((minute + 30) % 60).padStart(2, '0')}`;
      const people = [];
      for (const user of team.results) {
        const off = timeOff.results.find((item) => item.employee_id === user.id && item.start_date <= date && item.end_date >= date &&
          (!item.start_time || timeOverlaps(item.start_time, item.end_time, time, end)));
        const dateRules = exceptions.results.filter((item) => item.employee_id === user.id && item.exception_date === date &&
          timeOverlaps(item.start_time, item.end_time, time, end));
        const recurring = rules.results.filter((item) => item.employee_id === user.id && Number(item.weekday) === weekday &&
          (!item.effective_from || item.effective_from <= date) && (!item.effective_to || item.effective_to >= date) &&
          timeOverlaps(item.start_time, item.end_time, time, end));
        const blocked = !!off || dateRules.some((item) => item.preference === 'unavailable') ||
          (!dateRules.length && recurring.some((item) => item.preference === 'unavailable'));
        const preferred = !blocked && (dateRules.some((item) => item.preference === 'preferred') ||
          (!dateRules.length && recurring.some((item) => item.preference === 'preferred')));
        const scheduled = schedules.results.some((shift) => shift.employee_id === user.id &&
          (!positionId || shift.position_id === positionId) && shiftOverlapsDateSlot(shift, date, time, end));
        people.push({ id: user.id, name: user.name, available: !blocked, preferred, scheduled,
          reason: off ? 'Approved time off' : blocked ? 'Unavailable' : preferred ? 'Preferred' : 'Available' });
      }
      slots.push({ date, time, available: people.filter((item) => item.available).length,
        preferred: people.filter((item) => item.preferred).length, scheduled: people.filter((item) => item.scheduled).length, people });
    }
  }
  return { ok: true, weekStart, slots };
}

export async function getScheduleHistory(request, payload, env) {
  await requireRole(request, payload, env, 'management');
  const { results } = await env.TEAM_DB.prepare(`SELECT sv.*, u.name AS created_by_name FROM schedule_versions sv
    LEFT JOIN users u ON u.id = sv.created_by WHERE sv.schedule_id = ? ORDER BY sv.version_number DESC LIMIT 100`)
    .bind(payload.scheduleId).all();
  return { ok: true, versions: results.map((row) => {
    const snapshot = safeJsonParse(row.snapshot_json, { shifts: [] });
    return { id: row.id, version: Number(row.version_number), reason: row.reason, checksum: row.checksum,
      createdBy: row.created_by_name || 'System', createdAt: row.created_at,
      activeShifts: (snapshot.shifts || []).filter((shift) => shift.status === 'active').length };
  }) };
}

export async function restoreScheduleVersion(request, payload, env) {
  const actor = await requireRole(request, payload, env, 'management');
  const schedule = await env.TEAM_DB.prepare('SELECT * FROM schedules WHERE id = ?').bind(payload.scheduleId).first();
  if (!schedule) throw new ApiError('schedule_not_found', 404);
  if (Number(payload.expectedVersion) !== Number(schedule.version)) throw new ApiError('version_conflict', 409);
  const version = await env.TEAM_DB.prepare('SELECT * FROM schedule_versions WHERE id = ? AND schedule_id = ?')
    .bind(payload.versionId, schedule.id).first();
  if (!version) throw new ApiError('version_not_found', 404);
  const target = safeJsonParse(version.snapshot_json, null);
  if (!target || !Array.isArray(target.shifts)) throw new ApiError('invalid_snapshot', 500);
  const { results: current } = await env.TEAM_DB.prepare('SELECT * FROM shifts WHERE schedule_id = ?').bind(schedule.id).all();
  const currentMap = new Map(current.map((shift) => [shift.id, shift]));
  const targetIds = new Set(target.shifts.map((shift) => shift.id));
  const now = nowIso();
  const statements = [];
  current.forEach((shift) => {
    if (!targetIds.has(shift.id) && shift.status !== 'cancelled') statements.push(env.TEAM_DB.prepare(`UPDATE shifts SET status = 'cancelled',
      version = version + 1, updated_by = ?, updated_at = ? WHERE id = ?`).bind(actor.id, now, shift.id));
  });
  target.shifts.forEach((shift) => {
    if (currentMap.has(shift.id)) {
      statements.push(env.TEAM_DB.prepare(`UPDATE shifts SET employee_id = ?, position_id = ?, shift_date = ?, start_time = ?,
        end_time = ?, break_minutes = ?, notes = ?, status = ?, version = version + 1, override_reason = ?, updated_by = ?, updated_at = ?
        WHERE id = ?`).bind(shift.employeeId || null, shift.positionId || null, shift.date, shift.startTime, shift.endTime,
          shift.breakMinutes, shift.notes || '', shift.status, shift.overrideReason || null, actor.id, now, shift.id));
    } else {
      statements.push(env.TEAM_DB.prepare(`INSERT INTO shifts
        (id, schedule_id, employee_id, position_id, shift_date, start_time, end_time, break_minutes, notes, status,
         version, override_reason, created_by, created_at, updated_by, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`)
        .bind(shift.id, schedule.id, shift.employeeId || null, shift.positionId || null, shift.date, shift.startTime, shift.endTime,
          shift.breakMinutes, shift.notes || '', shift.status, shift.overrideReason || null, actor.id, now, actor.id, now));
    }
  });
  statements.push(env.TEAM_DB.prepare(`DELETE FROM shift_confirmations WHERE shift_id IN
    (SELECT id FROM shifts WHERE schedule_id = ?)` ).bind(schedule.id));
  statements.push(env.TEAM_DB.prepare('UPDATE schedules SET version = version + 1, updated_at = ? WHERE id = ? AND version = ?')
    .bind(now, schedule.id, schedule.version));
  const results = await env.TEAM_DB.batch(statements);
  if (results[results.length - 1].meta?.changes === 0) throw new ApiError('version_conflict', 409);
  await captureScheduleVersion(env, schedule.id, actor.id, `Restored version ${version.version_number}`);
  await audit(env.TEAM_DB, actor.id, 'schedule.restore', 'schedule', schedule.id, { restoredVersion: Number(version.version_number) });
  const affected = new Set([...current.map((shift) => shift.employee_id), ...target.shifts.map((shift) => shift.employeeId)].filter(Boolean));
  for (const userId of affected) await notifyUser(env, userId, 'schedule_restored', 'Published schedule restored',
    `Management restored an earlier schedule for the week of ${schedule.week_start}.`, '/team/schedule.html', `${schedule.id}:restore:${Number(schedule.version) + 1}:${userId}`);
  return { ok: true, version: Number(schedule.version) + 1 };
}

export async function getMySettings(request, payload, env) {
  const actor = await requireRole(request, payload, env);
  const user = await env.TEAM_DB.prepare('SELECT * FROM users WHERE id = ?').bind(actor.id).first();
  const [preferences, subscriptions, tokens, positions] = await Promise.all([
    env.TEAM_DB.prepare('SELECT * FROM user_notification_preferences WHERE user_id = ? ORDER BY channel, category').bind(actor.id).all(),
    env.TEAM_DB.prepare(`SELECT id, device_label, created_at, last_success_at, last_error FROM push_subscriptions
      WHERE user_id = ? AND active = 1 ORDER BY created_at DESC`).bind(actor.id).all(),
    env.TEAM_DB.prepare(`SELECT id, label, created_at, last_used_at FROM calendar_tokens
      WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`).bind(actor.id).all(),
    env.TEAM_DB.prepare(`SELECT p.id, p.name FROM positions p JOIN employee_positions ep ON ep.position_id = p.id
      WHERE ep.user_id = ? ORDER BY p.name`).bind(actor.id).all()
  ]);
  return { ok: true, user: { ...publicUser(user), preferredName: user.preferred_name || '', phone: user.phone_e164 || '',
    phoneVerified: !!user.phone_verified_at, positions: positions.results.map((row) => ({ id: row.id, name: row.name })) },
    preferences: preferences.results.map((row) => ({ channel: row.channel,
      category: row.category, enabled: Number(row.enabled) === 1, quietStart: row.quiet_start || '', quietEnd: row.quiet_end || '' })),
    pushSubscriptions: subscriptions.results.map((row) => ({ id: row.id, label: row.device_label || 'Browser', createdAt: row.created_at,
      lastSuccessAt: row.last_success_at || '', lastError: row.last_error || '' })), calendarTokens: tokens.results.map((row) => ({
      id: row.id, label: row.label, createdAt: row.created_at, lastUsedAt: row.last_used_at || '' })),
    vapidPublicKey: env.VAPID_PUBLIC_KEY || '' };
}

export async function updateMyProfile(request, payload, env) {
  const actor = await requireRole(request, payload, env);
  const name = String(payload.name || '').trim().slice(0, 100);
  const preferredName = String(payload.preferredName || '').trim().slice(0, 100);
  const email = String(payload.email || '').trim().toLowerCase() || null;
  if (!name || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new ApiError('invalid_profile', 400);
  try {
    await env.TEAM_DB.prepare('UPDATE users SET name = ?, preferred_name = ?, email = ?, updated_at = ? WHERE id = ?')
      .bind(name, preferredName, email, nowIso(), actor.id).run();
  } catch (error) {
    if (String(error).includes('UNIQUE')) throw new ApiError('email_taken', 409);
    throw error;
  }
  await audit(env.TEAM_DB, actor.id, 'profile.update', 'user', actor.id, {});
  return { ok: true };
}

export async function changeMyPassword(request, payload, env) {
  const actor = await requireRole(request, payload, env);
  const password = await makePassword(payload.password);
  const now = nowIso();
  await env.TEAM_DB.batch([
    env.TEAM_DB.prepare(`UPDATE users SET password_hash = ?, password_salt = ?, password_algorithm = ?, updated_at = ? WHERE id = ?`)
      .bind(password.hash, password.salt, password.algorithm, now, actor.id),
    env.TEAM_DB.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').bind(now, actor.id)
  ]);
  await audit(env.TEAM_DB, actor.id, 'auth.password_change', 'user', actor.id, {});
  return { ok: true, signInAgain: true };
}

export async function saveNotificationPreferences(request, payload, env) {
  const actor = await requireRole(request, payload, env);
  const input = Array.isArray(payload.preferences) ? payload.preferences.slice(0, 64) : [];
  const now = nowIso();
  const statements = [];
  input.forEach((item) => {
    if (!['in_app', 'email', 'push', 'sms'].includes(item.channel) ||
        !['schedule', 'requests', 'open_shifts', 'account'].includes(item.category)) throw new ApiError('invalid_preference', 400);
    const quietStart = item.quietStart ? normalizeTime(item.quietStart, 'quiet_start') : null;
    const quietEnd = item.quietEnd ? normalizeTime(item.quietEnd, 'quiet_end') : null;
    const enabled = item.category === 'account' && item.channel === 'in_app' ? 1 : item.enabled === true ? 1 : 0;
    statements.push(env.TEAM_DB.prepare(`INSERT INTO user_notification_preferences
      (user_id, channel, category, enabled, quiet_start, quiet_end, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, channel, category) DO UPDATE SET enabled = excluded.enabled,
      quiet_start = excluded.quiet_start, quiet_end = excluded.quiet_end, updated_at = excluded.updated_at`)
      .bind(actor.id, item.channel, item.category, enabled, quietStart, quietEnd, now));
  });
  if (statements.length) await env.TEAM_DB.batch(statements);
  await audit(env.TEAM_DB, actor.id, 'notification_preferences.update', 'user', actor.id, { count: statements.length });
  return { ok: true };
}

export async function registerPushSubscription(request, payload, env) {
  const actor = await requireRole(request, payload, env);
  const subscription = payload.subscription || {};
  const endpoint = String(subscription.endpoint || '');
  const p256dh = String(subscription.keys?.p256dh || '');
  const auth = String(subscription.keys?.auth || '');
  if (!endpoint.startsWith('https://') || !p256dh || !auth) throw new ApiError('invalid_push_subscription', 400);
  const now = nowIso();
  const id = newId('push');
  await env.TEAM_DB.prepare(`INSERT INTO push_subscriptions
    (id, user_id, endpoint, p256dh, auth, device_label, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
    device_label = excluded.device_label, active = 1, updated_at = excluded.updated_at`)
    .bind(id, actor.id, endpoint, p256dh, auth, String(payload.deviceLabel || '').trim().slice(0, 80), now, now).run();
  await audit(env.TEAM_DB, actor.id, 'push_subscription.add', 'user', actor.id, {});
  return { ok: true };
}

export async function removePushSubscription(request, payload, env) {
  const actor = await requireRole(request, payload, env);
  const result = await env.TEAM_DB.prepare('UPDATE push_subscriptions SET active = 0, updated_at = ? WHERE id = ? AND user_id = ?')
    .bind(nowIso(), payload.subscriptionId, actor.id).run();
  if (!result.meta.changes) throw new ApiError('not_found', 404);
  return { ok: true };
}

export async function createCalendarToken(request, payload, env) {
  const actor = await requireRole(request, payload, env);
  const rawToken = randomToken(32);
  const tokenHash = await sha256Hex(rawToken);
  const id = newId('calendar');
  await env.TEAM_DB.prepare(`INSERT INTO calendar_tokens
    (id, user_id, token_hash, label, created_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(id, actor.id, tokenHash, String(payload.label || 'My schedule').trim().slice(0, 80), nowIso()).run();
  await audit(env.TEAM_DB, actor.id, 'calendar_token.create', 'calendar_token', id, {});
  const origin = new URL(request.url).origin;
  return { ok: true, id, url: `${origin}/api/team/calendar/${rawToken}.ics` };
}

export async function revokeCalendarToken(request, payload, env) {
  const actor = await requireRole(request, payload, env);
  const result = await env.TEAM_DB.prepare(`UPDATE calendar_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL`)
    .bind(nowIso(), payload.tokenId, actor.id).run();
  if (!result.meta.changes) throw new ApiError('not_found', 404);
  await audit(env.TEAM_DB, actor.id, 'calendar_token.revoke', 'calendar_token', payload.tokenId, {});
  return { ok: true };
}

export async function requestPhoneVerification(request, payload, env) {
  const actor = await requireRole(request, payload, env);
  if (env.SMS_ENABLED !== 'true') throw new ApiError('sms_not_configured', 503);
  const phone = normalizePhone(payload.phone);
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
  const codeHash = await sha256Hex(`${actor.id}:${code}`);
  const verificationId = newId('phone_verification');
  const notificationId = newId('notification');
  const now = nowIso();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await env.TEAM_DB.batch([
    env.TEAM_DB.prepare(`INSERT INTO phone_verifications
      (id, user_id, phone_e164, code_hash, attempts, expires_at, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)`)
      .bind(verificationId, actor.id, phone, codeHash, expiresAt, now),
    env.TEAM_DB.prepare(`INSERT INTO notifications
      (id, user_id, notification_type, title, message, link, idempotency_key, email_status, created_at)
      VALUES (?, ?, 'account_phone_verification', 'Phone verification code', ?, '/team/profile.html', ?, 'skipped', ?)`)
      .bind(notificationId, actor.id, `Your Shibam Coffee verification code is ${code}. It expires in 10 minutes.`,
        `${verificationId}:sms`, now),
    env.TEAM_DB.prepare(`INSERT INTO notification_deliveries
      (id, notification_id, channel, destination, status, created_at) VALUES (?, ?, 'sms', ?, 'pending', ?)`)
      .bind(newId('delivery'), notificationId, phone, now)
  ]);
  if (env.NOTIFICATIONS?.send) await env.NOTIFICATIONS.send({ notificationId });
  await audit(env.TEAM_DB, actor.id, 'phone_verification.request', 'user', actor.id, { phoneLast4: phone.slice(-4) });
  return { ok: true, verificationId, smsConfigured: true };
}

export async function verifyPhone(request, payload, env) {
  const actor = await requireRole(request, payload, env);
  const item = await env.TEAM_DB.prepare(`SELECT * FROM phone_verifications WHERE id = ? AND user_id = ?
    AND verified_at IS NULL AND expires_at > ?`).bind(payload.verificationId, actor.id, nowIso()).first();
  if (!item || Number(item.attempts) >= 5) throw new ApiError('verification_expired', 409);
  const actual = await sha256Hex(`${actor.id}:${String(payload.code || '')}`);
  if (actual !== item.code_hash) {
    await env.TEAM_DB.prepare('UPDATE phone_verifications SET attempts = attempts + 1 WHERE id = ?').bind(item.id).run();
    throw new ApiError('invalid_verification_code', 400);
  }
  const now = nowIso();
  await env.TEAM_DB.batch([
    env.TEAM_DB.prepare('UPDATE phone_verifications SET verified_at = ? WHERE id = ?').bind(now, item.id),
    env.TEAM_DB.prepare('UPDATE users SET phone_e164 = ?, phone_verified_at = ?, updated_at = ? WHERE id = ?')
      .bind(item.phone_e164, now, now, actor.id)
  ]);
  await audit(env.TEAM_DB, actor.id, 'phone_verification.complete', 'user', actor.id, {});
  return { ok: true };
}

export async function listInvitations(request, payload, env) {
  await requireRole(request, payload, env, 'management');
  const { results } = await env.TEAM_DB.prepare(`SELECT i.*, u.name AS created_by_name FROM user_invitations i
    JOIN users u ON u.id = i.created_by ORDER BY i.created_at DESC LIMIT 100`).all();
  return { ok: true, invitations: results.map((row) => ({ id: row.id, email: row.email, name: row.name, role: row.role,
    status: row.status, expiresAt: row.expires_at, createdAt: row.created_at, createdBy: row.created_by_name,
    emailSentAt: row.email_sent_at || '', emailLastError: row.email_last_error || '' })) };
}

export async function createInvitation(request, payload, env) {
  const actor = await requireRole(request, payload, env, 'management');
  const email = String(payload.email || '').trim().toLowerCase();
  const name = String(payload.name || '').trim().slice(0, 100);
  const role = String(payload.role || 'barista');
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !['barista', 'lead', 'management'].includes(role)) {
    throw new ApiError('invalid_invitation', 400);
  }
  const existingUser = await env.TEAM_DB.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE').bind(email).first();
  if (existingUser) throw new ApiError('email_taken', 409);
  await env.TEAM_DB.prepare("UPDATE user_invitations SET status = 'revoked', revoked_at = ? WHERE email = ? COLLATE NOCASE AND status = 'pending'")
    .bind(nowIso(), email).run();
  const rawToken = randomToken(32);
  const id = newId('invite');
  const now = nowIso();
  const expiresAt = new Date(Date.now() + 72 * 3600 * 1000).toISOString();
  await env.TEAM_DB.prepare(`INSERT INTO user_invitations
    (id, email, name, role, position_ids_json, max_weekly_minutes, token_hash, status, expires_at, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`)
    .bind(id, email, name, role, JSON.stringify(Array.isArray(payload.positionIds) ? payload.positionIds.slice(0, 20) : []),
      clampInt(payload.maxWeeklyMinutes, 0, 10080, 2400), await sha256Hex(rawToken), expiresAt, actor.id, now).run();
  const deliveryConfigured = env.INVITATION_EMAIL_ENABLED === 'true' && !!env.NOTIFICATIONS?.send;
  if (deliveryConfigured) await env.NOTIFICATIONS.send({ kind: 'invitation', invitationId: id, token: rawToken });
  await audit(env.TEAM_DB, actor.id, 'invitation.create', 'user_invitation', id, { email, role });
  return { ok: true, id, expiresAt, deliveryConfigured };
}

export async function revokeInvitation(request, payload, env) {
  const actor = await requireRole(request, payload, env, 'management');
  const result = await env.TEAM_DB.prepare(`UPDATE user_invitations SET status = 'revoked', revoked_at = ?
    WHERE id = ? AND status = 'pending'`).bind(nowIso(), payload.invitationId).run();
  if (!result.meta.changes) throw new ApiError('invitation_not_pending', 409);
  await audit(env.TEAM_DB, actor.id, 'invitation.revoke', 'user_invitation', payload.invitationId, {});
  return { ok: true };
}

export async function inspectInvitation(request, payload, env) {
  const tokenHash = await sha256Hex(String(payload.invitationToken || ''));
  const invitation = await env.TEAM_DB.prepare(`SELECT id, email, name, role, expires_at FROM user_invitations
    WHERE token_hash = ? AND status = 'pending' AND expires_at > ?`).bind(tokenHash, nowIso()).first();
  if (!invitation) throw new ApiError('invitation_invalid', 404);
  return { ok: true, invitation: { email: invitation.email, name: invitation.name, role: invitation.role, expiresAt: invitation.expires_at } };
}

export async function acceptInvitation(request, payload, env) {
  const tokenHash = await sha256Hex(String(payload.invitationToken || ''));
  const invitation = await env.TEAM_DB.prepare(`SELECT * FROM user_invitations
    WHERE token_hash = ? AND status = 'pending' AND expires_at > ?`).bind(tokenHash, nowIso()).first();
  if (!invitation) throw new ApiError('invitation_invalid', 404);
  const username = String(payload.username || '').trim();
  if (!/^[A-Za-z0-9._-]{3,40}$/.test(username)) throw new ApiError('invalid_username', 400);
  const exists = await env.TEAM_DB.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE')
    .bind(username, invitation.email).first();
  if (exists) throw new ApiError('email_or_username_taken', 409);
  const password = await makePassword(payload.password);
  const id = newId('usr');
  const now = nowIso();
  const positions = safeJsonParse(invitation.position_ids_json, []);
  if (!positions.length) positions.push(invitation.role === 'management' ? 'position-management' : invitation.role === 'lead' ? 'position-lead' : 'position-barista');
  const statements = [
    env.TEAM_DB.prepare(`INSERT INTO users
      (id, username, name, email, role, password_hash, password_salt, password_algorithm, max_weekly_minutes, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
      .bind(id, username, invitation.name, invitation.email, invitation.role, password.hash, password.salt, password.algorithm,
        invitation.max_weekly_minutes, now, now),
    env.TEAM_DB.prepare(`UPDATE user_invitations SET status = 'accepted', accepted_at = ?
      WHERE id = ? AND status = 'pending'`).bind(now, invitation.id)
  ];
  positions.forEach((positionId) => statements.push(env.TEAM_DB.prepare(`INSERT OR IGNORE INTO employee_positions
    (user_id, position_id) VALUES (?, ?)`).bind(id, positionId)));
  await env.TEAM_DB.batch(statements);
  await audit(env.TEAM_DB, id, 'invitation.accept', 'user_invitation', invitation.id, {});
  return { ok: true };
}

export async function updateManagedUser(request, payload, env) {
  const actor = await requireRole(request, payload, env, 'management');
  const input = payload.user || {};
  const user = await env.TEAM_DB.prepare('SELECT * FROM users WHERE id = ?').bind(input.id).first();
  if (!user) throw new ApiError('not_found', 404);
  const role = String(input.role || user.role);
  if (!['barista', 'lead', 'management'].includes(role)) throw new ApiError('invalid_user', 400);
  const active = input.active === false ? 0 : 1;
  if (!active && user.id === actor.id) throw new ApiError('cannot_remove_self', 409);
  if (user.role === 'management' && Number(user.active) === 1 && (role !== 'management' || !active)) {
    const count = await env.TEAM_DB.prepare("SELECT COUNT(*) AS total FROM users WHERE role = 'management' AND active = 1").first();
    if (Number(count.total) <= 1) throw new ApiError('cannot_remove_last_management', 409);
  }
  const name = String(input.name || user.name).trim().slice(0, 100);
  const email = String(input.email || '').trim().toLowerCase() || null;
  if (!name || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new ApiError('invalid_user', 400);
  const positions = Array.isArray(input.positionIds) ? input.positionIds.slice(0, 20) : [];
  const now = nowIso();
  const statements = [
    env.TEAM_DB.prepare(`UPDATE users SET name = ?, email = ?, role = ?, max_weekly_minutes = ?, active = ?, updated_at = ? WHERE id = ?`)
      .bind(name, email, role,
        clampInt(input.maxWeeklyMinutes, 0, 10080, user.max_weekly_minutes), active, now, user.id),
    env.TEAM_DB.prepare('DELETE FROM employee_positions WHERE user_id = ?').bind(user.id)
  ];
  positions.forEach((positionId) => statements.push(env.TEAM_DB.prepare('INSERT OR IGNORE INTO employee_positions (user_id, position_id) VALUES (?, ?)')
    .bind(user.id, positionId)));
  if (!active) statements.push(env.TEAM_DB.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').bind(now, user.id));
  try {
    await env.TEAM_DB.batch(statements);
  } catch (error) {
    if (String(error).includes('UNIQUE')) throw new ApiError('email_taken', 409);
    throw error;
  }
  await audit(env.TEAM_DB, actor.id, 'user.update', 'user', user.id, { role, active });
  return { ok: true };
}
