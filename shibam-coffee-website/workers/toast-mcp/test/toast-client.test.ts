import { describe, expect, it } from "vitest";
import { buildOperationUrl } from "../src/toast/client";
import type { CatalogOperation } from "../src/toast/operations";

const operation = {
  id: "test_read",
  domain: "config",
  method: "GET",
  path: "/config/v2/menuItems/{guid}",
  description: "test",
  requiredScope: "config:read",
  additionalScopes: [],
  sensitivity: "operational",
  persistable: true,
  parameters: [
    { name: "guid", in: "path", required: true, type: "string", description: "" },
    { name: "page", in: "query", required: false, type: "integer", description: "" },
  ],
  requestBody: false,
  bodyRequired: false,
  bodyRootType: null,
  bodyRequiredProperties: [],
  pagination: "parameterized",
  source: "config",
} as const satisfies CatalogOperation;

describe("Toast request URL construction", () => {
  it("uses only the fixed Toast host and reviewed path", () => {
    const url = buildOperationUrl("production", operation, { guid: "../../other?x=1" }, { page: 2 });
    expect(url.origin).toBe("https://ws-api.toasttab.com");
    expect(url.pathname).toBe("/config/v2/menuItems/..%2F..%2Fother%3Fx%3D1");
    expect(url.search).toBe("?page=2");
  });

  it("rejects missing, extra, and incorrectly typed parameters", () => {
    expect(() => buildOperationUrl("production", operation, {}, {})).toThrow(/Missing path parameter/u);
    expect(() => buildOperationUrl("production", operation, { guid: "x", extra: "y" }, {})).toThrow(/Unsupported path/u);
    expect(() => buildOperationUrl("production", operation, { guid: "x" }, { page: 1.5 })).toThrow(/Invalid value/u);
    expect(() => buildOperationUrl("production", operation, { guid: "x" }, { arbitrary: "yes" })).toThrow(/Unsupported query/u);
    expect(() => buildOperationUrl("production", { ...operation, path: "//evil.example/read" }, { guid: "x" }, {})).toThrow(/fixed Toast API host/u);
  });
});
