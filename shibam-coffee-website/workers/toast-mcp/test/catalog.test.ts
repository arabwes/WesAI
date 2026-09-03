import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { getOperation, listCatalog, searchOperations } from "../src/toast/operations";

describe("reviewed Toast operation manifest", () => {
  it("classifies every discovered operation and excludes mutating methods", async () => {
    const review = JSON.parse(await readFile(new URL("../catalog/operation-review.json", import.meta.url), "utf8")) as Array<Record<string, unknown>>;
    expect(review).toHaveLength(100);
    expect(review.every((operation) => ["exposed", "excluded"].includes(String(operation.classification)))).toBe(true);
    const exposed = review.filter((operation) => operation.classification === "exposed");
    expect(exposed).toHaveLength(75);
    expect(exposed.every((operation) => operation.method === "GET" || (operation.method === "POST" && operation.reviewedReadOnlyPost === true))).toBe(true);
    expect(exposed.every((operation) => String(operation.path).split("/").length >= 3)).toBe(true);
    expect(review.filter((operation) => operation.classification === "excluded").every((operation) => typeof operation.exclusionReason === "string")).toBe(true);
  });

  it("allows only the explicitly reviewed read-only POST operations", () => {
    const posts = listCatalog().filter((operation) => operation.method === "POST").map((operation) => operation.id).sort();
    expect(posts).toEqual(["orders_applicableDiscountsPost", "orders_pricesPost", "stock_postInventorySearch"]);
    expect(listCatalog().some((operation) => /\/menus\/v3(?:\/|$)/u.test(operation.path))).toBe(false);
    expect(listCatalog().some((operation) => /\/payments(?:\/|$)/u.test(operation.path))).toBe(false);
    expect(getOperation("kitchen_itemFulfillmentsGet")).toEqual(expect.objectContaining({ sensitivity: "orders", persistable: false }));
  });

  it("filters catalog search by the effective OAuth scope", () => {
    const permittedScopes = new Set(["toast/menus:read"]);
    const found = searchOperations({ text: "menu", permittedScopes, limit: 100 });
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((operation) => operation.requiredScope === "menus:read")).toBe(true);
    expect(getOperation("orders_ordersPost")).toBeNull();
    expect(searchOperations({ scope: "toast/menus:read", permittedScopes, limit: 100 }).length).toBe(found.length);
  });
});
