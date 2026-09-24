import { McpServer, type ServerContext } from "@modelcontextprotocol/server";
import { getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";
import { requireMembership } from "../db";
import { CafeError, toPublicError } from "../errors";
import type { AuthProps } from "../runtime";
import type { BankEnvironment } from "./env";
import { getRealtimeBalances, getAccounts, getTransactions, type PlaidAccount, type PlaidTransaction } from "./plaid";
import { isBankScope, type BankScope } from "./scopes";
import { assertTransactionWindow, filterTransactions, toPublicTransaction } from "./transactions";
import {
  bankAudit,
  bankEnabled,
  itemCredentialsForConnection,
  listActiveAccounts,
  markConnectionFailure,
  type BankAccountRow,
} from "./store";

const MAX_PLAID_RECORDS = 5_000;
const REQUESTS_PER_MINUTE = 60;
const REALTIME_REFRESHES_PER_HOUR = 12;

const authPropsSchema = z.object({
  userId: z.string().startsWith("usr_"),
  organizationId: z.string().startsWith("org_"),
  membershipId: z.string().startsWith("mem_"),
});

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine((value) => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}, "Use a real calendar date in YYYY-MM-DD format.");

const accountIdsSchema = z.array(z.string().startsWith("bac_").max(60)).min(1).max(50).optional();

export interface BankAccess {
  userId: string;
  organizationId: string;
  membershipId: string;
  scopes: Set<BankScope>;
}

type AccountWithConnection = BankAccountRow & { label: string; institution_name: string | null; connection_status: string };

function result(data: Record<string, unknown>, text: string) {
  return { structuredContent: data, content: [{ type: "text" as const, text }] };
}

function failure(error: unknown) {
  const publicError = toPublicError(error);
  return {
    isError: true,
    structuredContent: { ok: false, error: publicError },
    content: [{ type: "text" as const, text: `${publicError.code}: ${publicError.message}` }],
  };
}

async function incrementBucket(env: BankEnvironment, key: string, windowMs: number, limit: number, message: string): Promise<void> {
  const window = Math.floor(Date.now() / windowMs);
  const row = await env.TOAST_MCP_DB.prepare(
    `INSERT INTO request_rate_buckets (bucket_key, request_count, expires_at) VALUES (?, 1, ?)
     ON CONFLICT(bucket_key) DO UPDATE SET request_count = request_count + 1
     RETURNING request_count`,
  ).bind(`${key}:${window}`, new Date((window + 2) * windowMs).toISOString()).first<{ request_count: number }>();
  if (!row || row.request_count > limit) {
    throw new CafeError("RATE_LIMITED", message, 429, Math.ceil(windowMs / 1000));
  }
}

export async function loadBankAccess(env: BankEnvironment, props: AuthProps, tokenScopes: readonly string[]): Promise<BankAccess> {
  if (env.BANK_MODE !== "enabled") throw new CafeError("FEATURE_DISABLED", "BankCafeMCP is disabled for this deployment.", 503);
  const membership = await requireMembership(env, props.userId, props.organizationId);
  if (membership.id !== props.membershipId) {
    throw new CafeError("AUTH_REQUIRED", "The authorization grant is no longer valid.", 403);
  }
  if (membership.role !== "owner") {
    throw new CafeError("SCOPE_DENIED", "BankCafeMCP is limited to organization owners.", 403);
  }
  if (!(await bankEnabled(env, props.organizationId))) {
    throw new CafeError("FEATURE_DISABLED", "Bank access is turned off for this organization.", 403);
  }
  return {
    userId: props.userId,
    organizationId: props.organizationId,
    membershipId: props.membershipId,
    scopes: new Set(tokenScopes.filter(isBankScope)),
  };
}

function requireScope(access: BankAccess, scope: BankScope): void {
  if (!access.scopes.has(scope)) throw new CafeError("SCOPE_DENIED", `The grant does not include ${scope}.`, 403);
}

function toPublicBalance(account: AccountWithConnection, plaid: PlaidAccount, source: "cached" | "realtime") {
  return {
    account_id: account.id,
    name: account.name,
    mask: account.mask,
    type: account.type,
    subtype: account.subtype,
    current: plaid.balances.current ?? null,
    available: plaid.balances.available ?? null,
    limit: plaid.balances.limit ?? null,
    currency: plaid.balances.iso_currency_code ?? plaid.balances.unofficial_currency_code ?? account.currency,
    last_updated: plaid.balances.last_updated_datetime ?? null,
    source,
  };
}

function groupByConnection(accounts: readonly AccountWithConnection[]): Map<string, AccountWithConnection[]> {
  const groups = new Map<string, AccountWithConnection[]>();
  for (const account of accounts) {
    const group = groups.get(account.connection_id) ?? [];
    group.push(account);
    groups.set(account.connection_id, group);
  }
  return groups;
}

function assertInlineSize(env: BankEnvironment, data: unknown): void {
  const bytes = new TextEncoder().encode(JSON.stringify(data)).byteLength;
  if (bytes > Number.parseInt(env.INLINE_RESULT_MAX_BYTES, 10)) {
    throw new CafeError("OVERSIZED_SENSITIVE_RESULT", "Bank results are never stored. Narrow the date range, accounts, or limit.", 413);
  }
}

export function createBankMcpServer(env: BankEnvironment): McpServer {
  const server = new McpServer({ name: "BankCafeMCP", version: "0.1.0" });

  async function run(
    context: ServerContext,
    eventType: string,
    handler: (access: BankAccess) => Promise<{ data: Record<string, unknown>; text: string; connectionId?: string }>,
  ) {
    const started = Date.now();
    let access: BankAccess | undefined;
    try {
      const parsed = authPropsSchema.safeParse(getMcpAuthContext()?.props);
      if (!parsed.success) throw new CafeError("AUTH_REQUIRED", "The MCP authorization context is invalid.", 401);
      await incrementBucket(env, `bank:${parsed.data.organizationId}:${parsed.data.userId}`, 60_000, REQUESTS_PER_MINUTE,
        "BankCafeMCP request limit exceeded.");
      access = await loadBankAccess(env, parsed.data, context.http?.authInfo?.scopes ?? []);
      const output = await handler(access);
      assertInlineSize(env, output.data);
      await bankAudit(env, {
        userId: access.userId, organizationId: access.organizationId, eventType, outcome: "success",
        statusCode: 200, durationMs: Date.now() - started,
      });
      return result(output.data, output.text);
    } catch (error) {
      const publicError = toPublicError(error);
      await bankAudit(env, {
        ...(access ? { userId: access.userId, organizationId: access.organizationId } : {}),
        eventType, outcome: publicError.code, statusCode: error instanceof CafeError ? error.status : 500,
        durationMs: Date.now() - started,
      }).catch(() => undefined);
      return failure(error);
    }
  }

  async function withConnection<T>(organizationId: string, connectionId: string, call: (credentials: Awaited<ReturnType<typeof itemCredentialsForConnection>>) => Promise<T>): Promise<T> {
    const credentials = await itemCredentialsForConnection(env, organizationId, connectionId);
    try {
      return await call(credentials);
    } catch (error) {
      await markConnectionFailure(env, connectionId, error);
      throw error;
    }
  }

  server.registerTool(
    "bank_list_accounts",
    {
      title: "List connected bank accounts",
      description: "Lists bank accounts connected to BankCafeMCP: internal account ID, name, last four digits, type, and currency. Read-only.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (_input, context) => run(context, "bank_list_accounts", async (access) => {
      requireScope(access, "bank/accounts:read");
      const accounts = (await listActiveAccounts(env, access.organizationId)).map((account) => ({
        account_id: account.id,
        name: account.name,
        mask: account.mask,
        type: account.type,
        subtype: account.subtype,
        currency: account.currency,
        institution: account.institution_name,
        connection_label: account.label,
        connection_status: account.connection_status,
      }));
      return { data: { ok: true, accounts }, text: `${accounts.length} connected bank account${accounts.length === 1 ? "" : "s"}.` };
    }),
  );

  server.registerTool(
    "bank_get_balances",
    {
      title: "Get bank account balances",
      description: "Returns current and available balances. By default uses Plaid's most recently cached balances; set refresh=true for a real-time bank check (rate-limited, billed by Plaid).",
      inputSchema: z.object({
        account_ids: accountIdsSchema,
        refresh: z.boolean().default(false),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (input, context) => run(context, "bank_get_balances", async (access) => {
      requireScope(access, "bank/balances:read");
      if (input.refresh) {
        await incrementBucket(env, `bank-refresh:${access.organizationId}`, 3_600_000, REALTIME_REFRESHES_PER_HOUR,
          "Real-time balance refreshes are limited to 12 per hour. Use refresh=false for cached balances.");
      }
      const accounts = await listActiveAccounts(env, access.organizationId, input.account_ids);
      const balances = [];
      for (const [connectionId, group] of groupByConnection(accounts)) {
        const plaidIds = group.map((account) => account.plaid_account_id);
        const response = await withConnection(access.organizationId, connectionId, (credentials) =>
          input.refresh ? getRealtimeBalances(credentials, plaidIds) : getAccounts(credentials));
        const byPlaidId = new Map(response.accounts.map((account) => [account.account_id, account]));
        for (const account of group) {
          const plaid = byPlaidId.get(account.plaid_account_id);
          if (plaid) balances.push(toPublicBalance(account, plaid, input.refresh ? "realtime" : "cached"));
        }
      }
      return { data: { ok: true, balances }, text: `Balances for ${balances.length} account${balances.length === 1 ? "" : "s"}.` };
    }),
  );

  server.registerTool(
    "bank_list_transactions",
    {
      title: "List bank transactions",
      description: "Lists bank transactions between two dates (max 730 days), newest first. Amounts follow Plaid's convention: positive = money leaving the account, negative = money coming in. Read-only; results are never stored.",
      inputSchema: z.object({
        start_date: isoDate,
        end_date: isoDate,
        account_ids: accountIdsSchema,
        direction: z.enum(["outflow", "inflow"]).optional(),
        min_abs_amount: z.number().nonnegative().optional(),
        max_abs_amount: z.number().nonnegative().optional(),
        text: z.string().trim().min(1).max(100).optional(),
        include_pending: z.boolean().default(true),
        limit: z.number().int().min(1).max(500).default(100),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (input, context) => run(context, "bank_list_transactions", async (access) => {
      requireScope(access, "bank/transactions:read");
      assertTransactionWindow(input.start_date, input.end_date);
      const accounts = await listActiveAccounts(env, access.organizationId, input.account_ids);
      const accountIdByPlaidId = new Map(accounts.map((account) => [account.plaid_account_id, account.id]));
      const collected: PlaidTransaction[] = [];
      let truncated = false;
      for (const [connectionId, group] of groupByConnection(accounts)) {
        const page = await withConnection(access.organizationId, connectionId, (credentials) => getTransactions(credentials, {
          startDate: input.start_date,
          endDate: input.end_date,
          plaidAccountIds: group.map((account) => account.plaid_account_id),
          maxRecords: MAX_PLAID_RECORDS,
        }));
        truncated ||= page.truncated;
        collected.push(...page.transactions);
      }
      const matched = filterTransactions(collected, {
        direction: input.direction,
        minAbsAmount: input.min_abs_amount,
        maxAbsAmount: input.max_abs_amount,
        text: input.text,
        includePending: input.include_pending,
      }).sort((left, right) => right.date.localeCompare(left.date));
      const transactions = matched.slice(0, input.limit).map((transaction) => toPublicTransaction(transaction, accountIdByPlaidId));
      return {
        data: {
          ok: true,
          transactions,
          matched: matched.length,
          returned: transactions.length,
          more_available: matched.length > transactions.length,
          scan_truncated: truncated,
        },
        text: `${transactions.length} of ${matched.length} matching transaction${matched.length === 1 ? "" : "s"}${truncated ? " (scan truncated at 5,000 per bank; narrow the date range)" : ""}.`,
      };
    }),
  );

  return server;
}
