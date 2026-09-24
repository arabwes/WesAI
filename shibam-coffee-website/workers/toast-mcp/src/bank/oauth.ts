import { AuthorizationError, type AuthRequest } from "@cloudflare/workers-oauth-provider";
import { beginAuth0Login, deleteConsentRequest, loadConsentRequest, storeConsentRequest } from "../auth0";
import { listOrganizations, requireMembership, requireSession, validateSessionCsrfValue } from "../db";
import { CafeError } from "../errors";
import { assertSameOrigin, contentSecurityPolicyForOAuthConsent, htmlResponse } from "../security";
import type { BankEnvironment } from "./env";
import { BANK_BASE_SCOPES, BANK_SCOPE_DESCRIPTIONS, grantedBankScopes, isBankScope } from "./scopes";
import { bankAudit, bankEnabled } from "./store";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

function issuer(env: BankEnvironment): string {
  return `${env.PUBLIC_ORIGIN}${env.BASE_PATH}`;
}

function authorizationFailure(env: BankEnvironment, error: AuthorizationError): Response {
  if (!error.redirectUri) return htmlResponse("<!doctype html><title>Authorization failed</title><h1>Authorization failed</h1><p>The OAuth request is invalid.</p>", 400);
  const redirect = new URL(error.redirectUri);
  redirect.searchParams.set("error", error.code);
  redirect.searchParams.set("error_description", error.description);
  if (error.state) redirect.searchParams.set("state", error.state);
  redirect.searchParams.set("iss", issuer(env));
  return Response.redirect(redirect.toString(), 302);
}

function consentRedirect(target: string, registeredRedirectUri: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: target, "Content-Security-Policy": contentSecurityPolicyForOAuthConsent(registeredRedirectUri) },
  });
}

function failureFor(env: BankEnvironment, request: AuthRequest, code: "invalid_request" | "invalid_scope", description: string): Response {
  return authorizationFailure(env, new AuthorizationError(code, {
    description,
    redirectUri: request.redirectUri,
    state: request.state,
    ...(request.issuer ? { issuer: request.issuer } : {}),
  }));
}

export async function handleBankAuthorize(env: BankEnvironment, request: Request): Promise<Response> {
  if (request.method === "GET") {
    let oauthRequest: AuthRequest;
    let resumeId: string;
    try {
      const url = new URL(request.url);
      const resume = url.searchParams.get("resume");
      if (resume) {
        oauthRequest = await loadConsentRequest(env, resume);
        resumeId = resume;
      } else {
        oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
        resumeId = await storeConsentRequest(env, oauthRequest);
      }
    } catch (error) {
      if (error instanceof AuthorizationError) return authorizationFailure(env, error);
      throw error;
    }
    if (!oauthRequest.codeChallenge || oauthRequest.codeChallengeMethod !== "S256") {
      return failureFor(env, oauthRequest, "invalid_request", "S256 PKCE is required.");
    }
    if (oauthRequest.scope.some((scope) => !isBankScope(scope))) {
      return failureFor(env, oauthRequest, "invalid_scope", "An unsupported scope was requested.");
    }
    const session = await requireSession(env, request).catch(() => null);
    if (!session) return beginAuth0Login(env, { kind: "mcp", oauthRequest });
    const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
    if (!client) throw new CafeError("AUTH_REQUIRED", "The OAuth client is not registered.", 400);
    const owned = (await listOrganizations(env, session.userId)).filter((organization) => organization.role === "owner");
    if (!owned.length) throw new CafeError("SCOPE_DENIED", "BankCafeMCP is limited to organization owners.", 403);
    const activeId = owned.some((item) => item.id === session.activeOrganizationId) ? session.activeOrganizationId : owned[0]?.id;
    const requested = oauthRequest.scope.length ? oauthRequest.scope.filter(isBankScope) : [...BANK_BASE_SCOPES];
    const scopeInputs = requested.map((scope) =>
      `<label class="check"><input type="checkbox" name="scope" value="${escapeHtml(scope)}"> ${escapeHtml(BANK_SCOPE_DESCRIPTIONS[scope])} <code>${escapeHtml(scope)}</code></label>`).join("");
    const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize BankCafeMCP</title><link rel="stylesheet" href="${env.BASE_PATH}/styles.css"></head><body><main class="shell narrow"><p class="eyebrow">BankCafeMCP authorization</p><h1>Connect ${escapeHtml(client.clientName || "this MCP client")} to bank data</h1><p class="warning">This grants read-only access to bank account data. Nothing is ticked by default: choose only what this client needs.</p><form method="post" action="${env.BASE_PATH}/authorize"><input type="hidden" name="resume" value="${escapeHtml(resumeId)}"><input type="hidden" name="csrf" value="${escapeHtml(session.csrfToken)}"><label>Organization<select name="organization_id" required>${owned.map((organization) => `<option value="${escapeHtml(organization.id)}"${organization.id === activeId ? " selected" : ""}>${escapeHtml(organization.name)}</option>`).join("")}</select></label><fieldset><legend>Bank data this client may read</legend>${scopeInputs}</fieldset><div class="actions"><button type="submit" name="decision" value="allow">Authorize</button><button class="secondary" type="submit" name="decision" value="deny">Deny</button></div></form><p class="fine">BankCafeMCP cannot move money, initiate payments, or change anything at your bank.</p></main></body></html>`;
    return htmlResponse(body, 200, { "Content-Security-Policy": contentSecurityPolicyForOAuthConsent(oauthRequest.redirectUri) });
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
    denied.searchParams.set("iss", issuer(env));
    return consentRedirect(denied.toString(), oauthRequest.redirectUri);
  }
  const organizationId = String(form.get("organization_id") ?? "");
  const membership = await requireMembership(env, session.userId, organizationId, true);
  if (!(await bankEnabled(env, organizationId))) {
    throw new CafeError("FEATURE_DISABLED", "Turn on bank access in the BankCafeMCP page before authorizing a client.", 403);
  }
  const granted = grantedBankScopes(oauthRequest.scope, form.getAll("scope").map(String));
  if (!granted.length) throw new CafeError("SCOPE_DENIED", "Select at least one kind of bank data to share.", 400);
  const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
  const completed = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthRequest,
    userId: session.userId,
    metadata: { organizationId, clientName: client?.clientName?.slice(0, 100) ?? null },
    scope: granted,
    props: { userId: session.userId, organizationId, membershipId: membership.id },
    revokeExistingGrants: false,
  });
  await bankAudit(env, { userId: session.userId, organizationId, eventType: "bank.oauth_grant", outcome: granted.join(" ") });
  await deleteConsentRequest(env, resumeId);
  const redirect = new URL(completed.redirectTo);
  redirect.searchParams.set("iss", issuer(env));
  return consentRedirect(redirect.toString(), oauthRequest.redirectUri);
}
