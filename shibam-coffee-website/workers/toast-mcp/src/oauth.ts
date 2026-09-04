import { AuthorizationError, type AuthRequest, type GrantSummary } from "@cloudflare/workers-oauth-provider";
import { beginAuth0Login, deleteConsentRequest, loadConsentRequest, storeConsentRequest } from "./auth0";
import { availableScopesForMembership, listOrganizations, requireMembership, requireSession, validateSessionCsrfValue } from "./db";
import { CafeError } from "./errors";
import { BASE_MCP_SCOPES, isSupportedOAuthScope } from "./scopes";
import { assertSameOrigin, contentSecurityPolicyForOAuthConsent, htmlResponse } from "./security";
import type { CafeEnvironment } from "./runtime";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

async function resolveRequest(env: CafeEnvironment, request: Request): Promise<{ request: AuthRequest; resumeId: string }> {
  const url = new URL(request.url);
  const resumeId = url.searchParams.get("resume");
  if (resumeId) return { request: await loadConsentRequest(env, resumeId), resumeId };
  const oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  return { request: oauthRequest, resumeId: await storeConsentRequest(env, oauthRequest) };
}

function authorizationFailure(env: CafeEnvironment, error: AuthorizationError): Response {
  if (!error.redirectUri) return htmlResponse("<!doctype html><title>Authorization failed</title><h1>Authorization failed</h1><p>The OAuth request is invalid.</p>", 400);
  const redirect = new URL(error.redirectUri);
  redirect.searchParams.set("error", error.code);
  redirect.searchParams.set("error_description", error.description);
  if (error.state) redirect.searchParams.set("state", error.state);
  redirect.searchParams.set("iss", `${env.PUBLIC_ORIGIN}${env.BASE_PATH}`);
  return Response.redirect(redirect.toString(), 302);
}

function consentRedirect(target: string, registeredRedirectUri: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: target,
      "Content-Security-Policy": contentSecurityPolicyForOAuthConsent(registeredRedirectUri),
    },
  });
}

async function listAllUserGrants(env: CafeEnvironment, userId: string): Promise<GrantSummary[]> {
  const items: GrantSummary[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.OAUTH_PROVIDER.listUserGrants(userId, cursor ? { limit: 1000, cursor } : { limit: 1000 });
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return items;
}

export async function handleAuthorize(env: CafeEnvironment, request: Request): Promise<Response> {
  if (request.method === "GET") {
    let resolved: { request: AuthRequest; resumeId: string };
    try {
      resolved = await resolveRequest(env, request);
    } catch (error) {
      if (error instanceof AuthorizationError) return authorizationFailure(env, error);
      throw error;
    }
    if (!resolved.request.codeChallenge || resolved.request.codeChallengeMethod !== "S256") {
      return authorizationFailure(env, new AuthorizationError("invalid_request", {
        description: "S256 PKCE is required.", redirectUri: resolved.request.redirectUri,
        state: resolved.request.state,
        ...(resolved.request.issuer ? { issuer: resolved.request.issuer } : {}),
      }));
    }
    if (resolved.request.scope.some((scope) => !isSupportedOAuthScope(scope))) {
      return authorizationFailure(env, new AuthorizationError("invalid_scope", {
        description: "An unsupported scope was requested.", redirectUri: resolved.request.redirectUri,
        state: resolved.request.state,
        ...(resolved.request.issuer ? { issuer: resolved.request.issuer } : {}),
      }));
    }
    const session = await requireSession(env, request).catch(() => null);
    if (!session) return beginAuth0Login(env, { kind: "mcp", oauthRequest: resolved.request });
    const client = await env.OAUTH_PROVIDER.lookupClient(resolved.request.clientId);
    if (!client) throw new CafeError("AUTH_REQUIRED", "The OAuth client is not registered.", 400);
    const organizations = await listOrganizations(env, session.userId);
    if (!organizations.length) throw new CafeError("AUTH_REQUIRED", "No Cafe MCP organization is available.", 403);
    const activeId = organizations.some((item) => item.id === session.activeOrganizationId) ? session.activeOrganizationId : organizations[0]?.id;
    const requested = resolved.request.scope.filter(isSupportedOAuthScope);
    const scopes = requested.length ? requested : [...BASE_MCP_SCOPES];
    const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize Cafe MCP</title><link rel="stylesheet" href="${env.BASE_PATH}/styles.css"></head><body><main class="shell narrow"><p class="eyebrow">Cafe MCP authorization</p><h1>Connect ${escapeHtml(client.clientName || "this MCP client")}</h1><p>Select the organization this grant will be permanently bound to.</p><form method="post" action="${env.BASE_PATH}/authorize"><input type="hidden" name="resume" value="${escapeHtml(resolved.resumeId)}"><input type="hidden" name="csrf" value="${escapeHtml(session.csrfToken)}"><label>Organization<select name="organization_id" required>${organizations.map((organization) => `<option value="${escapeHtml(organization.id)}"${organization.id === activeId ? " selected" : ""}>${escapeHtml(organization.name)}</option>`).join("")}</select></label><fieldset><legend>Requested access</legend>${scopes.map((scope) => `<label class="check"><input type="checkbox" name="scope" value="${escapeHtml(scope)}" checked> ${escapeHtml(scope)}</label>`).join("")}</fieldset><div class="actions"><button type="submit" name="decision" value="allow">Authorize</button><button class="secondary" type="submit" name="decision" value="deny">Deny</button></div></form><p class="fine">Cafe MCP never allows an MCP client to choose an arbitrary Toast URL, method, or header.</p></main></body></html>`;
    return htmlResponse(body, 200, {
      "Content-Security-Policy": contentSecurityPolicyForOAuthConsent(resolved.request.redirectUri),
    });
  }

  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST" } });
  assertSameOrigin(request, env);
  const session = await requireSession(env, request);
  const form = await request.formData();
  await validateSessionCsrfValue(env, session, String(form.get("csrf") ?? ""));
  const resumeId = String(form.get("resume") ?? "");
  const oauthRequest = await loadConsentRequest(env, resumeId);
  if (form.get("decision") !== "allow") {
    await deleteConsentRequest(env, resumeId);
    const denied = new URL(oauthRequest.redirectUri);
    denied.searchParams.set("error", "access_denied");
    denied.searchParams.set("state", oauthRequest.state);
    denied.searchParams.set("iss", `${env.PUBLIC_ORIGIN}${env.BASE_PATH}`);
    return consentRedirect(denied.toString(), oauthRequest.redirectUri);
  }
  const organizationId = String(form.get("organization_id") ?? "");
  const membership = await requireMembership(env, session.userId, organizationId);
  const available = new Set(await availableScopesForMembership(env, membership));
  const requested = oauthRequest.scope.filter(isSupportedOAuthScope);
  const selected = form.getAll("scope").map(String).filter(isSupportedOAuthScope);
  const ceiling = requested.length ? new Set(requested) : new Set(BASE_MCP_SCOPES);
  const granted = [...new Set(selected)].filter((scope) => available.has(scope) && ceiling.has(scope));
  for (const base of BASE_MCP_SCOPES) if (available.has(base) && ceiling.has(base) && !granted.includes(base)) granted.push(base);
  if (!granted.length) throw new CafeError("SCOPE_DENIED", "At least one requested scope must be approved.", 400);
  const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
  const existingGrantIds = new Set((await listAllUserGrants(env, session.userId)).map((grant) => grant.id));
  const completed = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthRequest,
    userId: session.userId,
    metadata: { organizationId, clientName: client?.clientName?.slice(0, 100) ?? null },
    scope: granted,
    props: { userId: session.userId, organizationId, membershipId: membership.id },
    revokeExistingGrants: false,
  });
  const providerGrant = (await listAllUserGrants(env, session.userId))
    .filter((grant) => !existingGrantIds.has(grant.id))
    .filter((grant) => grant.clientId === oauthRequest.clientId)
    .filter((grant) => (grant.metadata as { organizationId?: string } | null)?.organizationId === organizationId)
    .sort((left, right) => right.createdAt - left.createdAt)[0];
  await env.TOAST_MCP_DB.prepare(
    `INSERT INTO oauth_grant_audit
      (id, provider_grant_id, user_id, organization_id, client_id, client_name, scopes_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(`oga_${crypto.randomUUID()}`, providerGrant?.id ?? null, session.userId, organizationId, oauthRequest.clientId,
    client?.clientName?.slice(0, 100) ?? null, JSON.stringify(granted), new Date().toISOString()).run();
  await deleteConsentRequest(env, resumeId);
  const redirect = new URL(completed.redirectTo);
  redirect.searchParams.set("iss", `${env.PUBLIC_ORIGIN}${env.BASE_PATH}`);
  return consentRedirect(redirect.toString(), oauthRequest.redirectUri);
}
