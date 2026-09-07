import { audit, requireRole } from './auth.js';
import { ApiError, asBoolean, newId, normalizeDate, nowIso, safeJsonParse } from './http.js';
import { enqueueExistingNotification } from './scheduling.js';

const WARNING_LEVELS = new Set(['verbal', 'strike_1', 'strike_2', 'strike_3']);
const INFRACTION_TYPES = new Set([
  'attendance_punctuality',
  'performance_issues',
  'customer_service',
  'failure_to_follow_procedures',
  'policy_violation',
  'insubordination',
  'safety_violation',
  'other'
]);

function requiredText(value, field, maxLength) {
  const text = String(value || '').trim();
  if (!text) throw new ApiError(`missing_${field}`, 400);
  return text.slice(0, maxLength);
}

function optionalText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function optionalDate(value, field) {
  return value ? normalizeDate(value, field) : null;
}

function writeUpDto(row) {
  const parsedInfractions = safeJsonParse(row.infractions_json, []);
  return {
    writeUpId: row.id,
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    employeePosition: row.employee_position || '',
    writeUpDate: row.write_up_date,
    supervisorName: row.supervisor_name,
    warningLevel: row.warning_level,
    infractions: Array.isArray(parsedInfractions) ? parsedInfractions : [],
    otherInfraction: row.other_infraction || '',
    incidentDescription: row.incident_description,
    correctiveActionPlan: row.corrective_action_plan,
    followUpReviewDate: row.follow_up_review_date || '',
    employeeComments: row.employee_comments || '',
    employeeSignature: row.employee_signature || '',
    employeeSignatureDate: row.employee_signature_date || '',
    employeeDeclinedToSign: asBoolean(row.employee_declined_to_sign),
    managerSignature: row.manager_signature,
    managerSignatureDate: row.manager_signature_date,
    witnessName: row.witness_name || '',
    witnessDate: row.witness_date || '',
    createdByName: row.created_by_name || row.supervisor_name,
    workflowStatus: row.workflow_status || 'completed',
    sentAt: row.sent_at || '',
    employeeCompletedAt: row.employee_completed_at || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
    version: Number(row.version || 1)
  };
}

async function listEmployees(db) {
  const { results } = await db.prepare(`SELECT u.id, u.name, u.preferred_name, u.role,
      COALESCE(GROUP_CONCAT(p.name, ', '), '') AS position_names
    FROM users u
    LEFT JOIN employee_positions ep ON ep.user_id = u.id
    LEFT JOIN positions p ON p.id = ep.position_id AND p.active = 1
    WHERE u.active = 1
    GROUP BY u.id
    ORDER BY COALESCE(NULLIF(u.preferred_name, ''), u.name)`).all();
  return results.map((row) => ({
    id: row.id,
    name: row.name,
    displayName: row.preferred_name || row.name,
    legalName: row.name,
    role: row.role,
    position: row.position_names || (row.role === 'management' ? 'Management' : row.role === 'lead' ? 'Shift Lead' : 'Barista')
  }));
}

async function listInbox(db, actor) {
  const { results } = await db.prepare(`SELECT ew.*, creator.name AS created_by_name
    FROM employee_write_ups ew
    LEFT JOIN users creator ON creator.id = ew.created_by
    WHERE ew.employee_id = ? AND ew.workflow_status IN ('sent', 'completed')
    ORDER BY COALESCE(ew.sent_at, ew.created_at) DESC
    LIMIT 100`).bind(actor.id).all();
  return results.map(writeUpDto);
}

async function listManagedWriteUps(db, actor) {
  const where = actor.role === 'management' ? '' : 'WHERE ew.created_by = ?';
  const statement = db.prepare(`SELECT ew.*, creator.name AS created_by_name
    FROM employee_write_ups ew
    LEFT JOIN users creator ON creator.id = ew.created_by
    ${where}
    ORDER BY CASE ew.workflow_status WHEN 'draft' THEN 0 WHEN 'sent' THEN 1 ELSE 2 END,
      COALESCE(ew.updated_at, ew.created_at) DESC
    LIMIT 100`);
  const { results } = actor.role === 'management' ? await statement.all() : await statement.bind(actor.id).all();
  return results.map(writeUpDto);
}

async function getEmployee(db, employeeId) {
  return db.prepare(`SELECT u.id, u.name, u.preferred_name, u.role,
      COALESCE(GROUP_CONCAT(p.name, ', '), '') AS position_names
    FROM users u
    LEFT JOIN employee_positions ep ON ep.user_id = u.id
    LEFT JOIN positions p ON p.id = ep.position_id AND p.active = 1
    WHERE u.id = ? AND u.active = 1
    GROUP BY u.id`).bind(employeeId).first();
}

function validateLeadPortion(input) {
  const warningLevel = String(input.warningLevel || '');
  if (!WARNING_LEVELS.has(warningLevel)) throw new ApiError('invalid_warning_level', 400);
  const infractions = Array.from(new Set(Array.isArray(input.infractions) ? input.infractions.map(String) : []));
  if (!infractions.length || infractions.some((item) => !INFRACTION_TYPES.has(item))) {
    throw new ApiError('invalid_infractions', 400);
  }
  const otherInfraction = optionalText(input.otherInfraction, 300);
  if (infractions.includes('other') && !otherInfraction) throw new ApiError('missing_other_infraction', 400);

  const writeUpDate = normalizeDate(input.writeUpDate, 'write_up_date');
  const followUpReviewDate = optionalDate(input.followUpReviewDate, 'follow_up_review_date');
  if (followUpReviewDate && followUpReviewDate < writeUpDate) {
    throw new ApiError('invalid_follow_up_review_date', 400);
  }

  const witnessName = optionalText(input.witnessName, 160) || null;
  const witnessDate = optionalDate(input.witnessDate, 'witness_date');
  if (Boolean(witnessName) !== Boolean(witnessDate)) throw new ApiError('incomplete_witness', 400);

  return {
    warningLevel,
    infractions,
    otherInfraction,
    writeUpDate,
    followUpReviewDate,
    incidentDescription: requiredText(input.incidentDescription, 'incident_description', 5000),
    correctiveActionPlan: requiredText(input.correctiveActionPlan, 'corrective_action_plan', 5000),
    managerSignature: requiredText(input.managerSignature, 'manager_signature', 160),
    managerSignatureDate: normalizeDate(input.managerSignatureDate, 'manager_signature_date'),
    witnessName,
    witnessDate
  };
}

function canManageRecord(actor, record) {
  return actor.role === 'management' || record.created_by === actor.id;
}

export async function getWriteUpWorkspace(request, payload, env) {
  const actor = await requireRole(request, payload, env);
  const inboxPromise = listInbox(env.TEAM_DB, actor);
  if (actor.role === 'barista') {
    return { ok: true, inbox: await inboxPromise, managedWriteUps: [], employees: [], supervisor: null, historyScope: 'assigned_to_me' };
  }
  const [inbox, employees, managedWriteUps] = await Promise.all([
    inboxPromise,
    listEmployees(env.TEAM_DB),
    listManagedWriteUps(env.TEAM_DB, actor)
  ]);
  return {
    ok: true,
    inbox,
    employees,
    managedWriteUps,
    supervisor: { id: actor.id, name: actor.name },
    historyScope: actor.role === 'management' ? 'all' : 'created_by_me'
  };
}

export async function getEmployeeMessageSummary(request, payload, env) {
  const actor = await requireRole(request, payload, env);
  const row = await env.TEAM_DB.prepare(`SELECT COUNT(*) AS pending_count
    FROM employee_write_ups WHERE employee_id = ? AND workflow_status = 'sent'`)
    .bind(actor.id).first();
  return { ok: true, pendingCount: Number(row?.pending_count || 0) };
}

export async function saveWriteUpDraft(request, payload, env) {
  const actor = await requireRole(request, payload, env, 'lead');
  const input = payload.writeUp || {};
  const employeeId = String(input.employeeId || '');
  if (!employeeId) throw new ApiError('missing_employee', 400);
  if (employeeId === actor.id) throw new ApiError('cannot_write_up_self', 409);

  const employee = await getEmployee(env.TEAM_DB, employeeId);
  if (!employee) throw new ApiError('employee_not_found', 404);
  const values = validateLeadPortion(input);
  const position = employee.position_names || (employee.role === 'management' ? 'Management' : employee.role === 'lead' ? 'Shift Lead' : 'Barista');
  const now = nowIso();
  const draftId = String(input.writeUpId || '');

  if (draftId) {
    const existing = await env.TEAM_DB.prepare('SELECT * FROM employee_write_ups WHERE id = ?').bind(draftId).first();
    if (!existing) throw new ApiError('write_up_not_found', 404);
    if (existing.workflow_status !== 'draft') throw new ApiError('write_up_not_editable', 409);
    if (!canManageRecord(actor, existing)) throw new ApiError('forbidden', 403);
    const expectedVersion = Number(input.version);
    if (!Number.isInteger(expectedVersion) || expectedVersion !== Number(existing.version)) throw new ApiError('version_conflict', 409);
    const result = await env.TEAM_DB.prepare(`UPDATE employee_write_ups SET
      employee_id = ?, employee_name = ?, employee_position = ?, write_up_date = ?,
      supervisor_user_id = ?, supervisor_name = ?, warning_level = ?, infractions_json = ?,
      other_infraction = ?, incident_description = ?, corrective_action_plan = ?,
      follow_up_review_date = ?, manager_signature = ?, manager_signature_date = ?,
      witness_name = ?, witness_date = ?, updated_at = ?, version = version + 1
      WHERE id = ? AND workflow_status = 'draft' AND version = ?`)
      .bind(
        employee.id, employee.name, position, values.writeUpDate,
        actor.id, actor.name, values.warningLevel, JSON.stringify(values.infractions),
        values.otherInfraction, values.incidentDescription, values.correctiveActionPlan,
        values.followUpReviewDate, values.managerSignature, values.managerSignatureDate,
        values.witnessName, values.witnessDate, now, existing.id, expectedVersion
      ).run();
    if (!result.meta.changes) throw new ApiError('version_conflict', 409);
    await audit(env.TEAM_DB, actor.id, 'employee_write_up.draft_update', 'employee_write_up', existing.id, {
      employeeId: employee.id,
      warningLevel: values.warningLevel
    });
    return { ok: true, writeUpId: existing.id, version: expectedVersion + 1 };
  }

  const id = newId('writeup');
  await env.TEAM_DB.prepare(`INSERT INTO employee_write_ups
    (id, employee_id, employee_name, employee_position, write_up_date,
     supervisor_user_id, supervisor_name, warning_level, infractions_json,
     other_infraction, incident_description, corrective_action_plan,
     follow_up_review_date, employee_comments, employee_signature,
     employee_signature_date, employee_declined_to_sign, manager_signature,
     manager_signature_date, witness_name, witness_date, created_by, created_at,
     workflow_status, sent_at, employee_completed_at, updated_at, version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', NULL, NULL, 0, ?, ?, ?, ?, ?, ?, 'draft', NULL, NULL, ?, 1)`)
    .bind(
      id, employee.id, employee.name, position, values.writeUpDate,
      actor.id, actor.name, values.warningLevel, JSON.stringify(values.infractions),
      values.otherInfraction, values.incidentDescription, values.correctiveActionPlan,
      values.followUpReviewDate, values.managerSignature, values.managerSignatureDate,
      values.witnessName, values.witnessDate, actor.id, now, now
    ).run();
  await audit(env.TEAM_DB, actor.id, 'employee_write_up.draft_create', 'employee_write_up', id, {
    employeeId: employee.id,
    warningLevel: values.warningLevel
  });
  return { ok: true, writeUpId: id, version: 1 };
}

export async function sendWriteUp(request, payload, env) {
  const actor = await requireRole(request, payload, env, 'lead');
  const writeUpId = String(payload.writeUpId || '');
  const record = await env.TEAM_DB.prepare(`SELECT ew.*, u.active AS employee_active
    FROM employee_write_ups ew JOIN users u ON u.id = ew.employee_id WHERE ew.id = ?`).bind(writeUpId).first();
  if (!record) throw new ApiError('write_up_not_found', 404);
  if (!canManageRecord(actor, record)) throw new ApiError('forbidden', 403);
  if (record.workflow_status !== 'draft') throw new ApiError('write_up_already_sent', 409);
  if (!asBoolean(record.employee_active)) throw new ApiError('employee_not_found', 404);
  const expectedVersion = Number(payload.version);
  if (!Number.isInteger(expectedVersion) || expectedVersion !== Number(record.version)) throw new ApiError('version_conflict', 409);

  const now = nowIso();
  const notificationId = newId('notification');
  const notificationType = 'account_employee_message';
  const notificationTitle = 'New employee message';
  const notificationMessage = `${record.supervisor_name} sent you a confidential document to review.`;
  const notificationLink = `/team/write-up?id=${encodeURIComponent(record.id)}`;
  const results = await env.TEAM_DB.batch([
    env.TEAM_DB.prepare(`INSERT OR IGNORE INTO notifications
      (id, user_id, notification_type, title, message, link, idempotency_key, email_status, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, 'pending', ?
      WHERE EXISTS (SELECT 1 FROM employee_write_ups WHERE id = ? AND workflow_status = 'draft' AND version = ?)`)
      .bind(notificationId, record.employee_id, notificationType, notificationTitle, notificationMessage,
        notificationLink, `employee-write-up:${record.id}:sent`, now, record.id, expectedVersion),
    env.TEAM_DB.prepare(`UPDATE employee_write_ups
      SET workflow_status = 'sent', sent_at = ?, updated_at = ?, version = version + 1
      WHERE id = ? AND workflow_status = 'draft' AND version = ?`)
      .bind(now, now, record.id, expectedVersion)
  ]);
  if (!results[1].meta.changes) throw new ApiError('version_conflict', 409);

  await audit(env.TEAM_DB, actor.id, 'employee_write_up.send', 'employee_write_up', record.id, {
    employeeId: record.employee_id,
    warningLevel: record.warning_level
  });
  if (results[0].meta.changes) {
    await enqueueExistingNotification(env, notificationId, record.employee_id, notificationType, now);
  }
  return { ok: true, writeUpId: record.id, version: expectedVersion + 1, sentAt: now };
}

export async function completeWriteUp(request, payload, env) {
  const actor = await requireRole(request, payload, env);
  const writeUpId = String(payload.writeUpId || '');
  const record = await env.TEAM_DB.prepare('SELECT * FROM employee_write_ups WHERE id = ?').bind(writeUpId).first();
  if (!record) throw new ApiError('write_up_not_found', 404);
  if (record.employee_id !== actor.id) throw new ApiError('forbidden', 403);
  if (record.workflow_status !== 'sent') throw new ApiError('write_up_not_awaiting_response', 409);
  const expectedVersion = Number(payload.version);
  if (!Number.isInteger(expectedVersion) || expectedVersion !== Number(record.version)) throw new ApiError('version_conflict', 409);

  const response = payload.response || {};
  const declined = asBoolean(response.employeeDeclinedToSign);
  const employeeSignature = declined ? null : requiredText(response.employeeSignature, 'employee_signature', 160);
  const employeeSignatureDate = declined ? null : normalizeDate(response.employeeSignatureDate, 'employee_signature_date');
  const employeeComments = optionalText(response.employeeComments, 5000);
  const now = nowIso();
  const notificationId = newId('notification');
  const notificationType = 'account_employee_message_completed';
  const notificationTitle = 'Employee response received';
  const notificationMessage = `${record.employee_name} completed their confidential document response.`;
  const notificationLink = `/team/write-up?id=${encodeURIComponent(record.id)}`;
  const results = await env.TEAM_DB.batch([
    env.TEAM_DB.prepare(`INSERT OR IGNORE INTO notifications
      (id, user_id, notification_type, title, message, link, idempotency_key, email_status, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, 'pending', ?
      WHERE EXISTS (SELECT 1 FROM employee_write_ups
        WHERE id = ? AND employee_id = ? AND workflow_status = 'sent' AND version = ?)`)
      .bind(notificationId, record.created_by, notificationType, notificationTitle, notificationMessage,
        notificationLink, `employee-write-up:${record.id}:completed`, now, record.id, actor.id, expectedVersion),
    env.TEAM_DB.prepare(`UPDATE employee_write_ups SET
      employee_comments = ?, employee_signature = ?, employee_signature_date = ?,
      employee_declined_to_sign = ?, workflow_status = 'completed', employee_completed_at = ?,
      updated_at = ?, version = version + 1
      WHERE id = ? AND employee_id = ? AND workflow_status = 'sent' AND version = ?`)
      .bind(employeeComments, employeeSignature, employeeSignatureDate, declined ? 1 : 0,
        now, now, record.id, actor.id, expectedVersion)
  ]);
  if (!results[1].meta.changes) throw new ApiError('version_conflict', 409);

  await audit(env.TEAM_DB, actor.id, 'employee_write_up.employee_complete', 'employee_write_up', record.id, {
    employeeDeclinedToSign: declined
  });
  if (results[0].meta.changes) {
    await enqueueExistingNotification(env, notificationId, record.created_by, notificationType, now);
  }
  return { ok: true, writeUpId: record.id, version: expectedVersion + 1, completedAt: now };
}
