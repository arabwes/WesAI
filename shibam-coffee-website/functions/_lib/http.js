const encoder = new TextEncoder();

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers
    }
  });
}

export async function readJson(request) {
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > 1_000_000) throw new ApiError('payload_too_large', 413);
  try {
    const value = await request.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Expected an object');
    }
    return value;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('invalid_json', 400);
  }
}

export class ApiError extends Error {
  constructor(code, status = 400, details) {
    super(code);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function nowIso() {
  return new Date().toISOString();
}

export function newId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function normalizeDate(value, field = 'date') {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new ApiError(`invalid_${field}`, 400);
  const parsed = new Date(`${text}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw new ApiError(`invalid_${field}`, 400);
  }
  return text;
}

export function normalizeTime(value, field = 'time') {
  const text = String(value || '');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(text)) throw new ApiError(`invalid_${field}`, 400);
  return text;
}

export function weekStartFor(dateValue) {
  const date = new Date(`${normalizeDate(dateValue)}T12:00:00Z`);
  const day = date.getUTCDay();
  const distance = day === 0 ? -6 : 1 - day;
  date.setUTCDate(date.getUTCDate() + distance);
  return date.toISOString().slice(0, 10);
}

export function addDays(dateValue, days) {
  const date = new Date(`${normalizeDate(dateValue)}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function minutesBetween(start, end, breakMinutes = 0) {
  const [startHour, startMinute] = normalizeTime(start, 'start_time').split(':').map(Number);
  const [endHour, endMinute] = normalizeTime(end, 'end_time').split(':').map(Number);
  const duration = (endHour * 60 + endMinute) - (startHour * 60 + startMinute) - Number(breakMinutes || 0);
  if (duration <= 0 || duration > 24 * 60) throw new ApiError('invalid_shift_duration', 400);
  return duration;
}

export function asBoolean(value) {
  return value === true || value === 1 || value === '1';
}

export function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function getCookie(request, name) {
  const cookie = request.headers.get('Cookie') || '';
  const part = cookie.split(';').map((item) => item.trim()).find((item) => item.startsWith(`${name}=`));
  return part ? decodeURIComponent(part.slice(name.length + 1)) : '';
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(String(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function safeJsonParse(value, fallback = {}) {
  try { return JSON.parse(value); } catch { return fallback; }
}

export function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    email: row.email || '',
    role: row.role,
    maxWeeklyMinutes: Number(row.max_weekly_minutes || 0),
    active: asBoolean(row.active),
    createdAt: row.created_at
  };
}
