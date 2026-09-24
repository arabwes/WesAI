import { z } from "zod";
import { decryptValue, encryptValue } from "../crypto";
import { requireMembership } from "../db";
import { CafeError } from "../errors";
import { logEvent } from "../security";
import type { CafeEnvironment, SessionIdentity } from "../runtime";
import { assertBankMode, type BankEnvironment } from "./env";
import {
  getAccounts,
  removeItem,
  verifyAndRotateAccessToken,
  type PlaidAccount,
  type PlaidEnvironment,
  type PlaidItemCredentials,
} from "./plaid";

export type BankSecretField = "client_secret" | "access_token";

export function bankSecretAad(organizationId: string, connectionId: string, field: BankSecretField): string {
  return `bank-connection:${organizationId}:${connectionId}:${field}`;
}

export const bankConnectionInputSchema = z.object({
  label: z.string().trim().min(1).max(80),
  environment: z.enum(["production", "sandbox"]),
  clientId: z.string().trim().regex(/^[A-Za-z0-9]{8,64}$/u),
  clientSecret: z.string().trim().regex(/^[A-Za-z0-9]{16,128}$/u),
  accessToken: z.string().trim().min(20).max(200),
});

const clientSecretSchema = z.string().trim().regex(/^[A-Za-z0-9]{16,128}$/u);

interface BankConnectionRow {
  id: string;
  organization_id: string;
  environment: PlaidEnvironment;
  label: string;
  institution_name: string | null;
  client_id: string | null;
  encrypted_client_secret: string | null;
  client_secret_nonce: string | null;
  encrypted_access_token: string | null;
  access_token_nonce: string | null;
  secret_key_version: number | null;
  status: "active" | "invalid" | "removed";
}

export interface BankAccountRow {
  id: string;
  connection_id: string;
  plaid_account_id: string;
  name: string;
  mask: string | null;
  type: string | null;
  subtype: string | null;
  currency: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

async function requireOwnerOrganization(env: CafeEnvironment, session: SessionIdentity): Promise<string> {
  if (!session.activeOrganizationId) throw new CafeError("AUTH_REQUIRED", "Select an organization.", 409);
  await requireMembership(env, session.userId, session.activeOrganizationId, true);
  return session.activeOrganizationId;
}

export async function bankEnabled(env: CafeEnvironment, organizationId: string): Promise<boolean> {
  const row = await env.TOAST_MCP_DB.prepare("SELECT enabled FROM bank_settings WHERE organization_id = ?")
    .bind(organizationId).first<{ enabled: number }>();
  return row?.enabled === 1;
}

export async function setBankEnabled(env: BankEnvironment, session: SessionIdentity, enabled: boolean): Promise<void> {
  assertBankMode(env);
  const organizationId = await requireOwnerOrganization(env, session);
  const timestamp = nowIso();
  await env.TOAST_MCP_DB.prepare(
    `INSERT INTO bank_settings (organization_id, enabled, updated_by_user_id, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(organization_id) DO UPDATE SET enabled = excluded.enabled,
       updated_by_user_id = excluded.updated_by_user_id, updated_at = excluded.updated_at`,
  ).bind(organizationId, enabled ? 1 : 0, session.userId, timestamp).run();
  await bankAudit(env, { userId: session.userId, organizationId, eventType: enabled ? "bank.enabled" : "bank.disabled", outcome: "success" });
}

function accountStatements(
  env: CafeEnvironment,
  organizationId: string,
  connectionId: string,
  accounts: readonly PlaidAccount[],
  timestamp: string,
): D1PreparedStatement[] {
  const statements = accounts.map((account) => env.TOAST_MCP_DB.prepare(
    `INSERT INTO bank_accounts
      (id, organization_id, connection_id, plaid_account_id, name, mask, type, subtype, currency, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
     ON CONFLICT(connection_id, plaid_account_id) DO UPDATE SET
       name = excluded.name, mask = excluded.mask, type = excluded.type, subtype = excluded.subtype,
       currency = excluded.currency, status = 'active', updated_at = excluded.updated_at`,
  ).bind(
    `bac_${crypto.randomUUID()}`,
    organizationId,
    connectionId,
    account.account_id,
    (account.official_name || account.name).slice(0, 200),
    account.mask ?? null,
    account.type ?? null,
    account.subtype ?? null,
    account.balances.iso_currency_code ?? account.balances.unofficial_currency_code ?? null,
    timestamp,
    timestamp,
  ));
  const keep = accounts.map((account) => account.account_id);
  const placeholders = keep.map(() => "?").join(", ");
  statements.push(env.TOAST_MCP_DB.prepare(
    `UPDATE bank_accounts SET status = 'removed', updated_at = ?
      WHERE connection_id = ? AND organization_id = ? AND status = 'active'
      ${keep.length ? `AND plaid_account_id NOT IN (${placeholders})` : ""}`,
  ).bind(timestamp, connectionId, organizationId, ...keep));
  return statements;
}

export async function createBankConnection(env: BankEnvironment, session: SessionIdentity, raw: unknown): Promise<string> {
  assertBankMode(env);
  const organizationId = await requireOwnerOrganization(env, session);
  const input = bankConnectionInputSchema.parse(raw);
  const rotated = await verifyAndRotateAccessToken(
    { environment: input.environment, clientId: input.clientId, clientSecret: input.clientSecret },
    input.accessToken,
  );

  const connectionId = `bcn_${crypto.randomUUID()}`;
  const [secret, token] = await Promise.all([
    encryptValue(input.clientSecret, env.CREDENTIAL_KEK_V1, bankSecretAad(organizationId, connectionId, "client_secret")),
    encryptValue(rotated.accessToken, env.CREDENTIAL_KEK_V1, bankSecretAad(organizationId, connectionId, "access_token")),
  ]);
  const timestamp = nowIso();
  const statements = [
    env.TOAST_MCP_DB.prepare(
      `INSERT INTO bank_connections
        (id, organization_id, environment, label, institution_name, client_id, encrypted_client_secret, client_secret_nonce,
         encrypted_access_token, access_token_nonce, secret_key_version, status, last_verified_at, created_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'active', ?, ?, ?, ?)`,
    ).bind(
      connectionId, organizationId, input.environment, input.label, rotated.institutionName?.slice(0, 200) ?? null,
      input.clientId, secret.ciphertext, secret.nonce, token.ciphertext, token.nonce,
      timestamp, session.userId, timestamp, timestamp,
    ),
    ...accountStatements(env, organizationId, connectionId, rotated.accounts, timestamp),
  ];
  try {
    await env.TOAST_MCP_DB.batch(statements);
  } catch {
    try {
      await env.TOAST_MCP_DB.batch(statements);
    } catch {
      // The pasted token was already rotated at Plaid and the replacement could not be stored.
      logEvent("error", "bank_connection_store_failed", { organizationId });
      throw new CafeError(
        "INTERNAL_ERROR",
        "Plaid accepted the token, but it could not be saved. The pasted token is no longer valid; generate a new access token and try again.",
        500,
      );
    }
  }
  await bankAudit(env, { userId: session.userId, organizationId, connectionId, eventType: "bank.connection_created", outcome: "success" });
  return connectionId;
}

async function loadConnectionRow(env: CafeEnvironment, organizationId: string, connectionId: string): Promise<BankConnectionRow> {
  const row = await env.TOAST_MCP_DB.prepare(
    "SELECT * FROM bank_connections WHERE id = ? AND organization_id = ? AND status != 'removed'",
  ).bind(connectionId, organizationId).first<BankConnectionRow>();
  if (!row) throw new CafeError("NOT_FOUND", "The bank connection was not found.", 404);
  return row;
}

async function decryptItemCredentials(env: CafeEnvironment, row: BankConnectionRow): Promise<PlaidItemCredentials> {
  if (!row.client_id || !row.encrypted_client_secret || !row.client_secret_nonce || !row.encrypted_access_token
    || !row.access_token_nonce || row.secret_key_version !== 1) {
    throw new CafeError("BANK_AUTH_FAILED", "The bank connection has no usable stored credential.", 409);
  }
  const [clientSecret, accessToken] = await Promise.all([
    decryptValue({ ciphertext: row.encrypted_client_secret, nonce: row.client_secret_nonce, keyVersion: 1 },
      env.CREDENTIAL_KEK_V1, bankSecretAad(row.organization_id, row.id, "client_secret")),
    decryptValue({ ciphertext: row.encrypted_access_token, nonce: row.access_token_nonce, keyVersion: 1 },
      env.CREDENTIAL_KEK_V1, bankSecretAad(row.organization_id, row.id, "access_token")),
  ]);
  return { environment: row.environment, clientId: row.client_id, clientSecret, accessToken };
}

export async function itemCredentialsForConnection(
  env: CafeEnvironment,
  organizationId: string,
  connectionId: string,
): Promise<PlaidItemCredentials> {
  const row = await loadConnectionRow(env, organizationId, connectionId);
  if (row.status !== "active") {
    throw new CafeError("BANK_RELINK_REQUIRED", "This bank connection needs attention in the BankCafeMCP page.", 409);
  }
  return decryptItemCredentials(env, row);
}

export async function markConnectionFailure(env: CafeEnvironment, connectionId: string, error: unknown): Promise<void> {
  if (!(error instanceof CafeError) || !["BANK_AUTH_FAILED", "BANK_RELINK_REQUIRED"].includes(error.code)) return;
  await env.TOAST_MCP_DB.prepare(
    "UPDATE bank_connections SET status = 'invalid', last_error_code = ?, updated_at = ? WHERE id = ? AND status = 'active'",
  ).bind(error.code, nowIso(), connectionId).run();
}

export async function refreshBankAccounts(env: BankEnvironment, session: SessionIdentity, connectionId: string): Promise<void> {
  assertBankMode(env);
  const organizationId = await requireOwnerOrganization(env, session);
  const row = await loadConnectionRow(env, organizationId, connectionId);
  const credentials = await decryptItemCredentials(env, row);
  let accounts;
  try {
    accounts = await getAccounts(credentials);
  } catch (error) {
    await markConnectionFailure(env, connectionId, error);
    throw error;
  }
  const timestamp = nowIso();
  await env.TOAST_MCP_DB.batch([
    env.TOAST_MCP_DB.prepare(
      `UPDATE bank_connections SET status = 'active', last_error_code = NULL, last_verified_at = ?,
              institution_name = COALESCE(?, institution_name), updated_at = ?
        WHERE id = ? AND organization_id = ?`,
    ).bind(timestamp, accounts.item.institution_name?.slice(0, 200) ?? null, timestamp, connectionId, organizationId),
    ...accountStatements(env, organizationId, connectionId, accounts.accounts, timestamp),
  ]);
  await bankAudit(env, { userId: session.userId, organizationId, connectionId, eventType: "bank.accounts_refreshed", outcome: "success" });
}

export async function rotateBankClientSecret(
  env: BankEnvironment,
  session: SessionIdentity,
  connectionId: string,
  rawSecret: unknown,
): Promise<void> {
  assertBankMode(env);
  const organizationId = await requireOwnerOrganization(env, session);
  const clientSecret = clientSecretSchema.parse(rawSecret);
  const row = await loadConnectionRow(env, organizationId, connectionId);
  const current = await decryptItemCredentials(env, row);
  const accounts = await getAccounts({ ...current, clientSecret });
  const encrypted = await encryptValue(clientSecret, env.CREDENTIAL_KEK_V1, bankSecretAad(organizationId, connectionId, "client_secret"));
  const timestamp = nowIso();
  await env.TOAST_MCP_DB.batch([
    env.TOAST_MCP_DB.prepare(
      `UPDATE bank_connections SET encrypted_client_secret = ?, client_secret_nonce = ?, secret_key_version = 1,
              status = 'active', last_error_code = NULL, last_verified_at = ?, updated_at = ?
        WHERE id = ? AND organization_id = ?`,
    ).bind(encrypted.ciphertext, encrypted.nonce, timestamp, timestamp, connectionId, organizationId),
    ...accountStatements(env, organizationId, connectionId, accounts.accounts, timestamp),
  ]);
  await bankAudit(env, { userId: session.userId, organizationId, connectionId, eventType: "bank.secret_rotated", outcome: "success" });
}

export async function disconnectBankConnection(env: BankEnvironment, session: SessionIdentity, connectionId: string): Promise<void> {
  const organizationId = await requireOwnerOrganization(env, session);
  const row = await loadConnectionRow(env, organizationId, connectionId);
  let plaidOutcome = "item_removed";
  try {
    await removeItem(await decryptItemCredentials(env, row));
  } catch (error) {
    // Local credential deletion must still succeed if Plaid already revoked the item.
    plaidOutcome = error instanceof CafeError ? error.code : "PLAID_REMOVE_FAILED";
  }
  const timestamp = nowIso();
  await env.TOAST_MCP_DB.batch([
    env.TOAST_MCP_DB.prepare(
      `UPDATE bank_connections SET status = 'removed', client_id = NULL, encrypted_client_secret = NULL,
              client_secret_nonce = NULL, encrypted_access_token = NULL, access_token_nonce = NULL,
              secret_key_version = NULL, deleted_at = ?, updated_at = ?
        WHERE id = ? AND organization_id = ?`,
    ).bind(timestamp, timestamp, connectionId, organizationId),
    env.TOAST_MCP_DB.prepare("UPDATE bank_accounts SET status = 'removed', updated_at = ? WHERE connection_id = ? AND organization_id = ?")
      .bind(timestamp, connectionId, organizationId),
  ]);
  await bankAudit(env, { userId: session.userId, organizationId, connectionId, eventType: "bank.connection_removed", outcome: plaidOutcome });
}

export async function listBankConnections(env: CafeEnvironment, organizationId: string): Promise<unknown[]> {
  const [{ results: connections }, { results: accounts }] = await Promise.all([
    env.TOAST_MCP_DB.prepare(
      `SELECT id, environment, label, institution_name, status, last_verified_at, last_error_code
         FROM bank_connections WHERE organization_id = ? AND status != 'removed' ORDER BY created_at`,
    ).bind(organizationId).all<Record<string, unknown> & { id: string }>(),
    env.TOAST_MCP_DB.prepare(
      `SELECT id, connection_id, name, mask, type, subtype, currency
         FROM bank_accounts WHERE organization_id = ? AND status = 'active' ORDER BY name`,
    ).bind(organizationId).all<Record<string, unknown> & { connection_id: string }>(),
  ]);
  return connections.map((connection) => ({
    ...connection,
    accounts: accounts
      .filter((account) => account.connection_id === connection.id)
      .map(({ connection_id: _connectionId, ...account }) => account),
  }));
}

export async function listActiveAccounts(
  env: CafeEnvironment,
  organizationId: string,
  accountIds?: readonly string[],
): Promise<Array<BankAccountRow & { label: string; institution_name: string | null; connection_status: string }>> {
  const { results } = await env.TOAST_MCP_DB.prepare(
    `SELECT a.id, a.connection_id, a.plaid_account_id, a.name, a.mask, a.type, a.subtype, a.currency,
            c.label, c.institution_name, c.status AS connection_status
       FROM bank_accounts a JOIN bank_connections c ON c.id = a.connection_id
      WHERE a.organization_id = ? AND a.status = 'active' AND c.status != 'removed'
      ORDER BY c.created_at, a.name`,
  ).bind(organizationId).all<BankAccountRow & { label: string; institution_name: string | null; connection_status: string }>();
  if (!accountIds?.length) return results;
  const wanted = new Set(accountIds);
  const selected = results.filter((row) => wanted.has(row.id));
  if (selected.length !== wanted.size) throw new CafeError("NOT_FOUND", "One or more account IDs are not available.", 404);
  return selected;
}

export async function bankAudit(
  env: CafeEnvironment,
  input: {
    requestId?: string;
    userId?: string;
    organizationId?: string;
    connectionId?: string;
    eventType: string;
    outcome: string;
    statusCode?: number;
    durationMs?: number;
  },
): Promise<void> {
  await env.TOAST_MCP_DB.prepare(
    `INSERT INTO bank_audit_events
      (id, request_id, user_id, organization_id, connection_id, event_type, outcome, status_code, duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    `bau_${crypto.randomUUID()}`,
    input.requestId ?? crypto.randomUUID(),
    input.userId ?? null,
    input.organizationId ?? null,
    input.connectionId ?? null,
    input.eventType,
    input.outcome,
    input.statusCode ?? null,
    input.durationMs ?? null,
    nowIso(),
  ).run();
}

export async function cleanupBankRecords(env: CafeEnvironment): Promise<void> {
  const cutoff = new Date(Date.now() - Number.parseInt(env.AUDIT_RETENTION_DAYS, 10) * 86_400_000).toISOString();
  try {
    await env.TOAST_MCP_DB.prepare("DELETE FROM bank_audit_events WHERE created_at < ?").bind(cutoff).run();
  } catch (error) {
    logEvent("warn", "bank_cleanup_failed", { message: error instanceof Error ? error.message : "unknown" });
  }
}
