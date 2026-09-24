import { z } from "zod";
import type { GrantSummary } from "@cloudflare/workers-oauth-provider";
import { auth0LogoutUrl, beginAuth0Login, handleAuth0Callback } from "../auth0";
import { listOrganizations, requireSession, revokeSession, validateSessionCsrf, validateSessionCsrfValue } from "../db";
import { CafeError, publicError, toErrorResponse } from "../errors";
import { assertSameOrigin, clearCsrfCookie, clearSessionCookie, jsonResponse, logEvent } from "../security";
import type { SessionIdentity } from "../runtime";
import type { BankEnvironment } from "./env";
import { handleBankAuthorize } from "./oauth";
import {
  bankAudit,
  bankEnabled,
  createBankConnection,
  disconnectBankConnection,
  listBankConnections,
  refreshBankAccounts,
  rotateBankClientSecret,
  setBankEnabled,
} from "./store";

const JSON_LIMIT = 16 * 1024;

async function readJson(request: Request): Promise<unknown> {
  const length = Number.parseInt(request.headers.get("Content-Length") ?? "0", 10);
  if (length > JSON_LIMIT) throw new CafeError("VALIDATION_FAILED", "The request body is too large.", 413);
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > JSON_LIMIT) throw new CafeError("VALIDATION_FAILED", "The request body is too large.", 413);
  try { return JSON.parse(text || "{}"); } catch { throw new CafeError("VALIDATION_FAILED", "The request body must be JSON."); }
}

async function listBankGrants(env: BankEnvironment, userId: string): Promise<GrantSummary[]> {
  const items: GrantSummary[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.OAUTH_PROVIDER.listUserGrants(userId, cursor ? { limit: 1000, cursor } : { limit: 1000 });
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return items;
}

async function activeOrganization(env: BankEnvironment, session: SessionIdentity) {
  const organizations = await listOrganizations(env, session.userId);
  return organizations.find((organization) => organization.id === session.activeOrganizationId) ?? organizations[0] ?? null;
}

async function dashboard(env: BankEnvironment, request: Request): Promise<Response> {
  const session = await requireSession(env, request);
  const organization = await activeOrganization(env, session);
  const base = {
    authenticated: true,
    csrfToken: session.csrfToken,
    user: { email: session.email, displayName: session.displayName },
    bankMode: env.BANK_MODE === "enabled",
    mcpEndpoint: `${env.PUBLIC_ORIGIN}${env.BASE_PATH}/mcp`,
  };
  if (!organization) return jsonResponse({ ...base, organization: null });
  const owner = organization.role === "owner";
  const [enabled, connections, grants] = await Promise.all([
    bankEnabled(env, organization.id),
    owner ? listBankConnections(env, organization.id) : Promise.resolve([]),
    listBankGrants(env, session.userId),
  ]);
  return jsonResponse({
    ...base,
    organization: { id: organization.id, name: organization.name, role: organization.role },
    bankEnabled: enabled,
    connections,
    grants: grants
      .filter((grant) => (grant.metadata as { organizationId?: string } | null)?.organizationId === organization.id)
      .map((grant) => ({
        id: grant.id,
        clientName: (grant.metadata as { clientName?: string | null } | null)?.clientName ?? grant.clientId,
        scope: grant.scope,
        createdAt: grant.createdAt,
      })),
  });
}

function scopedSession(session: SessionIdentity, organizationId: string): SessionIdentity {
  return { ...session, activeOrganizationId: organizationId };
}

async function mutate(env: BankEnvironment, request: Request, pathname: string): Promise<Response> {
  assertSameOrigin(request, env);
  const session = await requireSession(env, request);
  await validateSessionCsrf(env, request, session);
  const organization = await activeOrganization(env, session);
  if (!organization) throw new CafeError("AUTH_REQUIRED", "No organization is available.", 409);
  const owned = scopedSession(session, organization.id);
  const base = env.BASE_PATH;

  if (pathname === `${base}/api/settings` && request.method === "POST") {
    const input = z.object({ enabled: z.boolean() }).parse(await readJson(request));
    await setBankEnabled(env, owned, input.enabled);
    return jsonResponse({ ok: true });
  }
  if (pathname === `${base}/api/connections` && request.method === "POST") {
    const connectionId = await createBankConnection(env, owned, await readJson(request));
    return jsonResponse({ ok: true, connectionId }, 201);
  }
  const connectionMatch = pathname.match(new RegExp(`^${base}/api/connections/(bcn_[a-f0-9-]+)(?:/(rotate|refresh))?$`, "u"));
  if (connectionMatch?.[1]) {
    const connectionId = connectionMatch[1];
    if (request.method === "DELETE" && !connectionMatch[2]) {
      await disconnectBankConnection(env, owned, connectionId);
      return jsonResponse({ ok: true });
    }
    if (request.method === "POST" && connectionMatch[2] === "rotate") {
      const input = z.object({ clientSecret: z.string() }).parse(await readJson(request));
      await rotateBankClientSecret(env, owned, connectionId, input.clientSecret);
      return jsonResponse({ ok: true });
    }
    if (request.method === "POST" && connectionMatch[2] === "refresh") {
      await refreshBankAccounts(env, owned, connectionId);
      return jsonResponse({ ok: true });
    }
  }
  const grantMatch = pathname.match(new RegExp(`^${base}/api/grants/([^/]+)/revoke$`, "u"));
  if (grantMatch?.[1] && request.method === "POST") {
    const grantId = decodeURIComponent(grantMatch[1]);
    const grant = (await listBankGrants(env, session.userId)).find((item) => item.id === grantId);
    if (!grant || (grant.metadata as { organizationId?: string } | null)?.organizationId !== organization.id) {
      throw new CafeError("NOT_FOUND", "The OAuth grant was not found.", 404);
    }
    await env.OAUTH_PROVIDER.revokeGrant(grantId, session.userId);
    await bankAudit(env, { userId: session.userId, organizationId: organization.id, eventType: "bank.oauth_grant_revoked", outcome: "success" });
    return jsonResponse({ ok: true });
  }
  throw new CafeError("NOT_FOUND", "Not found.", 404);
}

export async function handleBankPortalRequest(env: BankEnvironment, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/$/u, "") || "/";
  const base = env.BASE_PATH;
  const requestId = request.headers.get("Cf-Ray") ?? request.headers.get("X-Cafe-MCP-Request-Id") ?? crypto.randomUUID();
  try {
    if (pathname === `${base}/healthz`) return jsonResponse({ ok: true, service: "bankcafemcp" });
    if (pathname === `${base}/authorize`) return await handleBankAuthorize(env, request);
    if (pathname === `${base}/auth/login`) return await beginAuth0Login(env, { kind: "portal", returnTo: url.searchParams.get("returnTo") });
    if (pathname === `${base}/auth/callback`) return await handleAuth0Callback(env, request);
    if (pathname === `${base}/auth/logout` && request.method === "POST") {
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
    if (pathname === `${base}/api/me` && request.method === "GET") return await dashboard(env, request);
    if (pathname.startsWith(`${base}/api/`)) return await mutate(env, request, pathname);
    if (pathname === base) {
      if (!url.pathname.endsWith("/")) return Response.redirect(`${url.origin}${base}/`, 308);
      return env.ASSETS.fetch(request);
    }
    if (pathname.startsWith(`${base}/`)) return env.ASSETS.fetch(request);
    throw new CafeError("NOT_FOUND", "Not found.", 404);
  } catch (error) {
    const normalized = error instanceof z.ZodError
      ? new CafeError("VALIDATION_FAILED", "The submitted data is invalid.")
      : error;
    const safe = publicError(normalized);
    logEvent(safe.status >= 500 ? "error" : "warn", "bank_portal_request_failed", { requestId, code: safe.code, status: safe.status });
    return toErrorResponse(normalized, env.APP_ENV === "production", requestId);
  }
}
