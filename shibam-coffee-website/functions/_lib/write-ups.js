import { audit, requireRole } from './auth.js';
import { ApiError, asBoolean, newId, normalizeDate, nowIso, safeJsonParse } from './http.js';

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
    createdAt: row.created_at
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

async function listWriteUps(db, actor) {
  const where = actor.role === 'management' ? '' : 'WHERE ew.created_by = ?';
  const statement = db.prepare(`SELECT ew.*, creator.name AS created_by_name
    FROM employee_write_ups ew
    LEFT JOIN users creator ON creator.id = ew.created_by
    ${where}
    ORDER BY ew.write_up_date DESC, ew.created_at DESC
    LIMIT 100`);
  const { results } = actor.role === 'management' ? await statement.all() : await statement.bind(actor.id).all();
  return results.map(writeUpDto);
}

export async function getWriteUpFormData(request, payload, env) {
  const actor = await requireRole(request, payload, env, 'lead');
  const [employees, writeUps] = await Promise.all([
    listEmployees(env.TEAM_DB),
    listWriteUps(env.TEAM_DB, actor)
  ]);
  return {
    ok: true,
    employees,
    writeUps,
    supervisor: { id: actor.id, name: actor.name },
    historyScope: actor.role === 'management' ? 'all' : 'created_by_me'
  };
}

export async function submitWriteUp(request, payload, env) {
  const actor = await requireRole(request, payload, env, 'lead');
  const input = payload.writeUp || {};
  const employeeId = String(input.employeeId || '');
  if (!employeeId) throw new ApiError('missing_employee', 400);
  if (employeeId === actor.id) throw new ApiError('cannot_write_up_self', 409);

  const employee = await env.TEAM_DB.prepare(`SELECT u.id, u.name, u.preferred_name, u.role,
      COALESCE(GROUP_CONCAT(p.name, ', '), '') AS position_names
    FROM users u
    LEFT JOIN employee_positions ep ON ep.user_id = u.id
    LEFT JOIN positions p ON p.id = ep.position_id AND p.active = 1
    WHERE u.id = ? AND u.active = 1
    GROUP BY u.id`).bind(employeeId).first();
  if (!employee) throw new ApiError('employee_not_found', 404);

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

  const employeeDeclinedToSign = asBoolean(input.employeeDeclinedToSign);
  const employeeSignature = employeeDeclinedToSign ? null : requiredText(input.employeeSignature, 'employee_signature', 160);
  const employeeSignatureDate = employeeDeclinedToSign ? null : normalizeDate(input.employeeSignatureDate, 'employee_signature_date');
  const managerSignature = requiredText(input.managerSignature, 'manager_signature', 160);
  const managerSignatureDate = normalizeDate(input.managerSignatureDate, 'manager_signature_date');
  const witnessName = optionalText(input.witnessName, 160) || null;
  const witnessDate = optionalDate(input.witnessDate, 'witness_date');
  if (Boolean(witnessName) !== Boolean(witnessDate)) throw new ApiError('incomplete_witness', 400);

  const position = employee.position_names || (employee.role === 'management' ? 'Management' : employee.role === 'lead' ? 'Shift Lead' : 'Barista');
  const id = newId('writeup');
  const now = nowIso();
  await env.TEAM_DB.prepare(`INSERT INTO employee_write_ups
    (id, employee_id, employee_name, employee_position, write_up_date,
     supervisor_user_id, supervisor_name, warning_level, infractions_json,
     other_infraction, incident_description, corrective_action_plan,
     follow_up_review_date, employee_comments, employee_signature,
     employee_signature_date, employee_declined_to_sign, manager_signature,
     manager_signature_date, witness_name, witness_date, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      id,
      employee.id,
      employee.name,
      position,
      writeUpDate,
      actor.id,
      actor.name,
      warningLevel,
      JSON.stringify(infractions),
      otherInfraction,
      requiredText(input.incidentDescription, 'incident_description', 5000),
      requiredText(input.correctiveActionPlan, 'corrective_action_plan', 5000),
      followUpReviewDate,
      optionalText(input.employeeComments, 5000),
      employeeSignature,
      employeeSignatureDate,
      employeeDeclinedToSign ? 1 : 0,
      managerSignature,
      managerSignatureDate,
      witnessName,
      witnessDate,
      actor.id,
      now
    ).run();
  await audit(env.TEAM_DB, actor.id, 'employee_write_up.create', 'employee_write_up', id, {
    employeeId: employee.id,
    warningLevel
  });
  return { ok: true, writeUpId: id };
}
