// The email a catering customer receives when the team writes to them. It deliberately does
// NOT contain the message: it only says there is one and links to the customer's private
// page, so the whole conversation stays in the portal. Pure functions, no imports.

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character]);
}

export function buildCateringMessageEmail({ name, eventType, eventDate, link }) {
  const first = String(name || '').trim().split(/\s+/)[0] || 'there';
  const about = `your ${String(eventType || 'catering').toLowerCase()} request${eventDate ? ` for ${eventDate}` : ''}`;
  const subject = 'A message from Shibam Coffee about your catering request';
  const text = [
    `Hi ${first},`,
    '',
    `Our team sent you a message about ${about}.`,
    '',
    'Read it and reply here. This private link is just for you:',
    link,
    '',
    'Please reply on that page rather than by email, so everything stays in one place.',
    '',
    'Shibam Coffee Atlanta'
  ].join('\n');
  const html = `<p>Hi ${escapeHtml(first)},</p>` +
    `<p>Our team sent you a message about ${escapeHtml(about)}.</p>` +
    `<p><a href="${escapeHtml(link)}">Read the message and reply</a></p>` +
    '<p>This private link is just for you. Please reply on that page rather than by email, so everything stays in one place.</p>' +
    '<p>Shibam Coffee Atlanta</p>';
  return { subject, text, html };
}
