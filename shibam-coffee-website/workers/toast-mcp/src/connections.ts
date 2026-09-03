import { z } from "zod";
import { encryptValue } from "./crypto";
import { requireMembership } from "./db";
import { CafeError } from "./errors";
import type { CafeEnvironment, ConnectionEnvironment, SessionIdentity } from "./runtime";
import { verifyToastRestaurant, type ToastCredentials } from "./toast/client";

const guid = z.string().uuid();
export const connectionInputSchema = z.object({
  label: z.string().trim().min(1).max(80),
  environment: z.enum(["production", "sandbox"]),
  clientId: z.string().trim().min(1).max(200),
  clientSecret: z.string().min(8).max(1000),
  restaurantGuids: z.array(guid).min(1).max(100).transform((values) => [...new Set(values)]),
});

export async function createByoConnection(env: CafeEnvironment, session: SessionIdentity, raw: unknown): Promise<string> {
  if (env.TOAST_BYO_MODE !== "enabled") {
    throw new CafeError("FEATURE_DISABLED", "BYO Toast credentials are disabled until the credential-use terms are confirmed.", 503);
  }
  if (!session.activeOrganizationId) throw new CafeError("AUTH_REQUIRED", "Select an organization.", 409);
  await requireMembership(env, session.userId, session.activeOrganizationId, true);
  const input = connectionInputSchema.parse(raw);
  const connectionId = `con_${crypto.randomUUID()}`;
  const credentials: ToastCredentials = {
    credentialKey: connectionId,
    environment: input.environment,
    clientId: input.clientId,
    clientSecret: input.clientSecret,
  };
  const restaurants = [];
  for (const restaurantGuid of input.restaurantGuids) {
    const verified = await verifyToastRestaurant(env, connectionId, credentials, restaurantGuid);
    restaurants.push({ restaurantGuid, ...verified });
  }
  const encrypted = await encryptValue(
    input.clientSecret,
    env.CREDENTIAL_KEK_V1,
    `toast-connection:${session.activeOrganizationId}:${connectionId}`,
  );
  const timestamp = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    env.TOAST_MCP_DB.prepare(
      `INSERT INTO toast_connections
        (id, organization_id, kind, environment, label, client_id, encrypted_client_secret, secret_nonce,
         secret_key_version, status, last_verified_at, created_by_user_id, created_at, updated_at)
       VALUES (?, ?, 'byo', ?, ?, ?, ?, ?, 1, 'active', ?, ?, ?, ?)`,
    ).bind(connectionId, session.activeOrganizationId, input.environment, input.label, input.clientId, encrypted.ciphertext, encrypted.nonce, timestamp, session.userId, timestamp, timestamp),
  ];
  for (const restaurant of restaurants) {
    statements.push(
      env.TOAST_MCP_DB.prepare(
        `INSERT INTO toast_locations
          (id, organization_id, connection_id, toast_guid, restaurant_name, location_name, timezone, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
         ON CONFLICT(organization_id, toast_guid) DO UPDATE SET
           connection_id = excluded.connection_id, restaurant_name = excluded.restaurant_name,
           location_name = excluded.location_name, timezone = excluded.timezone, status = 'active', updated_at = excluded.updated_at`,
      ).bind(`loc_${crypto.randomUUID()}`, session.activeOrganizationId, connectionId, restaurant.restaurantGuid, restaurant.restaurantName, restaurant.locationName, restaurant.timezone, timestamp, timestamp),
    );
  }
  await env.TOAST_MCP_DB.batch(statements);
  return connectionId;
}

export async function listConnections(env: CafeEnvironment, session: SessionIdentity): Promise<unknown[]> {
  if (!session.activeOrganizationId) return [];
  const membership = await requireMembership(env, session.userId, session.activeOrganizationId);
  const { results } = await env.TOAST_MCP_DB.prepare(
    `SELECT c.id, c.kind, c.environment, c.label, c.status, c.last_verified_at,
            COUNT(l.id) AS location_count
       FROM toast_connections c LEFT JOIN toast_locations l ON l.connection_id = c.id
      WHERE c.organization_id = ? AND c.deleted_at IS NULL
      GROUP BY c.id ORDER BY c.created_at DESC`,
  ).bind(session.activeOrganizationId).all();
  return results.map((row) => ({ ...row, canManage: membership.role === "owner" }));
}

export async function disconnectConnection(env: CafeEnvironment, session: SessionIdentity, connectionId: string, remove: boolean): Promise<void> {
  if (!session.activeOrganizationId) throw new CafeError("AUTH_REQUIRED", "Select an organization.", 409);
  await requireMembership(env, session.userId, session.activeOrganizationId, true);
  const timestamp = new Date().toISOString();
  const status = remove ? "removed" : "disconnected";
  await env.TOAST_MCP_DB.batch([
    env.TOAST_MCP_DB.prepare(
      `UPDATE toast_locations SET status = ?, updated_at = ?, removed_at = CASE WHEN ? = 'removed' THEN ? ELSE removed_at END
        WHERE connection_id = ? AND organization_id = ?`,
    ).bind(status, timestamp, status, timestamp, connectionId, session.activeOrganizationId),
    env.TOAST_MCP_DB.prepare(
      `UPDATE toast_connections SET status = ?, encrypted_client_secret = CASE WHEN ? = 'removed' THEN NULL ELSE encrypted_client_secret END,
              client_id = CASE WHEN ? = 'removed' THEN NULL ELSE client_id END,
              secret_nonce = CASE WHEN ? = 'removed' THEN NULL ELSE secret_nonce END,
              secret_key_version = CASE WHEN ? = 'removed' THEN NULL ELSE secret_key_version END,
              deleted_at = CASE WHEN ? = 'removed' THEN ? ELSE deleted_at END, updated_at = ?
        WHERE id = ? AND organization_id = ?`,
    ).bind(status, status, status, status, status, status, timestamp, timestamp, connectionId, session.activeOrganizationId),
  ]);
  await env.CAFE_CREDENTIAL_BROKER.getByName(connectionId).invalidateToken();
}

export async function rotateConnectionSecret(env: CafeEnvironment, session: SessionIdentity, connectionId: string, rawSecret: unknown): Promise<void> {
  if (!session.activeOrganizationId) throw new CafeError("AUTH_REQUIRED", "Select an organization.", 409);
  await requireMembership(env, session.userId, session.activeOrganizationId, true);
  const clientSecret = z.string().min(8).max(1000).parse(rawSecret);
  const connection = await env.TOAST_MCP_DB.prepare(
    "SELECT id, environment, client_id FROM toast_connections WHERE id = ? AND organization_id = ? AND kind = 'byo' AND status != 'removed'",
  ).bind(connectionId, session.activeOrganizationId).first<{ id: string; environment: ConnectionEnvironment; client_id: string }>();
  if (!connection) throw new CafeError("NOT_FOUND", "The Toast connection was not found.", 404);
  const { results: locations } = await env.TOAST_MCP_DB.prepare("SELECT toast_guid FROM toast_locations WHERE connection_id = ? AND organization_id = ? AND status != 'removed'")
    .bind(connectionId, session.activeOrganizationId).all<{ toast_guid: string }>();
  const credentials: ToastCredentials = { credentialKey: `${connectionId}:rotate`, environment: connection.environment, clientId: connection.client_id, clientSecret };
  for (const location of locations) await verifyToastRestaurant(env, `${connectionId}:rotate`, credentials, location.toast_guid);
  const encrypted = await encryptValue(clientSecret, env.CREDENTIAL_KEK_V1, `toast-connection:${session.activeOrganizationId}:${connectionId}`);
  const timestamp = new Date().toISOString();
  await env.TOAST_MCP_DB.batch([
    env.TOAST_MCP_DB.prepare(
      `UPDATE toast_connections SET encrypted_client_secret = ?, secret_nonce = ?, secret_key_version = 1,
              status = 'active', last_verified_at = ?, last_error_code = NULL, updated_at = ?
        WHERE id = ? AND organization_id = ? AND kind = 'byo'`,
    ).bind(encrypted.ciphertext, encrypted.nonce, timestamp, timestamp, connectionId, session.activeOrganizationId),
    env.TOAST_MCP_DB.prepare(
      "UPDATE toast_locations SET status = 'active', removed_at = NULL, updated_at = ? WHERE connection_id = ? AND organization_id = ? AND status != 'removed'",
    ).bind(timestamp, connectionId, session.activeOrganizationId),
  ]);
  await env.CAFE_CREDENTIAL_BROKER.getByName(connectionId).invalidateToken();
}

export async function setConnectionEnvironment(
  _env: CafeEnvironment,
  _connectionId: string,
  _environment: ConnectionEnvironment,
): Promise<never> {
  throw new CafeError("VALIDATION_FAILED", "A Toast connection environment is fixed. Create a new connection instead.", 409);
}
