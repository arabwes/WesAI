import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { WorkerEntrypoint } from "cloudflare:workers";
import { createMcpHandler } from "agents/mcp/server";
import { clientMetadataIsSafe } from "../client-metadata";
import { logEvent } from "../security";
import type { AuthProps, CafeEnvironment } from "../runtime";
import { bankEnvironment, type BankBindings, type BankEnvironment } from "./env";
import { handleBankPortalRequest } from "./portal";
import { BANK_SCOPES } from "./scopes";
import { createBankMcpServer } from "./tools";

export { isBankPath } from "./env";

class BankMcpApiHandler extends WorkerEntrypoint<BankEnvironment, AuthProps> {
  override async fetch(request: Request): Promise<Response> {
    const handler = createMcpHandler(() => createBankMcpServer(this.env), {
      route: `${this.env.BASE_PATH}/mcp`,
      authContext: { props: this.ctx.props },
      allowedHostnames: [new URL(this.env.PUBLIC_ORIGIN).hostname],
      allowedOriginHostnames: [new URL(this.env.PUBLIC_ORIGIN).hostname],
      corsOptions: false,
      onerror: (error) => logEvent("error", "bank_mcp_transport_error", { message: error.message }),
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

const bankDefaultHandler: ExportedHandler<BankEnvironment> = {
  fetch(request, env) {
    return handleBankPortalRequest(env, request);
  },
};

function createBankProvider(env: BankEnvironment): OAuthProvider<BankEnvironment> {
  const base = env.BASE_PATH;
  return new OAuthProvider<BankEnvironment>({
    apiRoute: `${base}/mcp`,
    apiHandler: BankMcpApiHandler,
    defaultHandler: bankDefaultHandler,
    authorizeEndpoint: `${base}/authorize`,
    tokenEndpoint: `${base}/token`,
    clientRegistrationEndpoint: `${base}/register`,
    accessTokenTTL: 3_600,
    refreshTokenTTL: 30 * 24 * 60 * 60,
    clientRegistrationTTL: 90 * 24 * 60 * 60,
    scopesSupported: [...BANK_SCOPES],
    allowImplicitFlow: false,
    allowPlainPKCE: false,
    allowTokenExchangeGrant: false,
    clientIdMetadataDocumentEnabled: true,
    resourceMetadata: {
      resource: `${env.PUBLIC_ORIGIN}${base}/mcp`,
      authorization_servers: [`${env.PUBLIC_ORIGIN}${base}`],
      scopes_supported: [...BANK_SCOPES],
      bearer_methods_supported: ["header"],
      resource_name: "BankCafeMCP — read-only bank connector",
    },
    clientRegistrationCallback({ clientMetadata }) {
      if (!clientMetadataIsSafe(clientMetadata)) {
        return { code: "invalid_client_metadata", description: "Client metadata did not pass BankCafeMCP safety limits.", status: 400 };
      }
    },
    onError(error) {
      logEvent("warn", "bank_oauth_error", { code: error.code, status: error.status, category: error.internal?.category });
    },
  });
}

export function bankAuthorizationMetadata(env: BankEnvironment): Response {
  const issuer = `${env.PUBLIC_ORIGIN}${env.BASE_PATH}`;
  return Response.json({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    revocation_endpoint: `${issuer}/token`,
    scopes_supported: BANK_SCOPES,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
    code_challenge_methods_supported: ["S256"],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
  }, { headers: { "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" } });
}

export async function handleBankRequest(
  request: Request,
  env: CafeEnvironment & BankBindings,
  ctx: ExecutionContext,
): Promise<Response> {
  const bankEnv = bankEnvironment(env);
  const pathname = new URL(request.url).pathname.replace(/\/$/u, "");
  if (pathname === `/.well-known/oauth-authorization-server${bankEnv.BASE_PATH}`) {
    return request.method === "GET"
      ? bankAuthorizationMetadata(bankEnv)
      : new Response(null, { status: 405, headers: { Allow: "GET" } });
  }
  return createBankProvider(bankEnv).fetch(request, bankEnv, ctx);
}
