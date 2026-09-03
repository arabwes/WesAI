import { z } from "zod";
import type { GrantSummary } from "@cloudflare/workers-oauth-provider";
import { auth0LogoutUrl, beginAuth0Login, handleAuth0Callback } from "./auth0";
import { createByoConnection, disconnectConnection, listConnections, rotateConnectionSecret } from "./connections";
import {
  acceptInvitation,
  createInvitation,
  listLocationsForAccess,
  listMembers,
  listOrganizations,
  loadEffectiveAccess,
  requireMembership,
  requireSession,
  revokeSession,
  setActiveOrganization,
  setSensitivePiiEnabled,
  validateSessionCsrf,
  validateSessionCsrfValue,
} from "./db";
import { CafeError, publicError, toErrorResponse } from "./errors";
import { handleAuthorize } from "./oauth";
import { confirmPartnerMigration, ingestPartnerWebhook } from "./partner";
import { ALL_OAUTH_SCOPES, SENSITIVE_TOAST_SCOPES, TOAST_STANDARD_SCOPES, isSupportedOAuthScope } from "./scopes";
import { assertSameOrigin, clearCsrfCookie, clearSessionCookie, jsonResponse, logEvent } from "./security";
import type { CafeEnvironment } from "./runtime";

const jsonLimit = 64 * 1024;

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

async function revokeOrganizationGrants(env: CafeEnvironment, organizationId: string, userIds: Iterable<string>): Promise<void> {
  for (const userId of new Set(userIds)) {
    const grants = await listAllUserGrants(env, userId);
    for (const grant of grants) {
      if ((grant.metadata as { organizationId?: string } | null)?.organizationId === organizationId) {
        await env.OAUTH_PROVIDER.revokeGrant(grant.id, userId);
      }
    }
  }
}

async function readJson(request: Request): Promise<unknown> {
  const length = Number.parseInt(request.headers.get("Content-Length") ?? "0", 10);
  if (length > jsonLimit) throw new CafeError("VALIDATION_FAILED", "The request body is too large.", 413);
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > jsonLimit) throw new CafeError("VALIDATION_FAILED", "The request body is too large.", 413);
  try { return JSON.parse(text || "{}"); } catch { throw new CafeError("VALIDATION_FAILED", "The request body must be JSON."); }
}

async function dashboard(env: CafeEnvironment, request: Request): Promise<Response> {
  const session = await requireSession(env, request);
  const organizations = await listOrganizations(env, session.userId);
  const organizationId = session.activeOrganizationId ?? organizations[0]?.id ?? null;
  if (!organizationId) return jsonResponse({ authenticated: true, user: { email: session.email }, organizations: [] });
  const membership = await requireMembership(env, session.userId, organizationId);
  const access = await loadEffectiveAccess(env, {
    userId: session.userId,
    organizationId,
    membershipId: membership.id,
  }, ALL_OAUTH_SCOPES);
  const [locations, members, grants, connections, enabledScopeRows] = await Promise.all([
    listLocationsForAccess(env, access, true),
    membership.role === "owner" ? listMembers(env, organizationId) : Promise.resolve([]),
    listAllUserGrants(env, session.userId).then((items) => ({ items })),
    membership.role === "owner" ? listConnections(env, { ...session, activeOrganizationId: organizationId }) : Promise.resolve([]),
    env.TOAST_MCP_DB.prepare("SELECT scope FROM organization_scopes WHERE organization_id = ? AND enabled = 1 ORDER BY scope").bind(organizationId).all<{ scope: string }>(),
  ]);
  return jsonResponse({
    authenticated: true,
    csrfToken: session.csrfToken,
    user: { email: session.email, displayName: session.displayName },
    activeOrganizationId: organizationId,
    organizations,
    locations: locations.map((location) => ({ ...location, migration_pending: Boolean(location.pending_connection_id) })),
    members,
    connections,
    enabledToastScopes: enabledScopeRows.results.map((row) => row.scope),
    grants: grants.items.filter((grant) => (grant.metadata as { organizationId?: string } | null)?.organizationId === organizationId),
    partnerMode: env.TOAST_PARTNER_MODE === "enabled",
    byoMode: env.TOAST_BYO_MODE === "enabled",
  });
}

async function mutate(env: CafeEnvironment, request: Request, pathname: string): Promise<Response> {
  assertSameOrigin(request, env);
  const session = await requireSession(env, request);
  await validateSessionCsrf(env, request, session);
  const body = await readJson(request);
  const orgId = session.activeOrganizationId;

  if (pathname === `${env.BASE_PATH}/api/organizations/active` && request.method === "POST") {
    const input = z.object({ organizationId: z.string().startsWith("org_") }).parse(body);
    await setActiveOrganization(env, session, input.organizationId);
    return jsonResponse({ ok: true });
  }
  if (pathname === `${env.BASE_PATH}/api/invitations/accept` && request.method === "POST") {
    const input = z.object({ token: z.string().min(20).max(300) }).parse(body);
    const organizationId = await acceptInvitation(env, session.userId, session.email, input.token);
    await setActiveOrganization(env, session, organizationId);
    return jsonResponse({ ok: true, organizationId });
  }
  if (!orgId) throw new CafeError("AUTH_REQUIRED", "Select an organization.", 409);
  if (pathname === `${env.BASE_PATH}/api/invitations` && request.method === "POST") {
    const input = z.object({ email: z.string().email(), locationIds: z.array(z.string().startsWith("loc_")).max(100), scopes: z.array(z.string()).max(30) }).parse(body);
    const invitation = await createInvitation(env, session.userId, orgId, input.email, input.locationIds, input.scopes.filter(isSupportedOAuthScope));
    await env.CAFE_MCP_JOBS.send({ kind: "invitation_email", invitationId: invitation.id, token: invitation.token });
    return jsonResponse({ ok: true, invitationId: invitation.id });
  }
  if (pathname === `${env.BASE_PATH}/api/scopes/sensitive` && request.method === "POST") {
    const input = z.object({ enabled: z.boolean() }).parse(body);
    await setSensitivePiiEnabled(env, session.userId, orgId, input.enabled);
    return jsonResponse({ ok: true });
  }
  if (pathname === `${env.BASE_PATH}/api/scopes` && request.method === "PUT") {
    await requireMembership(env, session.userId, orgId, true);
    const input = z.object({ scopes: z.array(z.enum(TOAST_STANDARD_SCOPES)).max(TOAST_STANDARD_SCOPES.length) }).parse(body);
    const requested = new Set(input.scopes);
    const organization = await env.TOAST_MCP_DB.prepare("SELECT sensitive_pii_enabled FROM organizations WHERE id = ?").bind(orgId).first<{ sensitive_pii_enabled: number }>();
    const timestamp = new Date().toISOString();
    await env.TOAST_MCP_DB.batch(TOAST_STANDARD_SCOPES.map((scope) => {
      const sensitiveAllowed = !SENSITIVE_TOAST_SCOPES.has(scope) || organization?.sensitive_pii_enabled === 1;
      return env.TOAST_MCP_DB.prepare("UPDATE organization_scopes SET enabled = ?, updated_at = ? WHERE organization_id = ? AND scope = ?")
        .bind(requested.has(scope) && sensitiveAllowed ? 1 : 0, timestamp, orgId, scope);
    }));
    return jsonResponse({ ok: true });
  }
  if (pathname === `${env.BASE_PATH}/api/connections` && request.method === "POST") {
    const connectionId = await createByoConnection(env, session, body);
    return jsonResponse({ ok: true, connectionId }, 201);
  }
  const connectionMatch = pathname.match(new RegExp(`^${env.BASE_PATH}/api/connections/(con_[a-f0-9-]+)(?:/(rotate))?$`, "u"));
  if (connectionMatch?.[1]) {
    if (request.method === "DELETE" && !connectionMatch[2]) {
      const permanent = new URL(request.url).searchParams.get("permanent") === "true";
      await disconnectConnection(env, session, connectionMatch[1], permanent);
      return jsonResponse({ ok: true });
    }
    if (request.method === "POST" && connectionMatch[2] === "rotate") {
      const input = z.object({ clientSecret: z.string() }).parse(body);
      await rotateConnectionSecret(env, session, connectionMatch[1], input.clientSecret);
      return jsonResponse({ ok: true });
    }
  }
  const memberMatch = pathname.match(new RegExp(`^${env.BASE_PATH}/api/members/(mem_[a-f0-9-]+)/(permissions|revoke)$`, "u"));
  if (memberMatch?.[1]) {
    await requireMembership(env, session.userId, orgId, true);
    const target = await env.TOAST_MCP_DB.prepare("SELECT id, user_id, role FROM memberships WHERE id = ? AND organization_id = ?").bind(memberMatch[1], orgId).first<{ id: string; user_id: string; role: string }>();
    if (!target || target.role === "owner") throw new CafeError("VALIDATION_FAILED", "The target member cannot be changed.", 409);
    if (memberMatch[2] === "revoke" && request.method === "POST") {
      await env.TOAST_MCP_DB.prepare("UPDATE memberships SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE id = ?").bind(new Date().toISOString(), new Date().toISOString(), target.id).run();
      await revokeOrganizationGrants(env, orgId, [target.user_id]);
      await env.TOAST_MCP_DB.prepare("UPDATE oauth_grant_audit SET revoked_at = ? WHERE user_id = ? AND organization_id = ? AND revoked_at IS NULL").bind(new Date().toISOString(), target.user_id, orgId).run();
      return jsonResponse({ ok: true });
    }
    if (memberMatch[2] === "permissions" && request.method === "PUT") {
      const input = z.object({ locationIds: z.array(z.string().startsWith("loc_")).max(100), scopes: z.array(z.string()).max(30) }).parse(body);
      const uniqueLocations = [...new Set(input.locationIds)];
      const { results: validLocations } = await env.TOAST_MCP_DB.prepare("SELECT id FROM toast_locations WHERE organization_id = ? AND status = 'active'").bind(orgId).all<{ id: string }>();
      const validLocationIds = new Set(validLocations.map((location) => location.id));
      if (uniqueLocations.some((id) => !validLocationIds.has(id))) throw new CafeError("LOCATION_DENIED", "A member permission contains an unavailable location.", 403);
      const organization = await env.TOAST_MCP_DB.prepare("SELECT sensitive_pii_enabled FROM organizations WHERE id = ?").bind(orgId).first<{ sensitive_pii_enabled: number }>();
      const normalizedScopes = [...new Set(input.scopes.filter(isSupportedOAuthScope))];
      if (normalizedScopes.some((scope) => scope === "toast/guest.pi:read" || scope === "toast/delivery_info.address:read") && organization?.sensitive_pii_enabled !== 1) {
        throw new CafeError("SCOPE_DENIED", "Sensitive PII scopes are not enabled for this organization.", 403);
      }
      const timestamp = new Date().toISOString();
      const statements: D1PreparedStatement[] = [env.TOAST_MCP_DB.prepare("DELETE FROM member_locations WHERE membership_id = ?").bind(target.id), env.TOAST_MCP_DB.prepare("DELETE FROM member_scopes WHERE membership_id = ?").bind(target.id)];
      for (const id of uniqueLocations) statements.push(env.TOAST_MCP_DB.prepare("INSERT INTO member_locations (membership_id, location_id, created_at) VALUES (?, ?, ?)").bind(target.id, id, timestamp));
      for (const scope of normalizedScopes) statements.push(env.TOAST_MCP_DB.prepare("INSERT INTO member_scopes (membership_id, scope, created_at) VALUES (?, ?, ?)").bind(target.id, scope, timestamp));
      await env.TOAST_MCP_DB.batch(statements);
      return jsonResponse({ ok: true });
    }
  }
  const grantMatch = pathname.match(new RegExp(`^${env.BASE_PATH}/api/grants/([^/]+)/revoke$`, "u"));
  if (grantMatch?.[1] && request.method === "POST") {
    const grantId = decodeURIComponent(grantMatch[1]);
    const grant = (await listAllUserGrants(env, session.userId)).find((item) => item.id === grantId);
    if (!grant || (grant.metadata as { organizationId?: string } | null)?.organizationId !== orgId) {
      throw new CafeError("NOT_FOUND", "The OAuth grant was not found in this organization.", 404);
    }
    await env.OAUTH_PROVIDER.revokeGrant(grantId, session.userId);
    await env.TOAST_MCP_DB.prepare("UPDATE oauth_grant_audit SET revoked_at = ? WHERE provider_grant_id = ? AND user_id = ? AND organization_id = ? AND revoked_at IS NULL")
      .bind(new Date().toISOString(), grantId, session.userId, orgId).run();
    return jsonResponse({ ok: true });
  }
  const migrationMatch = pathname.match(new RegExp(`^${env.BASE_PATH}/api/locations/(loc_[a-f0-9-]+)/confirm-partner$`, "u"));
  if (migrationMatch?.[1] && request.method === "POST") {
    await confirmPartnerMigration(env, session.userId, orgId, migrationMatch[1]);
    return jsonResponse({ ok: true });
  }
  if (pathname === `${env.BASE_PATH}/api/organization/transfer-ownership` && request.method === "POST") {
    const owner = await requireMembership(env, session.userId, orgId, true);
    const input = z.object({ membershipId: z.string().startsWith("mem_") }).parse(body);
    if (input.membershipId === owner.id) throw new CafeError("VALIDATION_FAILED", "Choose another active member.");
    const target = await env.TOAST_MCP_DB.prepare("SELECT id FROM memberships WHERE id = ? AND organization_id = ? AND role = 'member' AND status = 'active'").bind(input.membershipId, orgId).first<{ id: string }>();
    if (!target) throw new CafeError("NOT_FOUND", "The destination member is unavailable.", 404);
    const timestamp = new Date().toISOString();
    const results = await env.TOAST_MCP_DB.batch([
      env.TOAST_MCP_DB.prepare(
        `UPDATE memberships SET role = 'member', updated_at = ?
          WHERE id = ? AND role = 'owner' AND status = 'active'
            AND EXISTS (SELECT 1 FROM memberships WHERE id = ? AND organization_id = ? AND role = 'member' AND status = 'active')`,
      ).bind(timestamp, owner.id, target.id, orgId),
      env.TOAST_MCP_DB.prepare(
        `UPDATE memberships SET role = 'owner', updated_at = ?
          WHERE id = ? AND organization_id = ? AND role = 'member' AND status = 'active'
            AND EXISTS (SELECT 1 FROM memberships WHERE id = ? AND organization_id = ? AND role = 'member' AND status = 'active')`,
      ).bind(timestamp, target.id, orgId, owner.id, orgId),
    ]);
    if (!results[0]?.meta.changes || !results[1]?.meta.changes) {
      throw new CafeError("CONFLICT", "Organization ownership changed before the transfer completed.", 409);
    }
    return jsonResponse({ ok: true });
  }
  if (pathname === `${env.BASE_PATH}/api/organization` && request.method === "DELETE") {
    await requireMembership(env, session.userId, orgId, true);
    const input = z.object({ confirmation: z.string() }).parse(body);
    if (input.confirmation !== orgId) throw new CafeError("VALIDATION_FAILED", "Organization deletion was not confirmed.");
    const { results: organizationUsers } = await env.TOAST_MCP_DB.prepare("SELECT user_id FROM memberships WHERE organization_id = ?").bind(orgId).all<{ user_id: string }>();
    await revokeOrganizationGrants(env, orgId, organizationUsers.map((membership) => membership.user_id));
    const { results: resultRows } = await env.TOAST_MCP_DB.prepare("SELECT id, chunk_count FROM result_objects WHERE organization_id = ?").bind(orgId).all<{ id: string; chunk_count: number }>();
    for (const resultRow of resultRows) await env.TOAST_RESULTS.delete(Array.from({ length: resultRow.chunk_count }, (_, index) => `results/${resultRow.id}/chunk-${index}.json`));
    await env.TOAST_MCP_DB.prepare("DELETE FROM organizations WHERE id = ?").bind(orgId).run();
    return jsonResponse({ ok: true });
  }
  throw new CafeError("NOT_FOUND", "Not found.", 404);
}

export async function handlePortalRequest(env: CafeEnvironment, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/$/u, "") || "/";
  const requestId = request.headers.get("Cf-Ray") ?? request.headers.get("X-Cafe-MCP-Request-Id") ?? crypto.randomUUID();
  try {
    if (pathname === `${env.BASE_PATH}/healthz`) return jsonResponse({ ok: true, service: "cafe-mcp" });
    if (pathname === `${env.BASE_PATH}/webhooks/toast/partners`) return await ingestPartnerWebhook(env, request);
    if (pathname === `${env.BASE_PATH}/authorize`) return await handleAuthorize(env, request);
    if (pathname === `${env.BASE_PATH}/auth/login`) return await beginAuth0Login(env, { kind: "portal", returnTo: url.searchParams.get("returnTo") });
    if (pathname === `${env.BASE_PATH}/auth/callback`) return await handleAuth0Callback(env, request);
    if (pathname === `${env.BASE_PATH}/auth/logout` && request.method === "POST") {
      assertSameOrigin(request, env);
      const session = await requireSession(env, request);
      const form = await request.formData();
      await validateSessionCsrfValue(env, session, String(form.get("csrf") ?? ""));
      await revokeSession(env, session.sessionToken);
      const headers = new Headers({ Location: auth0LogoutUrl(env) });
      headers.append("Set-Cookie", clearSessionCookie());
      headers.append("Set-Cookie", clearCsrfCookie());
      return new Response(null, { status: 302, headers });
    }
    if (pathname === `${env.BASE_PATH}/api/me` && request.method === "GET") return await dashboard(env, request);
    if (pathname.startsWith(`${env.BASE_PATH}/api/`)) return await mutate(env, request, pathname);
    if (pathname === env.BASE_PATH) {
      if (!url.pathname.endsWith("/")) return Response.redirect(`${url.origin}${env.BASE_PATH}/`, 308);
      return env.ASSETS.fetch(request);
    }
    if (pathname.startsWith(`${env.BASE_PATH}/`)) return env.ASSETS.fetch(request);
    throw new CafeError("NOT_FOUND", "Not found.", 404);
  } catch (error) {
    const normalized = error instanceof z.ZodError
      ? new CafeError("VALIDATION_FAILED", "The submitted data is invalid.")
      : error;
    const safe = publicError(normalized);
    logEvent(safe.status >= 500 ? "error" : "warn", "portal_request_failed", {
      requestId,
      code: safe.code,
      status: safe.status,
    });
    return toErrorResponse(normalized, env.APP_ENV === "production", requestId);
  }
}
