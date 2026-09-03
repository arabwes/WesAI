import { describe, expect, it } from "vitest";
import { membershipScopeCeiling } from "../src/db";

describe("membership OAuth scope ceiling", () => {
  it("gives owners Cafe scopes and only enabled Toast scopes", () => {
    expect(membershipScopeCeiling("owner", ["menus:read", "not-real"])).toEqual([
      "cafe/catalog:read",
      "cafe/locations:read",
      "cafe/results:read",
      "toast/menus:read",
    ]);
  });

  it("preserves explicitly granted Cafe scopes for members", () => {
    expect(membershipScopeCeiling("member", ["menus:read"], [
      "cafe/catalog:read",
      "cafe/locations:read",
      "toast/menus:read",
      "toast/orders:read",
    ])).toEqual(["cafe/catalog:read", "cafe/locations:read", "toast/menus:read"]);
  });
});
