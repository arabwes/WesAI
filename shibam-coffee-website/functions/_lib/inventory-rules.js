// Pure validation rules for the weekly inventory count. No database access,
// so they are unit-tested directly (tests/inventory-rules.test.js) and the
// browser mirrors them in team/js/inventory-count.js for instant feedback.
// The server is the source of truth: every rule here is re-applied on save.

export const OUTLIER_RATIO = 3;
export const MAX_QUANTITY = 100000;
export const EDIT_REASON_AFTER_MS = 60 * 60 * 1000;

// Whole numbers plus a quarter, half, or three-quarter opened container.
export function isQuarterQuantity(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (value < 0 || value > MAX_QUANTITY) return false;
  return Number.isInteger(value * 4);
}

// A blank field is null; zero only counts once someone entered it.
export function parseQuantity(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return isQuarterQuantity(number) ? number : NaN;
}

export function isItemComplete(entry) {
  return !!entry && entry.qtyKitchen !== null && entry.qtyKitchen !== undefined
    && entry.qtyStorage !== null && entry.qtyStorage !== undefined;
}

// Compares an item's new total (Kitchen + Storage — staff move stock
// between the two) against the last submitted count and its maximum.
// Returns the reasons it needs confirmation; an empty array means it's fine.
export function outlierReasons(newTotal, previousTotal, maxQty) {
  const reasons = [];
  if (maxQty !== null && maxQty !== undefined && Number(maxQty) > 0 && newTotal > Number(maxQty)) {
    reasons.push('above_max');
  }
  if (previousTotal !== null && previousTotal !== undefined && previousTotal > 0) {
    if (newTotal > previousTotal * OUTLIER_RATIO) reasons.push('over_3x');
    if (newTotal < previousTotal / OUTLIER_RATIO) reasons.push('under_third');
  }
  return reasons;
}

export function storeDate(value, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(value));
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function previousDate(isoDate) {
  const date = new Date(`${isoDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

// A count may be dated today or yesterday (store time). Yesterday covers a
// count started late at night; anything other than today needs a reason.
export function checkCountDate(countDate, dateReason, now, timezone) {
  const today = storeDate(now, timezone);
  const yesterday = previousDate(today);
  if (countDate === today) return { ok: true, today, yesterday };
  if (countDate !== yesterday) return { ok: false, error: 'count_date_not_allowed', today, yesterday };
  if (String(dateReason || '').trim().length < 3) return { ok: false, error: 'date_reason_required', today, yesterday };
  return { ok: true, today, yesterday };
}

export function editNeedsReason(submittedAt, now) {
  return new Date(now).getTime() - new Date(submittedAt).getTime() > EDIT_REASON_AFTER_MS;
}

// Field-by-field differences between two saved rows, for the edit log.
export function diffFields(oldValues, newValues) {
  const keys = new Set([...Object.keys(oldValues || {}), ...Object.keys(newValues || {})]);
  const changes = [];
  keys.forEach((key) => {
    const before = oldValues?.[key];
    const after = newValues?.[key];
    const beforeText = before === undefined || before === null ? '' : String(before);
    const afterText = after === undefined || after === null ? '' : String(after);
    if (beforeText !== afterText) changes.push({ field: key, oldValue: beforeText, newValue: afterText });
  });
  return changes;
}
