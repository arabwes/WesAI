import { z } from "zod";
import { CafeError } from "../errors";
import { logEvent } from "../security";

export type PlaidEnvironment = "sandbox" | "production";

const PLAID_HOSTS: Record<PlaidEnvironment, string> = {
  sandbox: "https://sandbox.plaid.com",
  production: "https://production.plaid.com",
};
const PLAID_API_VERSION = "2020-09-14";
const PLAID_PAGE_SIZE = 500;
const ACCESS_TOKEN_PATTERN = /^access-(sandbox|production)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface PlaidAppCredentials {
  environment: PlaidEnvironment;
  clientId: string;
  clientSecret: string;
}

export interface PlaidItemCredentials extends PlaidAppCredentials {
  accessToken: string;
}

const accountSchema = z.object({
  account_id: z.string().min(1),
  name: z.string(),
  official_name: z.string().nullable().optional(),
  mask: z.string().nullable().optional(),
  type: z.string().nullable().optional(),
  subtype: z.string().nullable().optional(),
  balances: z.object({
    available: z.number().nullable().optional(),
    current: z.number().nullable().optional(),
    limit: z.number().nullable().optional(),
    iso_currency_code: z.string().nullable().optional(),
    unofficial_currency_code: z.string().nullable().optional(),
    last_updated_datetime: z.string().nullable().optional(),
  }),
});

const accountsResponseSchema = z.object({
  accounts: z.array(accountSchema),
  item: z.object({
    institution_name: z.string().nullable().optional(),
  }),
});

const transactionSchema = z.object({
  account_id: z.string(),
  amount: z.number(),
  iso_currency_code: z.string().nullable().optional(),
  unofficial_currency_code: z.string().nullable().optional(),
  date: z.string(),
  authorized_date: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  merchant_name: z.string().nullable().optional(),
  pending: z.boolean(),
  payment_channel: z.string().nullable().optional(),
  personal_finance_category: z.object({
    primary: z.string(),
    detailed: z.string(),
  }).nullable().optional(),
});

const transactionsResponseSchema = z.object({
  transactions: z.array(transactionSchema),
  total_transactions: z.number().int().nonnegative(),
});

const invalidateResponseSchema = z.object({ new_access_token: z.string() });

const plaidErrorSchema = z.object({
  error_type: z.string().optional(),
  error_code: z.string().optional(),
});

export type PlaidAccount = z.infer<typeof accountSchema>;
export type PlaidTransaction = z.infer<typeof transactionSchema>;

export function accessTokenEnvironment(token: string): PlaidEnvironment | null {
  const match = ACCESS_TOKEN_PATTERN.exec(token);
  return match ? (match[1]!.toLowerCase() as PlaidEnvironment) : null;
}

const RELINK_CODES = new Set([
  "ITEM_LOGIN_REQUIRED",
  "PENDING_EXPIRATION",
  "PENDING_DISCONNECT",
  "ACCESS_NOT_GRANTED",
  "ADDITIONAL_CONSENT_REQUIRED",
  "ITEM_NOT_FOUND",
  "NO_ACCOUNTS",
]);
const AUTH_CODES = new Set(["INVALID_API_KEYS", "INVALID_ACCESS_TOKEN", "UNAUTHORIZED_ENVIRONMENT", "INVALID_PRODUCT"]);

/** Maps a Plaid error to a stable public error. Plaid's own messages are never surfaced. */
export function plaidError(status: number, body: unknown): CafeError {
  const parsed = plaidErrorSchema.safeParse(body);
  const code = parsed.success ? parsed.data.error_code ?? "" : "";
  const type = parsed.success ? parsed.data.error_type ?? "" : "";
  if (RELINK_CODES.has(code)) {
    return new CafeError("BANK_RELINK_REQUIRED", "The bank connection needs to be re-authorized with the bank through Plaid.", 409);
  }
  if (AUTH_CODES.has(code)) {
    return new CafeError("BANK_AUTH_FAILED", "Plaid rejected the stored credentials.", 401);
  }
  if (code === "PRODUCT_NOT_READY") {
    return new CafeError("BANK_NOT_READY", "Plaid is still preparing this data. Try again in a minute.", 503, 60);
  }
  if (type === "RATE_LIMIT_EXCEEDED" || status === 429) {
    return new CafeError("BANK_RATE_LIMITED", "Plaid rate limit reached. Try again shortly.", 429, 60);
  }
  return new CafeError("BANK_UPSTREAM_ERROR", "Plaid could not complete the request.", 502);
}

async function plaidPost<T>(
  app: PlaidAppCredentials,
  path: string,
  body: Record<string, unknown>,
  schema: z.ZodType<T>,
): Promise<T> {
  const host = PLAID_HOSTS[app.environment];
  if (!host) throw new CafeError("VALIDATION_FAILED", "Unsupported Plaid environment.");
  let response: Response;
  try {
    response = await fetch(`${host}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "PLAID-CLIENT-ID": app.clientId,
        "PLAID-SECRET": app.clientSecret,
        "Plaid-Version": PLAID_API_VERSION,
        "User-Agent": "BankCafeMCP/0.1",
      },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new CafeError("BANK_UPSTREAM_ERROR", "Plaid could not be reached.", 502);
  }
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = plaidError(response.status, data);
    const parsed = plaidErrorSchema.safeParse(data);
    logEvent("warn", "plaid_request_failed", {
      path,
      status: response.status,
      plaidErrorCode: parsed.success ? parsed.data.error_code ?? null : null,
    });
    throw error;
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new CafeError("BANK_UPSTREAM_ERROR", "Plaid returned an unexpected response.", 502);
  return parsed.data;
}

export function getAccounts(item: PlaidItemCredentials) {
  return plaidPost(item, "/accounts/get", { access_token: item.accessToken }, accountsResponseSchema);
}

/** Real-time balance check. Plaid bills this endpoint per call. */
export function getRealtimeBalances(item: PlaidItemCredentials, plaidAccountIds: readonly string[]) {
  return plaidPost(item, "/accounts/balance/get", {
    access_token: item.accessToken,
    options: { account_ids: [...plaidAccountIds] },
  }, accountsResponseSchema);
}

export async function getTransactions(
  item: PlaidItemCredentials,
  query: { startDate: string; endDate: string; plaidAccountIds: readonly string[]; maxRecords: number },
): Promise<{ transactions: PlaidTransaction[]; total: number; truncated: boolean }> {
  const transactions: PlaidTransaction[] = [];
  let total = 0;
  let offset = 0;
  do {
    const page = await plaidPost(item, "/transactions/get", {
      access_token: item.accessToken,
      start_date: query.startDate,
      end_date: query.endDate,
      options: {
        account_ids: [...query.plaidAccountIds],
        count: Math.min(PLAID_PAGE_SIZE, query.maxRecords - transactions.length),
        offset,
        include_personal_finance_category: true,
      },
    }, transactionsResponseSchema);
    total = page.total_transactions;
    transactions.push(...page.transactions);
    offset += page.transactions.length;
    if (!page.transactions.length) break;
  } while (offset < total && transactions.length < query.maxRecords);
  return { transactions, total, truncated: transactions.length < total };
}

export async function removeItem(item: PlaidItemCredentials): Promise<void> {
  await plaidPost(item, "/item/remove", { access_token: item.accessToken }, z.object({}).passthrough());
}

/**
 * Verifies a pasted access token, then immediately rotates it with
 * /item/access_token/invalidate. Only the new token is returned, so any copy of
 * the pasted token (config files, clipboard, shell history) stops working.
 */
export async function verifyAndRotateAccessToken(
  app: PlaidAppCredentials,
  pastedToken: string,
): Promise<{ accessToken: string; accounts: PlaidAccount[]; institutionName: string | null }> {
  const tokenEnvironment = accessTokenEnvironment(pastedToken);
  if (!tokenEnvironment) {
    throw new CafeError("VALIDATION_FAILED", "That does not look like a Plaid access token.");
  }
  if (tokenEnvironment !== app.environment) {
    throw new CafeError("VALIDATION_FAILED", `This is a ${tokenEnvironment} access token, but the ${app.environment} environment was selected.`);
  }
  const pasted: PlaidItemCredentials = { ...app, accessToken: pastedToken };
  const verified = await getAccounts(pasted);
  const rotated = await plaidPost(pasted, "/item/access_token/invalidate", { access_token: pastedToken }, invalidateResponseSchema);
  if (accessTokenEnvironment(rotated.new_access_token) !== app.environment) {
    throw new CafeError("BANK_UPSTREAM_ERROR", "Plaid returned an unexpected access token.", 502);
  }
  return {
    accessToken: rotated.new_access_token,
    accounts: verified.accounts,
    institutionName: verified.item.institution_name ?? null,
  };
}
