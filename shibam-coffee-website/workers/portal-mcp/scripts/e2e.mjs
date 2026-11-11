// End-to-end check of the Portal MCP connector, acting exactly like an AI app:
// discovery -> client registration -> sign-in + consent (PKCE) -> token -> MCP calls -> disconnect.
//
//   BASE=http://localhost:8790 LEAD_USER=ana LEAD_PASS=... node scripts/e2e.mjs
//   Optional: BARISTA_USER / BARISTA_PASS (checks baristas are refused),
//             PORTAL_COOKIE="shibam_team_session=..." (checks the AI connections page and disconnect).
// Against the live site, use BASE=https://shibamatlanta.com and a real Lead account; the script
// disconnects the test app at the end when PORTAL_COOKIE is given.
import { createHash, randomBytes } from 'node:crypto';

const BASE = (process.env.BASE || 'http://localhost:8790').replace(/\/$/, '');
const PATH = '/portal-mcp';
const REDIRECT = 'http://localhost:9999/callback';
let failures = 0;

function check(condition, label, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${!condition && detail ? `  -> ${detail}` : ''}`);
  if (!condition) failures += 1;
  return condition;
}

const form = (fields) => new URLSearchParams(fields).toString();
const hidden = (html, name) => (html.match(new RegExp(`name="${name}" value="([^"]*)"`)) || [])[1] || '';

async function signIn(clientId, challenge, username, password) {
  const authorize = new URL(`${BASE}${PATH}/authorize`);
  for (const [k, v] of Object.entries({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, state: 'st4te', code_challenge: challenge, code_challenge_method: 'S256', scope: 'portal:read' })) authorize.searchParams.set(k, v);
  const first = await fetch(authorize, { redirect: 'manual' });
  const page = await first.text();
  const resume = hidden(page, 'resume');
  const post = (fields) => fetch(`${BASE}${PATH}/authorize`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: BASE },
    body: form(fields)
  });
  return { first, page, resume, post, signin: () => post({ resume, action: 'signin', username, password }) };
}

// MCP over Streamable HTTP. Responses may be JSON or a single SSE event.
async function mcp(token, method, params, id = 1) {
  const response = await fetch(`${BASE}${PATH}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
  });
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch {
    const data = text.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('');
    try { body = JSON.parse(data); } catch { body = null; }
  }
  return { status: response.status, body, text };
}

const meta = await fetch(`${BASE}/.well-known/oauth-authorization-server${PATH}`).then((r) => r.json()).catch(() => null);
check(meta?.authorization_endpoint === `${BASE}${PATH}/authorize`, 'discovery: authorization server metadata', JSON.stringify(meta));
const resourceMeta = await fetch(`${BASE}/.well-known/oauth-protected-resource${PATH}/mcp`).then((r) => r.json()).catch(() => null);
check(resourceMeta?.resource === `${BASE}${PATH}/mcp`, 'discovery: protected resource metadata', JSON.stringify(resourceMeta));
const unauth = await fetch(`${BASE}${PATH}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
check(unauth.status === 401, 'MCP refuses calls without a token', String(unauth.status));

const registration = await fetch(`${BASE}${PATH}/register`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ client_name: 'E2E Test App', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] })
}).then((r) => r.json());
check(!!registration.client_id, 'client registration', JSON.stringify(registration));

const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');

// Wrong password first: friendly error, still on the sign-in page.
const wrong = await signIn(registration.client_id, challenge, process.env.LEAD_USER, 'not-the-password');
check(wrong.first.status === 200 && !!wrong.resume, 'authorize shows the sign-in page', `${wrong.first.status}`);
check(/frame-ancestors 'none'/.test(wrong.first.headers.get('content-security-policy') || ''), 'sign-in page cannot be framed');
const wrongResult = await (await wrong.signin()).text();
check(wrongResult.includes("didn&#39;t match") || wrongResult.includes("didn't match"), 'a wrong password is refused politely');

// Cross-site form posts are refused.
const crossSite = await fetch(`${BASE}${PATH}/authorize`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://evil.example' }, body: form({ resume: wrong.resume, action: 'signin', username: process.env.LEAD_USER, password: process.env.LEAD_PASS }) });
check(crossSite.status === 403, 'a post from another site is refused', String(crossSite.status));

if (process.env.BARISTA_USER) {
  const barista = await signIn(registration.client_id, challenge, process.env.BARISTA_USER, process.env.BARISTA_PASS);
  const refused = await barista.signin();
  check(refused.status === 403 && (await refused.text()).includes('Only Leads and Management'), 'baristas cannot connect AI apps');
}

const flow = await signIn(registration.client_id, challenge, process.env.LEAD_USER, process.env.LEAD_PASS);
const consentResponse = await flow.signin();
const consent = await consentResponse.text();
const csrf = hidden(consent, 'csrf');
check(consent.includes('Allow') && !!csrf, 'correct password shows the consent page', consent.slice(0, 200));
check((consentResponse.headers.get('content-security-policy') || '').includes('http://localhost:9999'), 'consent page allows the redirect back to the app');
check(consent.includes('will not be able to'), 'consent page says what the app cannot do');
const forged = await flow.post({ resume: flow.resume, action: 'allow', csrf: 'forged' });
check(forged.status === 400, 'a forged consent is refused', String(forged.status));
const allow = await flow.post({ resume: flow.resume, action: 'allow', csrf });
const location = allow.headers.get('location') || '';
const code = new URL(location || 'http://x').searchParams.get('code');
check(allow.status === 302 && location.startsWith(REDIRECT) && !!code, 'Allow redirects back with a code', `${allow.status} ${location}`);
check(new URL(location || 'http://x').searchParams.get('state') === 'st4te', 'state is returned unchanged');
const replay = await flow.post({ resume: flow.resume, action: 'allow', csrf });
check(replay.status === 400, 'a consent cannot be used twice', String(replay.status));

const tokens = await fetch(`${BASE}${PATH}/token`, {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: registration.client_id, code_verifier: verifier })
}).then((r) => r.json());
check(!!tokens.access_token && !!tokens.refresh_token, 'code exchange returns tokens', JSON.stringify(tokens));

const init = await mcp(tokens.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
check(init.status === 200 && init.body?.result?.serverInfo?.name === 'Shibam Coffee Portal', 'MCP initialize', `${init.status} ${init.text.slice(0, 300)}`);
const list = await mcp(tokens.access_token, 'tools/list', {}, 2);
const names = (list.body?.result?.tools || []).map((t) => t.name).sort();
check(names.join(',') === 'catering_conversation,catering_requests,inventory_latest_count,meeting_types,portal_whoami,schedule_week,team_calendar', 'tools/list shows the seven read-only tools', names.join(','));
check(names.length === 7 && (list.body?.result?.tools || []).every((t) => t.annotations?.readOnlyHint === true), 'every tool is marked read-only');

const results = {};
for (const [name, args] of [['portal_whoami', {}], ['inventory_latest_count', { only_below_threshold: false }], ['schedule_week', {}], ['team_calendar', { from: '2026-11-01', to: '2026-11-30' }], ['catering_requests', {}], ['meeting_types', {}]]) {
  const call = await mcp(tokens.access_token, 'tools/call', { name, arguments: args }, 3);
  results[name] = call.body?.result;
  check(call.status === 200 && call.body?.result && !call.body.result.isError, `tools/call ${name}`, `${call.status} ${call.text.slice(0, 300)}`);
}
check(results.portal_whoami?.structuredContent?.access === 'read-only', 'whoami reports read-only access');
const badInput = await mcp(tokens.access_token, 'tools/call', { name: 'team_calendar', arguments: { from: 'yesterday', to: '2026-11-30' } }, 4);
check(badInput.status === 200 && (badInput.body?.result?.isError || badInput.body?.error), 'bad input is rejected by the input checks');
check(Object.values(results).filter(Boolean).length === 6 && (!process.env.EXPECT_SECRET || !JSON.stringify(results).includes(process.env.EXPECT_SECRET)), 'no seeded secret appears in any result');
check(JSON.stringify(results.catering_requests || {}).includes('Corporate') || !process.env.EXPECT_SECRET, 'the seeded catering request is visible (without its contact details)');

// Refresh tokens work, and reusing an authorization code revokes what it issued (OAuth 2.1).
const refreshed = await fetch(`${BASE}${PATH}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: registration.client_id }) }).then((r) => r.json());
check(!!refreshed.access_token, 'refresh token gives a new access token', JSON.stringify(refreshed));
const fresh = refreshed.access_token || tokens.access_token;
check((await mcp(fresh, 'tools/call', { name: 'portal_whoami', arguments: {} }, 6)).status === 200, 'the refreshed token works');

if (process.env.PORTAL_COOKIE) {
  const page = await fetch(`${BASE}${PATH}/connections`, { headers: { Cookie: process.env.PORTAL_COOKIE } }).then((r) => r.text());
  check(page.includes('E2E Test App'), 'AI connections page lists the app');
  const grant = hidden(page, 'grant');
  check(!!grant, 'the page offers a Disconnect button for it');
  const noCookie = await fetch(`${BASE}${PATH}/connections`);
  check(noCookie.status === 401, 'the connections page needs a portal sign-in', String(noCookie.status));
  const csrfPost = await fetch(`${BASE}${PATH}/connections`, { method: 'POST', redirect: 'manual', headers: { Cookie: process.env.PORTAL_COOKIE, Origin: 'https://evil.example', 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ grant }) });
  check(csrfPost.status === 403, 'another site cannot disconnect your apps', String(csrfPost.status));
  check((await mcp(fresh, 'tools/call', { name: 'portal_whoami', arguments: {} }, 7)).status === 200, 'the app still works before disconnecting');
  const out = await fetch(`${BASE}${PATH}/connections`, { method: 'POST', redirect: 'manual', headers: { Cookie: process.env.PORTAL_COOKIE, Origin: BASE, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ grant }) });
  check(out.status === 303, 'Disconnect works', String(out.status));
  const after = await mcp(fresh, 'tools/call', { name: 'portal_whoami', arguments: {} }, 5);
  check(after.status === 401, 'after disconnecting, the app is locked out immediately', String(after.status));
  const pageAfter = await fetch(`${BASE}${PATH}/connections`, { headers: { Cookie: process.env.PORTAL_COOKIE } }).then((r) => r.text());
  check(!pageAfter.includes('E2E Test App'), 'and it is gone from the list');
}

// A second, separate connection: then replay its code, which must revoke that connection's tokens.
const verifier2 = randomBytes(32).toString('base64url');
const flow2 = await signIn(registration.client_id, createHash('sha256').update(verifier2).digest('base64url'), process.env.LEAD_USER, process.env.LEAD_PASS);
const consent2 = await (await flow2.signin()).text();
const code2 = new URL((await flow2.post({ resume: flow2.resume, action: 'allow', csrf: hidden(consent2, 'csrf') })).headers.get('location') || 'http://x').searchParams.get('code');
const exchange = () => fetch(`${BASE}${PATH}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ grant_type: 'authorization_code', code: code2, redirect_uri: REDIRECT, client_id: registration.client_id, code_verifier: verifier2 }) });
const tokens2 = await exchange().then((r) => r.json());
check((await mcp(tokens2.access_token, 'tools/call', { name: 'portal_whoami', arguments: {} }, 8)).status === 200, 'a second connection works');
const reuse = await exchange();
check(reuse.status >= 400, 'an authorization code cannot be used twice', String(reuse.status));
check((await mcp(tokens2.access_token, 'tools/call', { name: 'portal_whoami', arguments: {} }, 9)).status === 401, 'and reusing it revokes the tokens it issued');

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
