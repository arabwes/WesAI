import { describe, expect, it } from "vitest";
import { constantTimeEqual, decryptValue, encryptValue, hmacSha256Base64, randomToken } from "../src/crypto";

const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

describe("encryption and signing", () => {
  it("round-trips AES-256-GCM with record-bound associated data", async () => {
    const encrypted = await encryptValue("one-time Toast secret", key, "toast-connection:org_1:con_1");
    expect(encrypted.ciphertext).not.toContain("one-time Toast secret");
    await expect(decryptValue(encrypted, key, "toast-connection:org_1:con_1")).resolves.toBe("one-time Toast secret");
    await expect(decryptValue(encrypted, key, "toast-connection:org_2:con_1")).rejects.toThrow();
  });

  it("uses unique nonces and stable constant-time comparisons", async () => {
    const first = await encryptValue("same", key, "record");
    const second = await encryptValue("same", key, "record");
    expect(first.nonce).not.toBe(second.nonce);
    await expect(constantTimeEqual("abc", "abc")).resolves.toBe(true);
    await expect(constantTimeEqual("abc", "abd")).resolves.toBe(false);
    expect(randomToken()).not.toBe(randomToken());
  });

  it("computes the Toast raw-body plus timestamp signature", async () => {
    const body = '{"timestamp":"2026-09-03T12:00:00.000Z"}';
    const signature = await hmacSha256Base64("secret", `${body}2026-09-03T12:00:00.000Z`);
    expect(signature).toMatch(/^[A-Za-z0-9+/]+=*$/u);
    await expect(constantTimeEqual(signature, signature)).resolves.toBe(true);
  });
});
