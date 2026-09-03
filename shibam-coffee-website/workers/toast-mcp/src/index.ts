import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { WorkerEntrypoint } from "cloudflare:workers";
import { createMcpHandler } from "agents/mcp/server";
import { cleanupExpiredRecords } from "./db";
import { CafeError, toErrorResponse } from "./errors";
import { createCafeMcpServer } from "./mcp";
import { processPartnerEvent, reconcilePartnerLocations } from "./partner";
import { handlePortalRequest } from "./portal";
import { ALL_OAUTH_SCOPES } from "./scopes";
import { assertAllowedHost, logEvent, withSecurityHeaders } from "./security";
import { CafeCredentialBroker } from "./toast/credential-broker";
import type { AuthProps, CafeEnvironment, CafeJob } from "./runtime";

export { CafeCredentialBroker };

class McpApiHandler extends WorkerEntrypoint<CafeEnvironment, AuthProps> {
  override async fetch(request: Request): Promise<Response> {
    const handler = createMcpHandler(() => createCafeMcpServer(this.env), {
      route: `${this.env.BASE_PATH}/mcp`,
      authContext: { props: this.ctx.props },
      allowedHostnames: [new URL(this.env.PUBLIC_ORIGIN).hostname],
      allowedOriginHostnames: [new URL(this.env.PUBLIC_ORIGIN).hostname],
      corsOptions: false,
      onerror: (error) => logEvent("error", "mcp_transport_error", { message: error.message }),
    });
    const match = request.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/iu);
    if (!match?.[1]) return new Response("Unauthorized", { status: 401 });
    const token = match[1];
    const summary = await this.env.OAUTH_PROVIDER.unwrapToken<AuthProps>(token);
    if (!summary) return new Response("Unauthorized", { status: 401 });
    return handler.fetch(request, {
      authInfo: {
        token,
        clientId: summary.grant.clientId,
        scopes: summary.scope,
        expiresAt: summary.expiresAt,
        resource: new URL(`${this.env.PUBLIC_ORIGIN}${this.env.BASE_PATH}/mcp`),
      },
    });
  }
}

const defaultHandler: ExportedHandler<CafeEnvironment> = {
  fetch(request, env) {
    return handlePortalRequest(env, request);
  },
};

function clientMetadataIsSafe(metadata: Record<string, unknown>): boolean {
  if (metadata.software_statement !== undefined) return false;
  if (typeof metadata.client_name === "string" && metadata.client_name.length > 100) return false;
  if (Array.isArray(metadata.redirect_uris) && metadata.redirect_uris.length > 10) return false;
  if (Array.isArray(metadata.contacts) && metadata.contacts.length > 5) return false;
  for (const field of ["client_uri", "logo_uri", "tos_uri", "policy_uri"]) {
    const value = metadata[field];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.length > 500) return false;
    try {
      if (new URL(value).protocol !== "https:") return false;
    } catch {
      return false;
    }
  }
  return true;
}

function createProvider(env: CafeEnvironment): OAuthProvider<CafeEnvironment> {
  return new OAuthProvider<CafeEnvironment>({
    apiRoute: `${env.BASE_PATH}/mcp`,
    apiHandler: McpApiHandler,
    defaultHandler,
    authorizeEndpoint: `${env.BASE_PATH}/authorize`,
    tokenEndpoint: `${env.BASE_PATH}/token`,
    clientRegistrationEndpoint: `${env.BASE_PATH}/register`,
    accessTokenTTL: 3_600,
    refreshTokenTTL: 30 * 24 * 60 * 60,
    clientRegistrationTTL: 90 * 24 * 60 * 60,
    scopesSupported: [...ALL_OAUTH_SCOPES],
    allowImplicitFlow: false,
    allowPlainPKCE: false,
    allowTokenExchangeGrant: false,
    clientIdMetadataDocumentEnabled: true,
    resourceMetadata: {
      resource: `${env.PUBLIC_ORIGIN}${env.BASE_PATH}/mcp`,
      authorization_servers: [`${env.PUBLIC_ORIGIN}${env.BASE_PATH}`],
      scopes_supported: [...ALL_OAUTH_SCOPES],
      bearer_methods_supported: ["header"],
      resource_name: "Cafe MCP — Toast read-only connector",
    },
    clientRegistrationCallback({ clientMetadata }) {
      if (!clientMetadataIsSafe(clientMetadata)) {
        return { code: "invalid_client_metadata", description: "Client metadata did not pass Cafe MCP safety limits.", status: 400 };
      }
    },
    onError(error) {
      logEvent("warn", "oauth_error", { code: error.code, status: error.status, category: error.internal?.category });
    },
  });
}

function authorizationMetadata(env: CafeEnvironment): Response {
  return Response.json({
    issuer: `${env.PUBLIC_ORIGIN}${env.BASE_PATH}`,
    authorization_endpoint: `${env.PUBLIC_ORIGIN}${env.BASE_PATH}/authorize`,
    token_endpoint: `${env.PUBLIC_ORIGIN}${env.BASE_PATH}/token`,
    registration_endpoint: `${env.PUBLIC_ORIGIN}${env.BASE_PATH}/register`,
    revocation_endpoint: `${env.PUBLIC_ORIGIN}${env.BASE_PATH}/token`,
    scopes_supported: ALL_OAUTH_SCOPES,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
    code_challenge_methods_supported: ["S256"],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
  }, { headers: { "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" } });
}

async function sendInvitationEmail(env: CafeEnvironment, invitationId: string, token: string): Promise<void> {
  if (!env.RESEND_API_KEY) throw new Error("RESEND_API_KEY is not configured");
  const row = await env.TOAST_MCP_DB.prepare(
    `SELECT i.email_normalized, o.name FROM invitations i JOIN organizations o ON o.id = i.organization_id
      WHERE i.id = ? AND i.status = 'pending' AND i.expires_at > ?`,
  ).bind(invitationId, new Date().toISOString()).first<{ email_normalized: string; name: string }>();
  if (!row) return;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [row.email_normalized],
      subject: `Join ${row.name} on Cafe MCP`,
      text: `You were invited to ${row.name}. Sign in with this email address and accept within seven days: ${env.PUBLIC_ORIGIN}${env.BASE_PATH}/?invite=${encodeURIComponent(token)}`,
    }),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Invitation delivery failed with HTTP ${response.status}`);
}

const worker: ExportedHandler<CafeEnvironment, CafeJob> = {
  async fetch(request, env, ctx) {
    const requestId = request.headers.get("Cf-Ray") ?? crypto.randomUUID();
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("X-Cafe-MCP-Request-Id", requestId);
    const routedRequest = new Request(request, { headers: requestHeaders });
    try {
      assertAllowedHost(routedRequest, env);
      const pathname = new URL(routedRequest.url).pathname.replace(/\/$/u, "");
      let response: Response;
      if (pathname === `/.well-known/oauth-authorization-server${env.BASE_PATH}`) {
        response = routedRequest.method === "GET" ? authorizationMetadata(env) : new Response(null, { status: 405, headers: { Allow: "GET" } });
      } else {
        response = await createProvider(env).fetch(routedRequest, env, ctx);
      }
      return withSecurityHeaders(response, requestId);
    } catch (error) {
      logEvent(error instanceof CafeError && error.status < 500 ? "warn" : "error", "request_failed", {
        requestId,
        code: error instanceof CafeError ? error.code : "INTERNAL_ERROR",
      });
      return withSecurityHeaders(toErrorResponse(error, env.APP_ENV === "production", requestId), requestId);
    }
  },

  async queue(batch, env) {
    for (const message of batch.messages) {
      try {
        if (message.body.kind === "invitation_email") await sendInvitationEmail(env, message.body.invitationId, message.body.token);
        else await processPartnerEvent(env, message.body.partnerEventId);
        message.ack();
      } catch (error) {
        if (message.body.kind === "partner_event") {
          await env.TOAST_MCP_DB.prepare("UPDATE partner_events SET status = 'failed', error_code = 'PROCESSING_FAILED' WHERE id = ?")
            .bind(message.body.partnerEventId).run().catch(() => undefined);
        }
        logEvent("error", "queue_job_failed", { kind: message.body.kind, message: error instanceof Error ? error.message : "unknown" });
        message.retry({ delaySeconds: 60 });
      }
    }
  },

  async scheduled(controller, env, ctx) {
    const jobs: Promise<unknown>[] = [
      cleanupExpiredRecords(env),
      createProvider(env).purgeExpiredData(env, { batchSize: 100 }),
    ];
    if (controller.cron === "0 */8 * * *") jobs.push(reconcilePartnerLocations(env));
    ctx.waitUntil(Promise.all(jobs).then(() => undefined));
  },
};

export default worker;
