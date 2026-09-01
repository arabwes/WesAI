import { addDays, nowIso, sha256Hex } from '../../../_lib/http.js';

function escapeIcs(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
}

function compactTimestamp(value) {
  return new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function localStamp(date, time) {
  return `${String(date).replace(/-/g, '')}T${String(time).replace(':', '')}00`;
}

function foldLine(line) {
  const chunks = [];
  let remaining = line;
  while (new TextEncoder().encode(remaining).length > 73) {
    let index = Math.min(70, remaining.length);
    while (index > 1 && new TextEncoder().encode(remaining.slice(0, index)).length > 73) index -= 1;
    chunks.push(remaining.slice(0, index));
    remaining = ` ${remaining.slice(index)}`;
  }
  chunks.push(remaining);
  return chunks.join('\r\n');
}

export async function onRequestGet(context) {
  if (!context.env.TEAM_DB) return new Response('Calendar is unavailable.', { status: 503 });
  const segment = String(context.params.token || '');
  const rawToken = segment.endsWith('.ics') ? segment.slice(0, -4) : segment;
  if (!rawToken) return new Response('Calendar not found.', { status: 404 });
  const token = await context.env.TEAM_DB.prepare(`SELECT ct.*, u.name, u.active, l.timezone, l.name AS location_name
    FROM calendar_tokens ct JOIN users u ON u.id = ct.user_id
    JOIN locations l ON l.id = 'atlanta'
    WHERE ct.token_hash = ? AND ct.revoked_at IS NULL AND u.active = 1`)
    .bind(await sha256Hex(rawToken)).first();
  if (!token) return new Response('Calendar not found or revoked.', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  const earliest = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  const latest = new Date(Date.now() + 370 * 86400000).toISOString().slice(0, 10);
  const { results: shifts } = await context.env.TEAM_DB.prepare(`SELECT sh.*, p.name AS position_name
    FROM shifts sh JOIN schedules s ON s.id = sh.schedule_id
    LEFT JOIN positions p ON p.id = sh.position_id
    WHERE sh.employee_id = ? AND s.status = 'published' AND sh.shift_date BETWEEN ? AND ?
    ORDER BY sh.shift_date, sh.start_time`).bind(token.user_id, earliest, latest).all();
  const origin = new URL(context.request.url).origin;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Shibam Coffee//Team Schedule//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcs(token.label || 'Shibam Coffee Schedule')}`,
    `X-WR-TIMEZONE:${escapeIcs(token.timezone)}`
  ];
  shifts.forEach((shift) => {
    const endDate = shift.end_time < shift.start_time ? addDays(shift.shift_date, 1) : shift.shift_date;
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${escapeIcs(shift.id)}@shibamatlanta.com`);
    lines.push(`SEQUENCE:${Number(shift.version || 1)}`);
    lines.push(`DTSTAMP:${compactTimestamp(shift.updated_at || nowIso())}`);
    lines.push(`DTSTART;TZID=${escapeIcs(token.timezone)}:${localStamp(shift.shift_date, shift.start_time)}`);
    lines.push(`DTEND;TZID=${escapeIcs(token.timezone)}:${localStamp(endDate, shift.end_time)}`);
    lines.push(`SUMMARY:${escapeIcs(`${shift.position_name || 'Shift'} — ${token.location_name}`)}`);
    lines.push(`LOCATION:${escapeIcs(token.location_name)}`);
    lines.push(`DESCRIPTION:${escapeIcs([shift.notes, shift.break_minutes ? `${shift.break_minutes}-minute break` : ''].filter(Boolean).join('\n'))}`);
    lines.push(`URL:${origin}/team/schedule.html`);
    if (shift.status === 'cancelled') lines.push('STATUS:CANCELLED');
    else lines.push('STATUS:CONFIRMED');
    lines.push('END:VEVENT');
  });
  lines.push('END:VCALENDAR');
  await context.env.TEAM_DB.prepare('UPDATE calendar_tokens SET last_used_at = ? WHERE id = ?').bind(nowIso(), token.id).run();
  return new Response(lines.map(foldLine).join('\r\n') + '\r\n', {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="shibam-schedule.ics"',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

