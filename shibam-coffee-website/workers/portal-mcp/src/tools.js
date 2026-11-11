// The Portal MCP tools. Each tool runs the portal's OWN code as the signed-in person, so roles
// and privacy rules are exactly the portal's, and then passes the result through an explicit
// allow-list. Only the fields named here ever reach an AI app: a field added to the portal later
// is not exposed until someone adds it here on purpose.
//
// Never returned: customer or candidate names, emails, phone numbers, booking answers, private
// links or tokens, staff emails, time-off reasons, or password/session data.
//
// This module has no Cloudflare-only imports so it can be tested directly with node --test.
import { actAs, audit, hasRole, requireRole } from '../../../functions/_lib/auth.js';
import { getCalendar } from '../../../functions/_lib/calendar.js';
import { listBookingLinks, listEventTypes } from '../../../functions/_lib/calendar-setup.js';
import { getCateringRequests } from '../../../functions/_lib/catering.js';
import { readCateringThread } from '../../../functions/_lib/catering-conversation.js';
import { ApiError, publicUser, safeJsonParse, sha256Hex, weekStartFor } from '../../../functions/_lib/http.js';
import { getManagerSchedule } from '../../../functions/_lib/scheduling.js';

export const MIN_ROLE = 'lead';
const REQUESTS_PER_MINUTE = 120;

export class ToolError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// Reloads the person on every call, so a deactivated account or a role change takes effect at once.
export async function loadConnectedUser(env, userId) {
  const row = userId ? await env.TEAM_DB.prepare('SELECT * FROM users WHERE id = ? AND active = 1').bind(String(userId)).first() : null;
  if (!row) throw new ToolError('account_inactive', 'This portal account is no longer active. Reconnect with an active account.', 401);
  const user = publicUser(row);
  if (!hasRole(user, MIN_ROLE)) throw new ToolError('role_not_allowed', 'Only Leads and Management can use the portal connector.', 403);
  return user;
}

export async function enforceRateLimit(env, userId, now = Date.now()) {
  const minute = Math.floor(now / 60_000);
  const key = await sha256Hex(`mcp:${userId}:${minute}`);
  await env.TEAM_DB.prepare(`INSERT INTO public_rate_limits (bucket_key, hits, expires_at) VALUES (?, 1, ?)
    ON CONFLICT(bucket_key) DO UPDATE SET hits = hits + 1`).bind(key, new Date((minute + 2) * 60_000).toISOString()).run();
  const row = await env.TEAM_DB.prepare('SELECT hits FROM public_rate_limits WHERE bucket_key = ?').bind(key).first();
  if (Number(row?.hits || 0) > REQUESTS_PER_MINUTE) throw new ToolError('rate_limited', 'Too many requests. Wait a minute and try again.', 429);
}

export async function recordToolUse(env, user, tool, clientName) {
  await audit(env.TEAM_DB, user.id, `mcp.${tool}`, 'mcp_tool', tool, { client: String(clientName || '').slice(0, 100) });
}

// A request that the portal's own handlers accept as coming from `user`.
function asUser(env, user) {
  const origin = env.PUBLIC_ORIGIN || 'https://shibamatlanta.com';
  return actAs(new Request(`${origin}/api/team`, { method: 'POST' }), user);
}

const API_MESSAGES = {
  forbidden: 'Your portal role does not allow that.',
  not_found: 'Nothing was found with that id.',
  invalid_range: 'The end date must be on or after the start date.',
  range_too_large: 'Ask for 100 days or fewer at a time.',
  invalid_from: 'Use a start date like 2026-11-30.',
  invalid_to: 'Use an end date like 2026-11-30.',
  invalid_date: 'Use a date like 2026-11-30.'
};

// Turns a portal error into a short, safe message for the AI app.
export function toToolError(error) {
  if (error instanceof ToolError) return error;
  if (error instanceof ApiError) return new ToolError(error.code, API_MESSAGES[error.code] || `The portal refused the request (${error.code}).`, error.status);
  return new ToolError('internal_error', 'Something went wrong in the portal. Try again later.', 500);
}

function numberOrNull(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// ---- tools ----

export async function whoami(env, user) {
  return {
    name: user.name,
    role: user.role,
    access: 'read-only',
    can_see: [
      'the latest inventory count and items below their order-below level',
      'the weekly schedule (names, positions, times; no time-off reasons)',
      'the team calendar (other people\'s meetings show only as "Booked")',
      'catering requests and conversations (without customer names, emails or phone numbers)',
      'your meeting types and booking links (status and counts, not the private link addresses)'
    ],
    cannot: ['change anything in the portal', 'see customer or candidate contact details', 'see private booking or conversation links']
  };
}

export async function inventoryLatestCount(env, user, { only_below_threshold = false, section = '' } = {}) {
  await requireRole(asUser(env, user), {}, env, MIN_ROLE);
  const db = env.TEAM_DB;
  const [latest, draft] = await Promise.all([
    db.prepare(`SELECT ic.*, u.name AS submitted_by_name FROM inventory_counts ic LEFT JOIN users u ON u.id = ic.submitted_by
      WHERE ic.status = 'submitted' ORDER BY ic.count_date DESC, ic.submitted_at DESC LIMIT 1`).first(),
    db.prepare("SELECT * FROM inventory_counts WHERE status = 'draft' LIMIT 1").first()
  ]);
  const inProgress = draft ? {
    count_date: draft.count_date,
    started_by: draft.started_by_name || '',
    last_saved: draft.updated_at,
    items_entered: Object.keys(safeJsonParse(draft.draft_json, {}).items || {}).length
  } : null;
  if (!latest) return { count: null, in_progress: inProgress, message: 'No inventory count has been submitted yet.' };

  const { results } = await db.prepare(`SELECT e.product, e.details_json, c.name AS current_name, c.unit, c.threshold,
      s.name AS section_name, s.sort_order AS section_order, c.sort_order
    FROM form_entries e LEFT JOIN catalog c ON c.id = e.catalog_id LEFT JOIN inventory_sections s ON s.id = c.section_id
    WHERE e.submission_id = ? AND e.form_type = 'inventory' AND e.details_json != '{"removed":true}'
    ORDER BY COALESCE(s.sort_order, 1000000), COALESCE(c.sort_order, 0), e.product`).bind(latest.id).all();
  const wanted = String(section || '').trim().toLowerCase();
  let withoutThreshold = 0;
  const items = results.map((row) => {
    const details = safeJsonParse(row.details_json, {});
    const kitchen = Number(details.qtyKitchen ?? details.qtyOnHand ?? 0) || 0;
    const storage = Number(details.qtyStorage ?? 0) || 0;
    const total = kitchen + storage;
    const orderBelow = numberOrNull(row.threshold);
    if (orderBelow === null) withoutThreshold += 1;
    return {
      item: row.current_name || details.product || row.product,
      section: row.section_name || 'Unassigned items',
      unit: row.unit || details.unit || '',
      kitchen,
      storage,
      total,
      order_below: orderBelow,
      below_threshold: orderBelow === null ? null : total < orderBelow,
      note: details.notes || ''
    };
  }).filter((item) => !wanted || item.section.toLowerCase().includes(wanted))
    .filter((item) => !only_below_threshold || item.below_threshold === true);
  return {
    count: {
      count_date: latest.count_date,
      submitted_by: latest.submitted_by_name || '',
      submitted_at: latest.submitted_at,
      contributors: safeJsonParse(latest.contributors_json, [])
    },
    in_progress: inProgress,
    items,
    items_without_order_below_level: withoutThreshold,
    note: 'below_threshold compares the counted total with the item\'s "order below" level; it is null when no level is set.'
  };
}

export async function scheduleWeek(env, user, { week_start = '' } = {}) {
  const payload = week_start ? { weekStart: weekStartFor(week_start) } : {};
  const result = await getManagerSchedule(asUser(env, user), payload, env);
  if (!result.schedule) return { week_start: payload.weekStart || null, status: 'not created', shifts: [], time_off: [] };
  const shifts = result.shifts.filter((shift) => shift.status !== 'cancelled').map((shift) => ({
    date: shift.date,
    start: shift.startTime,
    end: shift.endTime,
    ends_next_day: !!shift.endsNextDay,
    employee: shift.employeeName || null,
    open_shift: !shift.employeeId,
    position: shift.positionName || '',
    break_minutes: shift.breakMinutes,
    notes: shift.notes || '',
    confirmed: !!shift.confirmedAt
  })).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  return {
    week_start: result.schedule.weekStart,
    status: result.schedule.status,
    published_at: result.schedule.publishedAt || null,
    shifts,
    open_shifts: shifts.filter((shift) => shift.open_shift).length,
    // Who is off, never why.
    time_off: result.timeOff.map((item) => ({
      employee: item.employeeName, from: item.startDate, to: item.endDate,
      start_time: item.startTime || null, end_time: item.endTime || null, status: item.status
    }))
  };
}

export async function teamCalendar(env, user, { from, to }) {
  const result = await getCalendar(asUser(env, user), { from, to }, env);
  return {
    timezone: result.timezone,
    events: result.events.map((event) => ({
      title: event.title, start: event.startUtc, end: event.endUtc, all_day: !!event.allDay,
      location: event.location || '', notes: event.description || '', added_by: event.creatorName
    })),
    // Meetings booked through booking links. Never the invitee's details, even for the host.
    meetings: result.bookings.map((booking) => ({
      start: booking.startUtc,
      end: booking.endUtc,
      title: booking.redacted ? 'Booked' : booking.title,
      yours: !booking.redacted && booking.ownerId === user.id
    })),
    note: 'Times are in UTC. Meetings show the meeting type only; invitee names and contact details are never shared.'
  };
}

export async function cateringRequests(env, user, { status = '', limit = 25 } = {}) {
  const result = await getCateringRequests(asUser(env, user), { status }, env);
  return {
    unread_conversations: result.unreadReplies,
    requests: result.requests.slice(0, Math.min(Math.max(Number(limit) || 25, 1), 100)).map((request) => ({
      id: request.id,
      event_type: request.eventType,
      event_date: request.eventDate || null,
      guest_count: request.guestCount,
      details: request.details,
      status: request.status,
      submitted_at: request.createdAt,
      messages: request.messageCount,
      unread_replies: request.unreadCount,
      handled_by: request.assignedToName || null
    })),
    total: result.requests.length,
    note: 'Customer names, emails and phone numbers are not shared. Open the request in the portal to contact them.'
  };
}

export async function cateringConversation(env, user, { request_id }) {
  await requireRole(asUser(env, user), {}, env, MIN_ROLE);
  // markRead:false: an AI reading the conversation must not clear the team's unread badges.
  const { row, messages } = await readCateringThread(env, request_id, { markRead: false });
  return {
    request: {
      id: row.id, event_type: row.event_type, event_date: row.event_date || null,
      guest_count: row.guest_count === null ? null : Number(row.guest_count), details: row.details || '', status: row.status
    },
    messages: messages.map((message) => ({
      from: message.kind === 'customer' ? 'customer' : message.kind === 'note' ? 'internal note' : 'team',
      author: message.kind === 'customer' ? 'Customer' : message.authorName,
      text: message.body,
      at: message.createdAt,
      unread: message.kind === 'customer' ? !!message.unread : undefined
    })),
    note: 'Read-only. Replies are sent from the portal. Internal notes are never shown to the customer.'
  };
}

export async function meetingTypes(env, user) {
  const request = asUser(env, user);
  const types = (await listEventTypes(request, { all: user.role === 'management' }, env)).eventTypes;
  const out = [];
  for (const type of types) {
    const links = (await listBookingLinks(request, { eventTypeId: type.id }, env)).links;
    out.push({
      name: type.name,
      owner: type.ownerName,
      active: type.active,
      length_minutes: type.durationMinutes,
      address: type.locationName,
      book_up_to_days: type.maxDaysAhead,
      // Status and counts only. The link addresses are private and are copied from the portal.
      links: links.map((link) => ({ label: link.label || 'Untitled link', status: link.status, booked: link.useCount, max_bookings: link.maxUses, expires: link.expiresAt }))
    });
  }
  return { meeting_types: out };
}

export const TOOLS = {
  portal_whoami: whoami,
  inventory_latest_count: inventoryLatestCount,
  schedule_week: scheduleWeek,
  team_calendar: teamCalendar,
  catering_requests: cateringRequests,
  catering_conversation: cateringConversation,
  meeting_types: meetingTypes
};

// Runs one tool for a connected person: reload them, rate limit, run, record. Shared by the MCP
// server and the tests, so what is tested is what runs.
export async function runTool(env, { userId, clientName }, name, args = {}) {
  const tool = TOOLS[name];
  if (!Object.hasOwn(TOOLS, name) || typeof tool !== 'function') throw new ToolError('unknown_tool', 'Unknown tool.', 404);
  const user = await loadConnectedUser(env, userId);
  await enforceRateLimit(env, user.id);
  try {
    const data = await tool(env, user, args);
    await recordToolUse(env, user, name, clientName);
    return data;
  } catch (error) {
    throw toToolError(error);
  }
}
