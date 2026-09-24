import { afterEach, describe, expect, it, vi } from "vitest";
import { bankEnvironment, isBankPath } from "../src/bank/env";
import { accessTokenEnvironment, plaidError, verifyAndRotateAccessToken, type PlaidTransaction } from "../src/bank/plaid";
import { BANK_SCOPES, grantedBankScopes, isBankScope } from "../src/bank/scopes";
import { bankConnectionInputSchema, bankSecretAad } from "../src/bank/store";
import { assertTransactionWindow, filterTransactions, toPublicTransaction } from "../src/bank/transactions";
import { decryptValue, encryptValue } from "../src/crypto";
import { CafeError } from "../src/errors";
import { ALL_OAUTH_SCOPES, isSupportedOAuthScope } from "../src/scopes";

const toastKv = { name: "toast-kv" } as unknown as KVNamespace;
const bankKv = { name: "bank-kv" } as unknown as KVNamespace;
const baseEnv = {
  BASE_PATH: "/toast-mcp",
  BANK_BASE_PATH: "/bankcafemcp",
  BANK_MODE: "enabled",
  OAUTH_KV: toastKv,
  BANK_OAUTH_KV: bankKv,
  PUBLIC_ORIGIN: "https://shibamatlanta.com",
} as never;

const SANDBOX_TOKEN = "access-sandbox-de3ce8ef-33f8-452c-a685-8671031fc0f6";
const ROTATED_TOKEN = "access-sandbox-11111111-2222-4333-8444-555555555555";

function randomKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

function transaction(overrides: Partial<PlaidTransaction>): PlaidTransaction {
  return {
    account_id: "plaid-acct-1",
    amount: 12.5,
    iso_currency_code: "USD",
    date: "2026-09-01",
    name: "COFFEE SUPPLIER INC",
    merchant_name: "Coffee Supplier",
    pending: false,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BankCafeMCP isolation from Toast", () => {
  it("routes only bank paths to the bank provider", () => {
    expect(isBankPath("/bankcafemcp", baseEnv)).toBe(true);
    expect(isBankPath("/bankcafemcp/mcp", baseEnv)).toBe(true);
    expect(isBankPath("/.well-known/oauth-protected-resource/bankcafemcp/mcp", baseEnv)).toBe(true);
    expect(isBankPath("/.well-known/oauth-authorization-server/bankcafemcp", baseEnv)).toBe(true);
    expect(isBankPath("/bankcafemcpx", baseEnv)).toBe(false);
    expect(isBankPath("/toast-mcp/mcp", baseEnv)).toBe(false);
    expect(isBankPath("/.well-known/oauth-protected-resource/toast-mcp/mcp", baseEnv)).toBe(false);
    expect(isBankPath("/bankcafemcp", { BASE_PATH: "/toast-mcp" } as never)).toBe(false);
  });

  it("gives the bank provider its own OAuth KV and base path without mutating the Toast env", () => {
    const env = { ...(baseEnv as Record<string, unknown>) };
    const bank = bankEnvironment(env as never);
    expect(bank.OAUTH_KV).toBe(bankKv);
    expect(bank.BASE_PATH).toBe("/bankcafemcp");
    expect(env.OAUTH_KV).toBe(toastKv);
    expect(env.BASE_PATH).toBe("/toast-mcp");
  });

  it("never inherits the Toast provider's OAuth helpers from the shared env object", () => {
    const toastHelpers = { name: "toast-helpers" };
    const bank = bankEnvironment({ ...(baseEnv as object), OAUTH_PROVIDER: toastHelpers } as never);
    expect("OAUTH_PROVIDER" in bank).toBe(false);
  });

  it("refuses to run without a separate bank KV namespace", () => {
    expect(() => bankEnvironment({ ...(baseEnv as object), BANK_OAUTH_KV: undefined } as never)).toThrow(/not configured/u);
    expect(() => bankEnvironment({ ...(baseEnv as object), BANK_OAUTH_KV: toastKv } as never)).toThrow(/own OAuth KV/u);
  });

  it("keeps bank and Toast scopes disjoint", () => {
    for (const scope of BANK_SCOPES) expect(isSupportedOAuthScope(scope)).toBe(false);
    for (const scope of ALL_OAUTH_SCOPES) expect(isBankScope(scope)).toBe(false);
  });
});

describe("bank consent", () => {
  it("grants only scopes that were both requested and explicitly ticked", () => {
    expect(grantedBankScopes(["bank/accounts:read", "bank/balances:read"], ["bank/balances:read", "bank/transactions:read", "toast/orders:read"]))
      .toEqual(["bank/balances:read"]);
    expect(grantedBankScopes(["bank/accounts:read"], [])).toEqual([]);
    expect(grantedBankScopes([], ["bank/accounts:read", "bank/transactions:read"])).toEqual(["bank/accounts:read"]);
  });
});

describe("Plaid client", () => {
  it("maps Plaid errors to stable codes without leaking Plaid messages", () => {
    const relink = plaidError(400, { error_code: "ITEM_LOGIN_REQUIRED", error_message: "secret detail acct 1234" });
    expect(relink.code).toBe("BANK_RELINK_REQUIRED");
    expect(relink.message).not.toContain("1234");
    expect(plaidError(400, { error_code: "INVALID_ACCESS_TOKEN" }).code).toBe("BANK_AUTH_FAILED");
    expect(plaidError(400, { error_code: "PRODUCT_NOT_READY" }).code).toBe("BANK_NOT_READY");
    expect(plaidError(429, null).code).toBe("BANK_RATE_LIMITED");
    expect(plaidError(500, "not json").code).toBe("BANK_UPSTREAM_ERROR");
  });

  it("recognizes access token environments", () => {
    expect(accessTokenEnvironment(SANDBOX_TOKEN)).toBe("sandbox");
    expect(accessTokenEnvironment(SANDBOX_TOKEN.replace("sandbox", "production"))).toBe("production");
    expect(accessTokenEnvironment("public-sandbox-de3ce8ef-33f8-452c-a685-8671031fc0f6")).toBeNull();
  });

  it("rejects a token for the wrong environment before calling Plaid", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(verifyAndRotateAccessToken(
      { environment: "production", clientId: "client123", clientSecret: "secret1234567890ab" },
      SANDBOX_TOKEN,
    )).rejects.toThrow(/sandbox access token/u);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("verifies, then rotates the pasted token and returns only the new one", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push({ url, body, headers: new Headers(init.headers) });
      if (url.endsWith("/accounts/get")) {
        return Response.json({
          accounts: [{ account_id: "plaid-acct-1", name: "Checking", mask: "0000", type: "depository", subtype: "checking",
            balances: { current: 100, available: 90, iso_currency_code: "USD" } }],
          item: { item_id: "item-1", institution_name: "Test Bank" },
        });
      }
      if (url.endsWith("/item/access_token/invalidate")) return Response.json({ new_access_token: ROTATED_TOKEN });
      return new Response("{}", { status: 404 });
    }));
    const result = await verifyAndRotateAccessToken(
      { environment: "sandbox", clientId: "client123", clientSecret: "secret1234567890ab" },
      SANDBOX_TOKEN,
    );
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual(["/accounts/get", "/item/access_token/invalidate"]);
    expect(calls.every((call) => call.url.startsWith("https://sandbox.plaid.com/"))).toBe(true);
    expect(calls[0]?.headers.get("PLAID-CLIENT-ID")).toBe("client123");
    expect(result.accessToken).toBe(ROTATED_TOKEN);
    expect(JSON.stringify(result)).not.toContain(SANDBOX_TOKEN);
    expect(result.institutionName).toBe("Test Bank");
    expect(result.accounts).toHaveLength(1);
  });

  it("does not return a token when Plaid refuses the pasted one", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error_code: "INVALID_ACCESS_TOKEN" }, { status: 400 })));
    await expect(verifyAndRotateAccessToken(
      { environment: "sandbox", clientId: "client123", clientSecret: "secret1234567890ab" },
      SANDBOX_TOKEN,
    )).rejects.toMatchObject({ code: "BANK_AUTH_FAILED" });
  });
});

describe("bank credential storage", () => {
  it("binds each ciphertext to its organization, connection, and field", async () => {
    const key = randomKey();
    const encrypted = await encryptValue("the-secret", key, bankSecretAad("org_a", "bcn_1", "client_secret"));
    await expect(decryptValue(encrypted, key, bankSecretAad("org_a", "bcn_1", "client_secret"))).resolves.toBe("the-secret");
    await expect(decryptValue(encrypted, key, bankSecretAad("org_a", "bcn_1", "access_token"))).rejects.toBeInstanceOf(CafeError);
    await expect(decryptValue(encrypted, key, bankSecretAad("org_b", "bcn_1", "client_secret"))).rejects.toBeInstanceOf(CafeError);
    await expect(decryptValue(encrypted, key, bankSecretAad("org_a", "bcn_2", "client_secret"))).rejects.toBeInstanceOf(CafeError);
  });

  it("validates connection input before any network call", () => {
    const valid = { label: "Checking", environment: "sandbox", clientId: "abcdef123456", clientSecret: "abcdef1234567890abcdef", accessToken: SANDBOX_TOKEN };
    expect(bankConnectionInputSchema.safeParse(valid).success).toBe(true);
    expect(bankConnectionInputSchema.safeParse({ ...valid, environment: "development" }).success).toBe(false);
    expect(bankConnectionInputSchema.safeParse({ ...valid, clientSecret: "short" }).success).toBe(false);
    expect(bankConnectionInputSchema.safeParse({ ...valid, clientId: "bad id!" }).success).toBe(false);
  });
});

describe("transaction output", () => {
  it("never exposes Plaid identifiers and maps to internal account IDs", () => {
    const mapped = toPublicTransaction(transaction({}), new Map([["plaid-acct-1", "bac_1"]]));
    expect(mapped.account_id).toBe("bac_1");
    expect(JSON.stringify(mapped)).not.toContain("plaid-acct-1");
    expect(Object.keys(mapped)).not.toContain("transaction_id");
  });

  it("filters by direction, absolute amount, text, and pending state", () => {
    const rows = [
      transaction({ amount: 50, merchant_name: "Restaurant Depot" }),
      transaction({ amount: -2000, name: "TOAST DEPOSIT", merchant_name: null }),
      transaction({ amount: 5, pending: true, merchant_name: "Coffee Supplier" }),
    ];
    expect(filterTransactions(rows, { direction: "outflow", includePending: true })).toHaveLength(2);
    expect(filterTransactions(rows, { direction: "inflow", includePending: true })).toHaveLength(1);
    expect(filterTransactions(rows, { minAbsAmount: 100, includePending: true })[0]?.amount).toBe(-2000);
    expect(filterTransactions(rows, { text: "depot", includePending: true })).toHaveLength(1);
    expect(filterTransactions(rows, { includePending: false })).toHaveLength(2);
  });

  it("bounds the transaction date window", () => {
    const today = new Date("2026-09-24T12:00:00Z");
    expect(() => assertTransactionWindow("2026-09-01", "2026-09-20", today)).not.toThrow();
    expect(() => assertTransactionWindow("2026-09-20", "2026-09-01", today)).toThrow(/on or before/u);
    expect(() => assertTransactionWindow("2023-01-01", "2026-09-01", today)).toThrow(/730 days/u);
    expect(() => assertTransactionWindow("2026-09-01", "2026-12-01", today)).toThrow(/future/u);
  });
});
