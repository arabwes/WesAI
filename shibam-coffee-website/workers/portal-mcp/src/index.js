// Shibam Coffee Portal MCP: a read-only MCP connector for the team portal.
//   MCP endpoint:  https://shibamatlanta.com/portal-mcp/mcp
//   Sign in:       /portal-mcp/authorize  (portal username + password, then consent)
//   Connected apps:/portal-mcp/connections (open from the portal while signed in)
// OAuth (client registration, PKCE, tokens) is handled by Cloudflare's OAuth provider, the same
// library the Toast connector uses. Each MCP call reloads the person from the portal database.
import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { createMcpHandler } from 'agents/mcp/server';
import { createPortalMcpServer } from './mcp.js';
import { handleAuthorize, handleConnections, infoPage, SCOPE } from './pages.js';

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-Robots-Tag': 'noindex, nofollow, noarchive'
};

function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) if (!headers.has(name)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function clientMetadataIsSafe(metadata) {
  if (metadata.software_statement !== undefined) return false;
  if (typeof metadata.client_name === 'string' && metadata.client_name.length > 100) return false;
  if (Array.isArray(metadata.redirect_uris) && metadata.redirect_uris.length > 10) return false;
  if (Array.isArray(metadata.contacts) && metadata.contacts.length > 5) return false;
  for (const field of ['client_uri', 'logo_uri', 'tos_uri', 'policy_uri']) {
    const value = metadata[field];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length > 500) return false;
    try { if (new URL(value).protocol !== 'https:') return false; } catch { return false; }
  }
  return true;
}

export class McpApiHandler extends WorkerEntrypoint {
  async fetch(request) {
    const host = new URL(this.env.PUBLIC_ORIGIN).hostname;
    const handler = createMcpHandler(() => createPortalMcpServer(this.env), {
      route: `${this.env.BASE_PATH}/mcp`,
      authContext: { props: this.ctx.props },
      allowedHostnames: [host],
      allowedOriginHostnames: [host],
      corsOptions: false,
      onerror: (error) => console.error(JSON.stringify({ event: 'mcp_transport_error', message: error.message }))
    });
    const match = request.headers.get('Authorization')?.match(/^Bearer\s+(.+)$/i);
    if (!match?.[1]) return new Response('Unauthorized', { status: 401 });
    const summary = await this.env.OAUTH_PROVIDER.unwrapToken(match[1]);
    if (!summary) return new Response('Unauthorized', { status: 401 });
    return handler.fetch(request, {
      authInfo: {
        token: match[1],
        clientId: summary.grant.clientId,
        scopes: summary.scope,
        expiresAt: summary.expiresAt,
        resource: new URL(`${this.env.PUBLIC_ORIGIN}${this.env.BASE_PATH}/mcp`)
      }
    });
  }
}

const defaultHandler = {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname.replace(/\/$/, '');
    if (pathname === `${env.BASE_PATH}/authorize`) return handleAuthorize(env, request);
    if (pathname === `${env.BASE_PATH}/connections`) return handleConnections(env, request);
    if (pathname === env.BASE_PATH) return infoPage(env);
    if (pathname === `${env.BASE_PATH}/healthz`) return Response.json({ ok: true });
    return new Response('Not found', { status: 404 });
  }
};

function createProvider(env) {
  return new OAuthProvider({
    apiRoute: `${env.BASE_PATH}/mcp`,
    apiHandler: McpApiHandler,
    defaultHandler,
    authorizeEndpoint: `${env.BASE_PATH}/authorize`,
    tokenEndpoint: `${env.BASE_PATH}/token`,
    clientRegistrationEndpoint: `${env.BASE_PATH}/register`,
    accessTokenTTL: 3600,
    refreshTokenTTL: 30 * 24 * 60 * 60,
    clientRegistrationTTL: 90 * 24 * 60 * 60,
    scopesSupported: [SCOPE],
    allowImplicitFlow: false,
    allowPlainPKCE: false,
    allowTokenExchangeGrant: false,
    clientIdMetadataDocumentEnabled: true,
    resourceMetadata: {
      resource: `${env.PUBLIC_ORIGIN}${env.BASE_PATH}/mcp`,
      authorization_servers: [`${env.PUBLIC_ORIGIN}${env.BASE_PATH}`],
      scopes_supported: [SCOPE],
      bearer_methods_supported: ['header'],
      resource_name: 'Shibam Coffee team portal (read-only)'
    },
    clientRegistrationCallback({ clientMetadata }) {
      if (!clientMetadataIsSafe(clientMetadata)) {
        return { code: 'invalid_client_metadata', description: 'Client metadata did not pass safety limits.', status: 400 };
      }
    },
    onError(error) {
      console.warn(JSON.stringify({ event: 'oauth_error', code: error.code, status: error.status }));
    }
  });
}

function authorizationMetadata(env) {
  const base = `${env.PUBLIC_ORIGIN}${env.BASE_PATH}`;
  return Response.json({
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    revocation_endpoint: `${base}/token`,
    scopes_supported: [SCOPE],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
    code_challenge_methods_supported: ['S256'],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true
  }, { headers: { 'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*' } });
}

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const allowed = new URL(env.PUBLIC_ORIGIN).hostname;
      if (![allowed, 'localhost', '127.0.0.1'].includes(url.hostname)) return new Response('Not found', { status: 404 });
      const pathname = url.pathname.replace(/\/$/, '');
      if (pathname === `/.well-known/oauth-authorization-server${env.BASE_PATH}`) {
        return withSecurityHeaders(request.method === 'GET' ? authorizationMetadata(env) : new Response(null, { status: 405, headers: { Allow: 'GET' } }));
      }
      // Someone opening the connector address in a browser gets an explanation instead of a bare
      // "401". Only a browser page load matches (no token, asks for HTML, a navigation); AI apps
      // never send that, so what they see is unchanged.
      if (pathname === `${env.BASE_PATH}/mcp` && request.method === 'GET' && !request.headers.has('Authorization')
        && (request.headers.get('Accept') || '').includes('text/html') && request.headers.get('Sec-Fetch-Mode') === 'navigate') {
        return withSecurityHeaders(infoPage(env));
      }
      return withSecurityHeaders(await createProvider(env).fetch(request, env, ctx));
    } catch (error) {
      console.error(JSON.stringify({ event: 'request_failed', message: String(error?.message || error).slice(0, 300) }));
      return withSecurityHeaders(new Response('Something went wrong.', { status: 500 }));
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(createProvider(env).purgeExpiredData(env, { batchSize: 100 }).then(() => undefined));
  }
};
