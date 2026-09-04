import { describe, expect, it } from "vitest";
import { CafeError, toPublicError } from "../src/errors";
import { applyResponsePolicy } from "../src/data-policy";
import { splitUtf8Fragments } from "../src/results";
import { storeOversizedResult } from "../src/results";
import { intersectAuthorizationScopes, isSensitiveOAuthScope } from "../src/scopes";
import { assertAllowedHost, assertSameOrigin, clearCsrfCookie, csrfCookie, safeReturnPath, withSecurityHeaders } from "../src/security";
import { minimumToastRequestIntervalMs } from "../src/toast/client";

describe("authorization and data safety", () => {
  it("computes the three-way scope intersection", () => {
    const result = intersectAuthorizationScopes(
      new Set(["cafe/catalog:read", "toast/orders:read", "toast/guest.pi:read"]),
      new Set(["cafe/catalog:read", "toast/orders:read"]),
      ["cafe/catalog:read", "toast/orders:read", "toast/guest.pi:read", "toast/labor:read"],
    );
    expect([...result]).toEqual(["cafe/catalog:read", "toast/orders:read"]);
    expect(isSensitiveOAuthScope("toast/guest.pi:read")).toBe(true);
  });

  it("rejects open redirects and applies no-index/no-store headers", () => {
    expect(safeReturnPath("https://evil.example/", "/toast-mcp")).toBe("/toast-mcp/");
    expect(safeReturnPath("//evil.example", "/toast-mcp")).toBe("/toast-mcp/");
    expect(safeReturnPath("/toast-mcp/settings", "/toast-mcp")).toBe("/toast-mcp/settings");
    const response = withSecurityHeaders(new Response("ok"));
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Robots-Tag")).toContain("noindex");
    expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(() => assertAllowedHost(new Request("https://evil.example/toast-mcp/"), {
      PUBLIC_ORIGIN: "https://shibamatlanta.com",
    } as never)).toThrow(/Not found/u);
    expect(() => assertSameOrigin(new Request("https://shibamatlanta.com/toast-mcp/api/me", {
      headers: { Origin: "http://localhost:3000" },
    }), { PUBLIC_ORIGIN: "https://shibamatlanta.com" } as never)).toThrow(/origin/u);
    expect(() => assertSameOrigin(new Request("http://127.0.0.1:8791/toast-mcp/api/me", {
      headers: { Origin: "http://localhost:3000" },
    }), { PUBLIC_ORIGIN: "https://shibamatlanta.com" } as never)).not.toThrow();
    expect(() => assertSameOrigin(new Request("https://shibamatlanta.com/toast-mcp/auth/logout", {
      method: "POST",
      headers: { Origin: "null", "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "navigate" },
    }), { PUBLIC_ORIGIN: "https://shibamatlanta.com" } as never)).not.toThrow();
    expect(() => assertSameOrigin(new Request("https://shibamatlanta.com/toast-mcp/auth/logout", {
      method: "POST",
      headers: { Origin: "null", "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate" },
    }), { PUBLIC_ORIGIN: "https://shibamatlanta.com" } as never)).toThrow(/origin/u);
  });

  it("issues the callback CSRF cookie with Lax same-site handling", () => {
    expect(csrfCookie("token", 600)).toContain("SameSite=Lax");
    expect(clearCsrfCookie()).toContain("SameSite=Lax");
  });

  it("chunks UTF-8 without corrupting multi-byte characters", () => {
    const original = `${"coffee☕".repeat(100)}done`;
    const chunks = splitUtf8Fragments(original, 31);
    expect(chunks.join("")).toBe(original);
    expect(chunks.every((chunk) => new TextEncoder().encode(chunk).byteLength <= 31)).toBe(true);
  });

  it("applies endpoint-specific conservative Toast pacing", () => {
    expect(minimumToastRequestIntervalMs({ id: "menus_menusGet", path: "/menus/v2/menus" }, {})).toBe(1_000);
    expect(minimumToastRequestIntervalMs(
      { id: "orders_ordersBulkGet", path: "/orders/v2/ordersBulk" },
      { startDate: "2026-09-03T00:00:00.000Z" },
    )).toBe(5_000);
    expect(minimumToastRequestIntervalMs({ id: "restaurants_get", path: "/restaurants/v1/restaurants/{guid}" }, {})).toBe(100);
  });

  it("returns stable sanitized failures", () => {
    expect(toPublicError(new CafeError("LOCATION_DENIED", "No access", 403))).toEqual({ code: "LOCATION_DENIED", message: "No access" });
    expect(toPublicError(new Error("database details"))).toEqual({ code: "INTERNAL_ERROR", message: "Cafe MCP could not complete the request." });
  });

  it("does not persist an oversized result without result consent", async () => {
    const operation = {
      id: "menus_test", domain: "menus", method: "GET", path: "/menus/v2/menus", description: "test",
      requiredScope: "menus:read", additionalScopes: [], sensitivity: "operational", persistable: true,
      parameters: [], requestBody: false, bodyRequired: false, bodyRootType: null, bodyRequiredProperties: [], pagination: "none", source: "menus",
    } as const;
    await expect(storeOversizedResult({} as never, {
      userId: "usr_1", organizationId: "org_1", membershipId: "mem_1", role: "owner",
      scopes: new Set(["toast/menus:read"]), locationIds: null, sensitivePiiEnabled: false,
    }, operation, "loc_1", {})).rejects.toMatchObject({ code: "SCOPE_DENIED" });
  });

  it("redacts order PII unless both sensitive permissions are in the effective intersection", () => {
    const operation = {
      id: "orders_test", domain: "orders", method: "GET", path: "/orders/v2/orders", description: "test",
      requiredScope: "orders:read", additionalScopes: [], sensitivity: "orders", persistable: false,
      parameters: [], requestBody: false, bodyRequired: false, bodyRootType: null, bodyRequiredProperties: [], pagination: "none", source: "orders",
    } as const;
    const input = { guid: "order", customer: { firstName: "Ada", email: "ada@example.com" }, deliveryInfo: { address1: "1 Main" }, total: 12 };
    expect(applyResponsePolicy(input, operation, new Set(["toast/orders:read"]))).toEqual({ guid: "order", total: 12 });
    expect(applyResponsePolicy(input, operation, new Set(["toast/orders:read", "toast/guest.pi:read", "toast/delivery_info.address:read"]))).toBe(input);
  });
});
