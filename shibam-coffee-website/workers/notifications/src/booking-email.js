// Builds the emails sent to people who book a meeting. Pure functions with no
// imports so the notifications worker and the unit tests can both use them.

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character]);
}

export function addressLine(location) {
  if (!location) return '';
  return [location.name, location.addressLine1, location.addressLine2,
    [location.city, location.state].filter(Boolean).join(', ') + (location.postalCode ? ` ${location.postalCode}` : '')]
    .map((part) => String(part || '').trim()).filter(Boolean).join(', ');
}

export function formatWhen(startIso, timezone) {
  const zone = timezone || 'America/New_York';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: zone, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
  }).format(new Date(startIso));
}

const icsEscape = (value) => String(value ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsStamp = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

// RFC 5545 content lines are folded at 75 octets with CRLF + space.
function fold(line) {
  const encoder = new TextEncoder();
  const parts = [];
  let current = '';
  for (const character of line) {
    if (encoder.encode(current + character).length > (parts.length ? 74 : 75)) {
      parts.push(current);
      current = character;
    } else current += character;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

export function buildIcs({ bookingId, title, startIso, endIso, location, description, cancelled = false, now = new Date() }) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Shibam Coffee Atlanta//Booking//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${cancelled ? 'CANCEL' : 'PUBLISH'}`,
    'BEGIN:VEVENT',
    `UID:${bookingId}@shibamatlanta.com`,
    `DTSTAMP:${icsStamp(now.toISOString())}`,
    `DTSTART:${icsStamp(startIso)}`,
    `DTEND:${icsStamp(endIso)}`,
    `SUMMARY:${icsEscape(title)}`,
    `LOCATION:${icsEscape(addressLine(location))}`,
    `DESCRIPTION:${icsEscape(description)}`,
    `STATUS:${cancelled ? 'CANCELLED' : 'CONFIRMED'}`,
    `SEQUENCE:${cancelled ? 1 : 0}`,
    'END:VEVENT',
    'END:VCALENDAR'
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

const TEMPLATES = {
  reminder: { subject: (t, when) => `Reminder: ${t} on ${when}`, lead: 'This is a reminder of your upcoming meeting.', calendar: false, reminder: true },
  confirmed: { subject: (t, when) => `Confirmed: ${t} on ${when}`, lead: 'Your meeting is confirmed.', calendar: true },
  rescheduled: { subject: (t, when) => `Rescheduled: ${t} on ${when}`, lead: 'Your meeting has been moved to a new time.', calendar: true },
  cancelled_by_invitee: { subject: (t) => `You cancelled: ${t}`, lead: 'You cancelled this meeting.', calendar: false, cancelled: true },
  cancelled_by_host: { subject: (t, when) => `Cancelled: ${t} on ${when}`, lead: 'Unfortunately this meeting has been cancelled by the host. Reply to this email if you have any questions.', calendar: false, cancelled: true }
};

export function isBookingTemplate(name) {
  return Object.hasOwn(TEMPLATES, name);
}

// booking: row from the bookings table (snake_case) joined with owner_name / owner_email.
export function buildBookingEmail({ template, booking, manageLink, ownerTimezone, now = new Date() }) {
  const spec = TEMPLATES[template];
  if (!spec) throw new Error(`Unknown booking email template: ${template}`);
  const location = typeof booking.location_snapshot_json === 'string' ? JSON.parse(booking.location_snapshot_json) : booking.location_snapshot_json;
  const when = formatWhen(booking.start_utc, booking.client_timezone || ownerTimezone);
  const where = addressLine(location);
  const notes = location?.notes ? String(location.notes) : '';
  const host = String(booking.owner_name || '').split(' ')[0] || 'our team';
  const greeting = `Hi ${String(booking.client_name || 'there').split(' ')[0]},`;

  const textLines = [greeting, '', spec.lead, '', `What: ${booking.title}`, `When: ${when}`, `With: ${host}`];
  if (!spec.cancelled) {
    textLines.push(`Where: ${where}`);
    if (notes) textLines.push(`Notes: ${notes}`);
    if (manageLink) textLines.push('', `Need to change plans? Reschedule or cancel here:`, manageLink);
    else if (spec.reminder) textLines.push('', 'Need to change plans? Use the link in your confirmation email, or reply to this email.');
  }
  textLines.push('', 'Shibam Coffee Atlanta');

  const rows = [['What', booking.title], ['When', when], ['With', host]];
  if (!spec.cancelled) {
    rows.push(['Where', where]);
    if (notes) rows.push(['Notes', notes]);
  }
  const html = `<p>${escapeHtml(greeting)}</p><p>${escapeHtml(spec.lead)}</p>` +
    `<table cellpadding="4" style="border-collapse:collapse">${rows.map(([k, v]) =>
      `<tr><td><strong>${escapeHtml(k)}</strong></td><td>${escapeHtml(v)}</td></tr>`).join('')}</table>` +
    (!spec.cancelled && manageLink ? `<p>Need to change plans? <a href="${escapeHtml(manageLink)}">Reschedule or cancel</a>.</p>` : '') +
    (spec.reminder ? '<p>Need to change plans? Use the link in your confirmation email, or reply to this email.</p>' : '') +
    '<p>Shibam Coffee Atlanta</p>';

  const email = { subject: spec.subject(booking.title, when), text: textLines.join('\n'), html };
  if (spec.calendar || spec.cancelled) {
    email.ics = buildIcs({
      bookingId: booking.id, title: booking.title, startIso: booking.start_utc, endIso: booking.end_utc, location,
      description: manageLink && !spec.cancelled ? `Change or cancel: ${manageLink}` : '', cancelled: !!spec.cancelled, now
    });
  }
  return email;
}
