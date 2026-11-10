// Pure calendar rules: timezone maths, availability expansion, slot
// generation and booking visibility. No database access, so every rule here
// is unit-testable and shared by the authenticated and public handlers.
//
// Instants are epoch milliseconds internally and UTC ISO strings at the edges.
// Intervals are half-open [start, end).

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export function isValidTimezone(name) {
  if (typeof name !== 'string' || !name) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

function zoneParts(ms, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(new Date(ms));
  const get = (type) => Number(parts.find((part) => part.type === type).value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

// Offset of `timezone` from UTC at an instant, in milliseconds.
function zoneOffset(ms, timezone) {
  const p = zoneParts(ms, timezone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

export function addDaysToDate(dateValue, days) {
  const [year, month, day] = dateValue.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export function weekdayOf(dateValue) {
  const [year, month, day] = dateValue.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay();
}

// Wall-clock date + minutes-after-midnight in a timezone -> UTC ms.
// `minutes` may be 1440 (end of day). Returns null when that wall time does not
// exist (the spring-forward gap). When a wall time happens twice (fall back)
// the earlier occurrence is used.
export function wallToUtc(dateValue, minutes, timezone) {
  let date = dateValue;
  let mins = minutes;
  if (mins >= 1440) { date = addDaysToDate(date, 1); mins -= 1440; }
  const [year, month, day] = date.split('-').map(Number);
  const hour = Math.floor(mins / 60);
  const minute = mins % 60;
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  const candidates = new Set([naive - zoneOffset(naive - DAY / 2, timezone), naive - zoneOffset(naive + DAY / 2, timezone)]);
  const valid = [...candidates].filter((ms) => {
    const p = zoneParts(ms, timezone);
    return p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute;
  }).sort((a, b) => a - b);
  return valid.length ? valid[0] : null;
}

function timeToMinutes(value) {
  const [hour, minute] = String(value).split(':').map(Number);
  return hour * 60 + minute;
}

export function mergeIntervals(intervals) {
  const sorted = intervals.filter((i) => i.end > i.start).map((i) => ({ ...i })).sort((a, b) => a.start - b.start);
  const merged = [];
  for (const item of sorted) {
    const last = merged[merged.length - 1];
    if (last && item.start <= last.end) last.end = Math.max(last.end, item.end);
    else merged.push(item);
  }
  return merged;
}

export function subtractIntervals(free, busy) {
  const blockers = mergeIntervals(busy);
  const result = [];
  for (const window of mergeIntervals(free)) {
    let cursor = window.start;
    for (const block of blockers) {
      if (block.end <= cursor) continue;
      if (block.start >= window.end) break;
      if (block.start > cursor) result.push({ start: cursor, end: block.start });
      cursor = Math.max(cursor, block.end);
      if (cursor >= window.end) break;
    }
    if (cursor < window.end) result.push({ start: cursor, end: window.end });
  }
  return result;
}

// Turn weekly rules and per-date overrides into UTC intervals for the dates
// fromDate..toDate inclusive (YYYY-MM-DD in the owner's timezone).
//   rules:     [{ weekday, start_time, end_time }]
//   overrides: [{ override_date, start_time|null, end_time|null }]
// A date that has override rows ignores the weekly rules entirely.
export function expandAvailability({ rules, overrides, fromDate, toDate, timezone }) {
  const overridesByDate = new Map();
  for (const row of overrides) {
    if (!overridesByDate.has(row.override_date)) overridesByDate.set(row.override_date, []);
    overridesByDate.get(row.override_date).push(row);
  }
  const intervals = [];
  for (let date = fromDate; date <= toDate; date = addDaysToDate(date, 1)) {
    const dayRows = overridesByDate.has(date)
      ? overridesByDate.get(date).filter((row) => row.start_time && row.end_time)
      : rules.filter((rule) => rule.weekday === weekdayOf(date));
    for (const row of dayRows) {
      const startMinutes = timeToMinutes(row.start_time);
      const endMinutes = row.end_time === '00:00' ? 1440 : timeToMinutes(row.end_time);
      const start = wallToUtc(date, startMinutes, timezone);
      const end = wallToUtc(date, endMinutes, timezone);
      if (start !== null && end !== null && end > start) intervals.push({ start, end });
    }
  }
  return mergeIntervals(intervals);
}

// Approved time off as busy intervals in the owner's timezone. Rows without
// times block the whole day. Rows with times apply that daily window to every
// date in the range.
export function timeOffToIntervals(rows, timezone) {
  const intervals = [];
  for (const row of rows) {
    for (let date = row.start_date; date <= row.end_date; date = addDaysToDate(date, 1)) {
      const hasTimes = row.start_time && row.end_time;
      const startMinutes = hasTimes ? timeToMinutes(row.start_time) : 0;
      const endMinutes = hasTimes ? (row.end_time === '00:00' ? 1440 : timeToMinutes(row.end_time)) : 1440;
      const start = wallToUtc(date, startMinutes, timezone);
      const end = wallToUtc(date, endMinutes, timezone);
      if (start !== null && end !== null && end > start) intervals.push({ start, end });
    }
  }
  return intervals;
}

// Bookable start times.
//   windows: UTC intervals the owner is available
//   busy:    UTC intervals already taken (bookings incl. their buffers, team
//            events that block, approved time off)
// A slot is returned when the meeting fits inside a free window and the
// meeting plus its buffers does not overlap anything busy.
export function generateSlots({
  windows, busy, durationMinutes, bufferBeforeMinutes = 0, bufferAfterMinutes = 0,
  intervalMinutes = 30, now, minNoticeMinutes = 0, maxDaysAhead = 60
}) {
  const earliest = now + minNoticeMinutes * MINUTE;
  const latest = now + maxDaysAhead * DAY;
  const duration = durationMinutes * MINUTE;
  const before = bufferBeforeMinutes * MINUTE;
  const after = bufferAfterMinutes * MINUTE;
  const step = intervalMinutes * MINUTE;
  const blockers = mergeIntervals(busy);
  const slots = [];
  for (const window of mergeIntervals(windows)) {
    for (let start = window.start; start + duration <= window.end; start += step) {
      if (start < earliest || start > latest) continue;
      const blockStart = start - before;
      const blockEnd = start + duration + after;
      if (blockers.some((block) => block.start < blockEnd && block.end > blockStart)) continue;
      slots.push(start);
    }
  }
  return slots;
}

// The meeting plus buffers for a chosen start; stored on the booking.
export function bookingBlock(startMs, { durationMinutes, bufferBeforeMinutes = 0, bufferAfterMinutes = 0 }) {
  const end = startMs + durationMinutes * MINUTE;
  return {
    start: startMs, end,
    blocksStart: startMs - bufferBeforeMinutes * MINUTE,
    blocksEnd: end + bufferAfterMinutes * MINUTE
  };
}

export function toIso(ms) {
  return new Date(ms).toISOString();
}

export function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

// Booking visibility. Only the person who owns the booking's link and
// Management may see client details. Everyone else gets time and a generic
// label, with no id, owner, title, client or location.
export function canViewBooking(actor, booking) {
  return !!actor && (actor.role === 'management' || actor.id === booking.owner_id);
}

export function redactBooking(actor, booking) {
  if (canViewBooking(actor, booking)) {
    return {
      id: booking.id,
      eventTypeId: booking.event_type_id,
      ownerId: booking.owner_id,
      title: booking.title,
      startUtc: booking.start_utc,
      endUtc: booking.end_utc,
      status: booking.status,
      location: safeParse(booking.location_snapshot_json, null),
      clientName: booking.client_name,
      clientEmail: booking.client_email,
      clientPhone: booking.client_phone,
      clientTimezone: booking.client_timezone,
      answers: safeParse(booking.answers_json, {}),
      anonymized: !!booking.anonymized_at,
      redacted: false
    };
  }
  return { startUtc: booking.start_utc, endUtc: booking.end_utc, title: 'Booked', redacted: true };
}

function safeParse(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}
