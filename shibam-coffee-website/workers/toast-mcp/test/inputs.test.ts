import { describe, expect, it } from "vitest";
import { connectionInputSchema } from "../src/connections";

describe("Toast connection input", () => {
  it("accepts fixed environments and deduplicates restaurant GUIDs", () => {
    const guid = "00000000-1111-4222-8333-444444444444";
    const value = connectionInputSchema.parse({ label: "Main", environment: "sandbox", clientId: "client", clientSecret: "secret-value", restaurantGuids: [guid, guid] });
    expect(value.restaurantGuids).toEqual([guid]);
  });

  it("rejects arbitrary environments and non-GUID locations", () => {
    expect(() => connectionInputSchema.parse({ label: "Main", environment: "custom", clientId: "client", clientSecret: "secret-value", restaurantGuids: ["mine"] })).toThrow();
  });
});
