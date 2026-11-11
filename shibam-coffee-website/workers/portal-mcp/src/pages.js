// Sign-in, consent and "connected apps" pages for the Portal MCP connector.
//
// Connecting an AI app: the app sends the person to /portal-mcp/authorize. They sign in with their
// portal username and password (checked by the portal's own code and attempt limit, without
// creating a portal session), see exactly what the app will be able to read, and click Allow.
// Each attempt is a one-time record that expires after 10 minutes.
import { AuthorizationError } from '@cloudflare/workers-oauth-provider';
import { audit, getSession, hasRole, verifyCredentials } from '../../../functions/_lib/auth.js';
import { ApiError, publicUser } from '../../../functions/_lib/http.js';
import { MIN_ROLE } from './tools.js';

export const SCOPE = 'portal:read';
const CONSENT_TTL_SECONDS = 600;
const CONSENT_PREFIX = 'portal-consent:';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const STYLE = `body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#faf6f0;color:#1a0f00;margin:0;line-height:1.5}
main{max-width:460px;margin:8vh auto;padding:0 20px}h1{font-size:1.4rem;margin:.2em 0 .6em}.eyebrow{color:#6b4c2a;font-size:.8rem;text-transform:uppercase;letter-spacing:.06em;margin:0}
.card{background:#fff;border:1px solid #e8dcc8;border-radius:12px;padding:20px}label{display:block;font-weight:600;margin:12px 0 4px}
input[type=text],input[type=password]{width:100%;box-sizing:border-box;padding:10px;border:1px solid #e8dcc8;border-radius:8px;font:inherit}
button{font:inherit;font-weight:600;padding:10px 18px;border-radius:8px;border:1px solid #1a0f00;background:#1a0f00;color:#faf6f0;cursor:pointer;margin:14px 8px 0 0}
button.secondary{background:#fff;color:#1a0f00}.error{color:#b3261e;font-weight:600}ul{padding-left:20px}li{margin:4px 0}.fine{font-size:.85rem;color:#6b4c2a}
table{width:100%;border-collapse:collapse}td{padding:8px 4px;border-top:1px solid #e8dcc8;vertical-align:top}td button{margin:0}`;

// formActionOrigin: the AI app's redirect origin. Browsers apply the page's form-action rule to the
// redirect that follows "Allow", so it must be listed or the redirect back to the app is blocked.
function page(title, body, { status = 200, formActionOrigin = '' } = {}) {
  const csp = [
    "default-src 'none'", "style-src 'unsafe-inline'", "base-uri 'none'", "frame-ancestors 'none'",
    `form-action 'self'${formActionOrigin ? ` ${formActionOrigin}` : ''}`
  ].join('; ');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': csp, 'Cache-Control': 'no-store' } });
}

function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function redirectOrigin(oauthRequest) {
  try {
    const url = new URL(oauthRequest.redirectUri);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : '';
  } catch {
    return '';
  }
}

// Form posts must come from this site. A missing Origin (some privacy settings) is accepted only
// for a same-origin navigation, mirroring the Toast connector.
function sameOrigin(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return request.headers.get('Sec-Fetch-Site') !== 'cross-site';
  if (origin === 'null') return request.headers.get('Sec-Fetch-Site') === 'same-origin';
  return origin === new URL(env.PUBLIC_ORIGIN).origin;
}

async function saveConsent(env, id, record) {
  await env.OAUTH_KV.put(CONSENT_PREFIX + id, JSON.stringify(record), { expirationTtl: CONSENT_TTL_SECONDS });
}

async function loadConsent(env, id) {
  if (!/^[0-9a-f]{48}$/.test(String(id || ''))) return null;
  const raw = await env.OAUTH_KV.get(CONSENT_PREFIX + id);
  if (!raw) return null;
  const record = JSON.parse(raw);
  return Date.now() - record.createdAt > CONSENT_TTL_SECONDS * 1000 ? null : record;
}

function signInPage(env, resume, clientName, error = '') {
  return page('Connect to the Shibam Coffee portal', `
    <p class="eyebrow">Shibam Coffee team portal</p>
    <h1>Sign in to connect ${escapeHtml(clientName)}</h1>
    <div class="card">
      ${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
      <form method="post" action="${env.BASE_PATH}/authorize">
        <input type="hidden" name="resume" value="${escapeHtml(resume)}">
        <input type="hidden" name="action" value="signin">
        <label for="username">Portal username</label><input id="username" name="username" type="text" autocomplete="username" required>
        <label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
        <button type="submit">Sign in</button>
      </form>
    </div>
    <p class="fine">Use the same username and password as the team portal. Only Leads and Management can connect AI apps.</p>`);
}

function consentPage(env, resume, record, user) {
  return page('Allow access to the portal', `
    <p class="eyebrow">Shibam Coffee team portal</p>
    <h1>Let ${escapeHtml(record.clientName)} read the portal as ${escapeHtml(user.name)}?</h1>
    <div class="card">
      <p><strong>It will be able to read:</strong></p>
      <ul>
        <li>the latest inventory count and items below their order-below level</li>
        <li>the weekly schedule and time off (not the reasons)</li>
        <li>the team calendar (other people's meetings show only as "Booked")</li>
        <li>catering requests and conversations, without customer names, emails or phone numbers</li>
        <li>your meeting types and booking-link status</li>
      </ul>
      <p><strong>It will not be able to</strong> change anything, see customer or candidate contact details, or see private booking and conversation links.</p>
      <form method="post" action="${env.BASE_PATH}/authorize">
        <input type="hidden" name="resume" value="${escapeHtml(resume)}">
        <input type="hidden" name="csrf" value="${escapeHtml(record.csrf)}">
        <button type="submit" name="action" value="allow">Allow</button>
        <button type="submit" name="action" value="deny" class="secondary">Deny</button>
      </form>
    </div>
    <p class="fine">Signed in as ${escapeHtml(user.name)} (${escapeHtml(user.role)}). Anything the app reads is sent to its provider. You can disconnect it any time from Profile, then "AI connections", in the portal.</p>`,
  { formActionOrigin: redirectOrigin(record.oauthRequest) });
}

function redirectWithError(env, oauthRequest, code) {
  const url = new URL(oauthRequest.redirectUri);
  url.searchParams.set('error', code);
  if (oauthRequest.state) url.searchParams.set('state', oauthRequest.state);
  url.searchParams.set('iss', `${env.PUBLIC_ORIGIN}${env.BASE_PATH}`);
  return Response.redirect(url.toString(), 302);
}

async function activeLead(env, userId) {
  const row = await env.TEAM_DB.prepare('SELECT * FROM users WHERE id = ? AND active = 1').bind(String(userId || '')).first();
  const user = row ? publicUser(row) : null;
  return user && hasRole(user, MIN_ROLE) ? user : null;
}

export async function handleAuthorize(env, request) {
  if (request.method === 'GET') {
    let oauthRequest;
    try {
      oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    } catch (error) {
      if (error instanceof AuthorizationError && error.redirectUri) {
        const url = new URL(error.redirectUri);
        url.searchParams.set('error', error.code);
        if (error.state) url.searchParams.set('state', error.state);
        return Response.redirect(url.toString(), 302);
      }
      return page('Connection failed', '<h1>This connection request is not valid</h1><p>Start again from your AI app.</p>', { status: 400 });
    }
    const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
    const clientName = String(client?.clientName || 'this AI app').slice(0, 100);
    const resume = randomId();
    await saveConsent(env, resume, { oauthRequest, clientName, createdAt: Date.now() });
    return signInPage(env, resume, clientName);
  }
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, POST' } });
  if (!sameOrigin(request, env)) return page('Not allowed', '<h1>That request came from another site</h1>', { status: 403 });

  const form = await request.formData();
  const resume = String(form.get('resume') || '');
  const record = await loadConsent(env, resume);
  if (!record) return page('Sign-in expired', '<h1>This sign-in has expired</h1><p>It is valid for 10 minutes. Start again from your AI app.</p>', { status: 400 });
  const action = String(form.get('action') || '');

  if (action === 'signin') {
    let row;
    try {
      row = await verifyCredentials(request, { username: form.get('username'), password: form.get('password') }, env);
    } catch (error) {
      const message = error instanceof ApiError && error.code === 'too_many_attempts'
        ? 'Too many attempts. Wait 15 minutes and try again.'
        : "That username and password didn't match.";
      return signInPage(env, resume, record.clientName, message);
    }
    const user = publicUser(row);
    if (!hasRole(user, MIN_ROLE)) {
      return page('Not available for your role', `<h1>Only Leads and Management can connect AI apps</h1><p>You are signed in as ${escapeHtml(user.name)} (${escapeHtml(user.role)}). Ask a manager if you need this.</p>`, { status: 403 });
    }
    const next = { ...record, userId: user.id, csrf: randomId() };
    await saveConsent(env, resume, next);
    return consentPage(env, resume, next, user);
  }

  if (action === 'allow' || action === 'deny') {
    if (!record.userId || !record.csrf || String(form.get('csrf') || '') !== record.csrf) {
      return page('Sign in again', '<h1>Please sign in again</h1><p>Start again from your AI app.</p>', { status: 400 });
    }
    await env.OAUTH_KV.delete(CONSENT_PREFIX + resume); // one use only
    if (action === 'deny') return redirectWithError(env, record.oauthRequest, 'access_denied');
    const user = await activeLead(env, record.userId);
    if (!user) return page('Not available', '<h1>This account can no longer connect AI apps</h1>', { status: 403 });
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: record.oauthRequest,
      userId: user.id,
      metadata: { clientName: record.clientName, role: user.role, connectedAt: new Date().toISOString() },
      scope: [SCOPE],
      props: { userId: user.id, clientName: record.clientName },
      revokeExistingGrants: false
    });
    await audit(env.TEAM_DB, user.id, 'mcp.connect', 'mcp_client', record.oauthRequest.clientId, { client: record.clientName });
    const redirect = new URL(redirectTo);
    redirect.searchParams.set('iss', `${env.PUBLIC_ORIGIN}${env.BASE_PATH}`);
    return new Response(null, { status: 302, headers: { Location: redirect.toString(), 'Cache-Control': 'no-store' } });
  }
  return page('Not understood', '<h1>Start again from your AI app</h1>', { status: 400 });
}

async function allGrants(env, userId) {
  const items = [];
  let cursor;
  do {
    const result = await env.OAUTH_PROVIDER.listUserGrants(userId, cursor ? { limit: 100, cursor } : { limit: 100 });
    items.push(...result.items);
    cursor = result.cursor;
  } while (cursor);
  return items;
}

// "AI connections": lists the apps connected with your account and lets you disconnect them. Uses
// your normal portal session; open it from the portal (Profile, then "AI connections").
export async function handleConnections(env, request) {
  const user = await getSession(request, {}, env);
  if (!user) {
    return page('AI connections', `<p class="eyebrow">Shibam Coffee team portal</p><h1>Sign in to the portal first</h1>
      <p>Open the <a href="/team/">team portal</a>, sign in, then go to Profile and choose "AI connections".</p>`, { status: 401 });
  }
  if (request.method === 'POST') {
    if (!sameOrigin(request, env) || request.headers.get('Sec-Fetch-Site') === 'cross-site') {
      return page('Not allowed', '<h1>That request came from another site</h1>', { status: 403 });
    }
    const form = await request.formData();
    const grantId = String(form.get('grant') || '');
    const mine = (await allGrants(env, user.id)).find((grant) => grant.id === grantId);
    if (mine) {
      await env.OAUTH_PROVIDER.revokeGrant(mine.id, user.id);
      await audit(env.TEAM_DB, user.id, 'mcp.disconnect', 'mcp_client', mine.clientId, { client: mine.metadata?.clientName || '' });
    }
    return new Response(null, { status: 303, headers: { Location: `${env.BASE_PATH}/connections`, 'Cache-Control': 'no-store' } });
  }
  const grants = await allGrants(env, user.id);
  const rows = grants.map((grant) => `<tr><td><strong>${escapeHtml(grant.metadata?.clientName || 'AI app')}</strong><br><span class="fine">Connected ${escapeHtml(new Date(Number(grant.createdAt || 0) > 1e12 ? Number(grant.createdAt) : Number(grant.createdAt || 0) * 1000).toLocaleDateString('en-US'))} · read-only</span></td>
    <td><form method="post" action="${env.BASE_PATH}/connections"><input type="hidden" name="grant" value="${escapeHtml(grant.id)}"><button type="submit" class="secondary">Disconnect</button></form></td></tr>`).join('');
  return page('AI connections', `<p class="eyebrow">Shibam Coffee team portal</p><h1>AI connections</h1>
    <div class="card">${grants.length ? `<table>${rows}</table>` : '<p>No AI apps are connected to your account.</p>'}</div>
    <p class="fine">Connected apps can read the portal as ${escapeHtml(user.name)} and nothing more. Disconnecting stops access immediately.${hasRole(user, MIN_ROLE) ? '' : ' Your role cannot connect AI apps.'}</p>
    <p><a href="/team/profile">Back to the portal</a></p>`);
}
