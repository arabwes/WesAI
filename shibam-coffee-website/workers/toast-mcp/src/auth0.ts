import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { constantTimeEqual, randomToken, sha256 } from "./crypto";
import { createSession, upsertIdentityAndEnsureOrganization } from "./db";
import { CafeError } from "./errors";
import {
  csrfCookie,
  parseCookies,
  safeReturnPath,
  sessionCookie,
} from "./security";
import type { CafeEnvironment, IdentityClaims } from "./runtime";

const AUTH_FLOW_TTL_SECONDS = 600;
const AUTH_FLOW_PREFIX = "auth0-flow:";
const AUTH_STATE_COOKIE = "__Host-cafe_auth_state";

const tokenResponseSchema = z.object({
  access_token: z.string(),
  id_token: z.string(),
  token_type: z.string(),
});

interface AuthFlow {
  kind: "portal" | "mcp";
  returnTo: string;
  codeVerifier: string;
  nonce: string;
  oauthRequest?: AuthRequest;
}

function auth0Issuer(env: CafeEnvironment): URL {
  const domain = env.AUTH0_DOMAIN.trim().replace(/^https?:\/\//u, "").replace(/\/$/u, "");
  if (!domain || domain.includes("/") || domain.includes("@")) {
    throw new CafeError("INTERNAL_ERROR", "Auth0 is not configured.", 500);
  }
  return new URL(`https://${domain}/`);
}

function authStateCookie(value: string, maxAge: number): string {
  return `${AUTH_STATE_COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function clearAuthStateCookie(): string {
  return `${AUTH_STATE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

export async function beginAuth0Login(
  env: CafeEnvironment,
  options: { kind: "portal" | "mcp"; returnTo?: string | null; oauthRequest?: AuthRequest },
): Promise<Response> {
  if (env.AUTH0_DOMAIN.startsWith("SET_") || env.AUTH0_CLIENT_ID.startsWith("SET_")) {
    throw new CafeError("INTERNAL_ERROR", "Auth0 must be configured before sign-in is available.", 503);
  }
  const state = randomToken();
  const codeVerifier = randomToken(48);
  const nonce = randomToken();
  const flow: AuthFlow = {
    kind: options.kind,
    returnTo: safeReturnPath(options.returnTo ?? null, env.BASE_PATH),
    codeVerifier,
    nonce,
  };
  if (options.oauthRequest) flow.oauthRequest = options.oauthRequest;
  await env.OAUTH_KV.put(`${AUTH_FLOW_PREFIX}${state}`, JSON.stringify(flow), {
    expirationTtl: AUTH_FLOW_TTL_SECONDS,
  });

  const issuer = auth0Issuer(env);
  const redirectUri = `${env.PUBLIC_ORIGIN}${env.BASE_PATH}/auth/callback`;
  const authorize = new URL("authorize", issuer);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", env.AUTH0_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("scope", env.AUTH0_SCOPE);
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("nonce", nonce);
  authorize.searchParams.set("code_challenge", await sha256(codeVerifier));
  authorize.searchParams.set("code_challenge_method", "S256");

  return new Response(null, {
    status: 302,
    headers: {
      Location: authorize.toString(),
      "Set-Cookie": authStateCookie(state, AUTH_FLOW_TTL_SECONDS),
      "Cache-Control": "no-store",
    },
  });
}

async function verifyAuth0Identity(env: CafeEnvironment, idToken: string, nonce: string): Promise<IdentityClaims> {
  const issuer = auth0Issuer(env);
  const jwks = createRemoteJWKSet(new URL(".well-known/jwks.json", issuer));
  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: issuer.toString(),
    audience: env.AUTH0_CLIENT_ID,
  });
  if (payload.nonce !== nonce) throw new CafeError("AUTH_REQUIRED", "The Auth0 nonce is invalid.", 401);
  const parsed = z
    .object({
      sub: z.string().min(1),
      email: z.string().email(),
      email_verified: z.boolean(),
      name: z.string().nullable().optional(),
    })
    .safeParse(payload);
  if (!parsed.success) throw new CafeError("AUTH_REQUIRED", "Auth0 did not return a verified email identity.", 401);
  return {
    sub: parsed.data.sub,
    email: parsed.data.email,
    emailVerified: parsed.data.email_verified,
    name: parsed.data.name ?? null,
  };
}

export async function handleAuth0Callback(env: CafeEnvironment, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  const cookieState = decodeURIComponent(parseCookies(request).get(AUTH_STATE_COOKIE) ?? "");
  if (!state || !code || !cookieState || !(await constantTimeEqual(state, cookieState))) {
    throw new CafeError("AUTH_REQUIRED", "The Auth0 login state is invalid or expired.", 401);
  }

  const rawFlow = await env.OAUTH_KV.get(`${AUTH_FLOW_PREFIX}${state}`);
  if (!rawFlow) throw new CafeError("AUTH_REQUIRED", "The Auth0 login state has expired.", 401);
  const flow = JSON.parse(rawFlow) as AuthFlow;
  const issuer = auth0Issuer(env);
  const tokenResponse = await fetch(new URL("oauth/token", issuer), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: env.AUTH0_CLIENT_ID,
      client_secret: env.AUTH0_CLIENT_SECRET,
      code,
      code_verifier: flow.codeVerifier,
      redirect_uri: `${env.PUBLIC_ORIGIN}${env.BASE_PATH}/auth/callback`,
    }),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!tokenResponse.ok) {
    throw new CafeError("AUTH_REQUIRED", "Auth0 could not complete sign-in.", 401);
  }
  const tokens = tokenResponseSchema.safeParse(await tokenResponse.json());
  if (!tokens.success) throw new CafeError("AUTH_REQUIRED", "Auth0 returned an invalid token response.", 401);

  const claims = await verifyAuth0Identity(env, tokens.data.id_token, flow.nonce);
  const identity = await upsertIdentityAndEnsureOrganization(env, claims);
  const session = await createSession(env, identity.userId, identity.organizationId);
  const ttl = Number.parseInt(env.SESSION_TTL_SECONDS, 10);
  const headers = new Headers({ "Cache-Control": "no-store" });
  headers.append("Set-Cookie", sessionCookie(session.sessionToken, ttl));
  headers.append("Set-Cookie", csrfCookie(session.csrfToken, ttl));
  headers.append("Set-Cookie", clearAuthStateCookie());

  if (flow.kind === "mcp" && flow.oauthRequest) {
    const resumeId = randomToken();
    await env.OAUTH_KV.put(
      `mcp-consent:${resumeId}`,
      JSON.stringify({ oauthRequest: flow.oauthRequest }),
      { expirationTtl: AUTH_FLOW_TTL_SECONDS },
    );
    headers.set("Location", `${env.BASE_PATH}/authorize?resume=${encodeURIComponent(resumeId)}`);
  } else {
    headers.set("Location", flow.returnTo);
  }
  await env.OAUTH_KV.delete(`${AUTH_FLOW_PREFIX}${state}`);
  return new Response(null, { status: 302, headers });
}

export async function storeConsentRequest(env: CafeEnvironment, oauthRequest: AuthRequest): Promise<string> {
  const resumeId = randomToken();
  await env.OAUTH_KV.put(`mcp-consent:${resumeId}`, JSON.stringify({ oauthRequest }), {
    expirationTtl: AUTH_FLOW_TTL_SECONDS,
  });
  return resumeId;
}

export async function loadConsentRequest(env: CafeEnvironment, resumeId: string): Promise<AuthRequest> {
  const raw = await env.OAUTH_KV.get(`mcp-consent:${resumeId}`);
  if (!raw) throw new CafeError("AUTH_REQUIRED", "The authorization request has expired.", 400);
  const parsed = JSON.parse(raw) as { oauthRequest?: AuthRequest };
  if (!parsed.oauthRequest) throw new CafeError("AUTH_REQUIRED", "The authorization request is invalid.", 400);
  return parsed.oauthRequest;
}

export async function deleteConsentRequest(env: CafeEnvironment, resumeId: string): Promise<void> {
  await env.OAUTH_KV.delete(`mcp-consent:${resumeId}`);
}

export function auth0LogoutUrl(env: CafeEnvironment): string {
  const logout = new URL("v2/logout", auth0Issuer(env));
  logout.searchParams.set("client_id", env.AUTH0_CLIENT_ID);
  logout.searchParams.set("returnTo", `${env.PUBLIC_ORIGIN}${env.BASE_PATH}/`);
  return logout.toString();
}
