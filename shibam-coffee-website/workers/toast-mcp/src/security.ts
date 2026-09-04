import { CafeError } from "./errors";
import type { CafeEnvironment } from "./runtime";

const SAFE_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' https://*.auth0.com",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
};

export function withSecurityHeaders(response: Response, requestId?: string): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SAFE_HEADERS)) headers.set(name, value);
  if (requestId) headers.set("X-Request-Id", requestId);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function assertAllowedHost(request: Request, env: CafeEnvironment): void {
  const host = new URL(request.url).hostname.toLowerCase();
  const allowed = new URL(env.PUBLIC_ORIGIN).hostname.toLowerCase();
  if (host !== allowed && host !== "localhost" && host !== "127.0.0.1") {
    throw new CafeError("NOT_FOUND", "Not found.", 404);
  }
}

export function assertSameOrigin(request: Request, env: CafeEnvironment): void {
  const origin = request.headers.get("Origin");
  if (!origin) return;
  if (
    origin === "null"
    && request.headers.get("Sec-Fetch-Site") === "same-origin"
    && request.headers.get("Sec-Fetch-Mode") === "navigate"
  ) return;
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    throw new CafeError("CSRF_INVALID", "The request origin is not allowed.", 403);
  }
  const expected = new URL(env.PUBLIC_ORIGIN);
  const requestHost = new URL(request.url).hostname;
  const localHosts = ["localhost", "127.0.0.1"];
  const isLocalDevelopmentPair = localHosts.includes(requestHost) && localHosts.includes(originUrl.hostname);
  if (!isLocalDevelopmentPair && originUrl.origin !== expected.origin) {
    throw new CafeError("CSRF_INVALID", "The request origin is not allowed.", 403);
  }
}

export function safeReturnPath(value: string | null, basePath: string): string {
  if (!value) return `${basePath}/`;
  if (!value.startsWith(`${basePath}/`) || value.startsWith("//") || value.includes("\\")) {
    return `${basePath}/`;
  }
  return value;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function parseCookies(request: Request): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const segment of (request.headers.get("Cookie") ?? "").split(";")) {
    const separator = segment.indexOf("=");
    if (separator === -1) continue;
    const name = segment.slice(0, separator).trim();
    const value = segment.slice(separator + 1).trim();
    if (name) cookies.set(name, value);
  }
  return cookies;
}

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `__Host-cafe_mcp_session=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

export function csrfCookie(token: string, maxAgeSeconds: number): string {
  return `__Host-cafe_mcp_csrf=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAgeSeconds}; Secure; SameSite=Lax`;
}

export function clearSessionCookie(): string {
  return "__Host-cafe_mcp_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax";
}

export function clearCsrfCookie(): string {
  return "__Host-cafe_mcp_csrf=; Path=/; Max-Age=0; Secure; SameSite=Lax";
}

export function jsonResponse(data: unknown, status = 200, headers?: HeadersInit): Response {
  const outputHeaders = new Headers(headers);
  outputHeaders.set("Content-Type", "application/json; charset=utf-8");
  outputHeaders.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(data), { status, headers: outputHeaders });
}

export function htmlResponse(html: string, status = 200, headers?: HeadersInit): Response {
  const outputHeaders = new Headers(headers);
  outputHeaders.set("Content-Type", "text/html; charset=utf-8");
  outputHeaders.set("Cache-Control", "no-store");
  return new Response(html, { status, headers: outputHeaders });
}

export function logEvent(
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, string | number | boolean | null | undefined> = {},
): void {
  const payload = JSON.stringify({ level, event, timestamp: new Date().toISOString(), ...fields });
  if (level === "error") console.error(payload);
  else if (level === "warn") console.warn(payload);
  else console.log(payload);
}
