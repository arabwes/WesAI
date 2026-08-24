function escapeHtml(value) {
  return String(value || '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character]);
}

async function sendNotification(message, env) {
  const notificationId = message.body?.notificationId;
  if (!notificationId) {
    message.ack();
    return;
  }
  const notification = await env.TEAM_DB.prepare(`SELECT n.*, u.email, u.name
    FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.id = ?`).bind(notificationId).first();
  if (!notification || notification.email_status === 'sent' || notification.email_status === 'skipped') {
    message.ack();
    return;
  }
  if (!notification.email) {
    await env.TEAM_DB.prepare("UPDATE notifications SET email_status = 'skipped', email_last_error = 'User has no email' WHERE id = ?")
      .bind(notificationId).run();
    message.ack();
    return;
  }
  if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not configured');

  const link = notification.link ? new URL(notification.link, env.PORTAL_ORIGIN).toString() : env.PORTAL_ORIGIN + '/team/schedule.html';
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'User-Agent': 'ShibamCoffeeTeam/1.0',
      'Idempotency-Key': notification.idempotency_key
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [notification.email],
      subject: notification.title,
      text: `${notification.message}\n\nOpen the team portal: ${link}`,
      html: `<p>Hi ${escapeHtml(notification.name)},</p><p>${escapeHtml(notification.message)}</p><p><a href="${escapeHtml(link)}">Open the team portal</a></p>`
    })
  });
  const responseBody = await response.text();
  if (!response.ok) throw new Error(`Resend ${response.status}: ${responseBody.slice(0, 300)}`);
  await env.TEAM_DB.prepare(`UPDATE notifications SET email_status = 'sent', email_attempts = email_attempts + 1,
    email_last_error = NULL, sent_at = ? WHERE id = ?`).bind(new Date().toISOString(), notificationId).run();
  message.ack();
}

export default {
  async queue(batch, env) {
    for (const message of batch.messages) {
      try {
        await sendNotification(message, env);
      } catch (error) {
        const notificationId = message.body?.notificationId;
        if (notificationId) {
          await env.TEAM_DB.prepare(`UPDATE notifications SET email_status = 'failed', email_attempts = email_attempts + 1,
            email_last_error = ? WHERE id = ?`).bind(String(error).slice(0, 500), notificationId).run();
        }
        message.retry({ delaySeconds: 60 });
      }
    }
  },

  async scheduled(controller, env) {
    const now = new Date().toISOString();
    await env.TEAM_DB.batch([
      env.TEAM_DB.prepare('DELETE FROM sessions WHERE expires_at < ? OR revoked_at IS NOT NULL').bind(now),
      env.TEAM_DB.prepare('DELETE FROM login_attempts WHERE expires_at < ?').bind(now)
    ]);
  }
};
