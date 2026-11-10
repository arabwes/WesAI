// Retention rule for invitee data, shared by the API and the hourly cleanup
// job in workers/notifications so there is exactly one definition.
export const RETENTION_MONTHS = 12;

export function retentionCutoffIso(nowMs) {
  const cutoff = new Date(nowMs);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - RETENTION_MONTHS);
  return cutoff.toISOString();
}

// Blanks the invitee's personal data once the meeting ended 12+ months ago. The
// meeting row and its time stay, so history and counts survive.
export function anonymizeExpiredBookingsStatement(db, nowMs) {
  return db.prepare(`UPDATE bookings SET client_name = NULL, client_email = NULL, client_phone = NULL,
      client_timezone = NULL, answers_json = '{}', cancel_reason = NULL, anonymized_at = ?
    WHERE anonymized_at IS NULL AND end_utc < ?`).bind(new Date(nowMs).toISOString(), retentionCutoffIso(nowMs));
}
