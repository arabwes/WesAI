import { z } from "zod";
import { constantTimeEqual, hmacSha256Base64, sha256 } from "./crypto";
import { CafeError } from "./errors";
import type { CafeEnvironment } from "./runtime";

const partnerEventSchema = z.object({
  timestamp: z.string().datetime(),
  eventCategory: z.enum(["partner", "partners"]),
  eventType: z.enum(["partner_added", "partner_removed", "partner_updated"]),
  guid: z.string().uuid(),
  details: z.object({
    restaurantGuid: z.string().uuid(),
    managementGroupGuid: z.string().uuid().nullable().optional(),
    restaurantName: z.string().min(1).max(300),
    locationName: z.string().max(300).nullable().optional(),
    externalGroupRef: z.string().max(300).nullable().optional(),
    externalRestaurantRef: z.string().max(300).nullable().optional(),
    restaurantTimezone: z.string().max(100).nullable().optional(),
  }).passthrough(),
}).passthrough();

type PartnerEvent = z.infer<typeof partnerEventSchema>;

function enabled(env: CafeEnvironment): void {
  if (env.TOAST_PARTNER_MODE !== "enabled") throw new CafeError("FEATURE_DISABLED", "Not found.", 404);
  if (!env.TOAST_PARTNER_WEBHOOK_SECRET) throw new CafeError("INTERNAL_ERROR", "Partner webhook signing is not configured.", 503);
}

export async function ingestPartnerWebhook(env: CafeEnvironment, request: Request): Promise<Response> {
  enabled(env);
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  const declaredLength = Number.parseInt(request.headers.get("Content-Length") ?? "0", 10);
  if (declaredLength > 128 * 1024) throw new CafeError("VALIDATION_FAILED", "Webhook payload is too large.", 413);
  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > 128 * 1024) throw new CafeError("VALIDATION_FAILED", "Webhook payload is too large.", 413);

  // Toast signs the exact raw body concatenated with its timestamp. Extract only
  // that primitive first; parse the payload only after the signature is trusted.
  const timestampMatch = rawBody.match(/"timestamp"\s*:\s*"([^"\\]+)"/u);
  const signature = request.headers.get("Toast-Signature") ?? "";
  if (!timestampMatch?.[1] || !signature) throw new CafeError("AUTH_REQUIRED", "Webhook signature is invalid.", 401);
  const expected = await hmacSha256Base64(env.TOAST_PARTNER_WEBHOOK_SECRET!, `${rawBody}${timestampMatch[1]}`);
  if (!(await constantTimeEqual(signature, expected))) throw new CafeError("AUTH_REQUIRED", "Webhook signature is invalid.", 401);

  let decoded: unknown;
  try {
    decoded = JSON.parse(rawBody);
  } catch {
    throw new CafeError("VALIDATION_FAILED", "Webhook payload is invalid.");
  }
  const parsed = partnerEventSchema.safeParse(decoded);
  if (!parsed.success) throw new CafeError("VALIDATION_FAILED", "Webhook payload is invalid.");
  const event = parsed.data;
  const id = `pev_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const inserted = await env.TOAST_MCP_DB.prepare(
    `INSERT OR IGNORE INTO partner_events
      (id, idempotency_key, payload_hash, event_type, external_group_ref, external_restaurant_ref,
       restaurant_guid, management_group_guid, restaurant_name, location_name, restaurant_timezone,
       event_timestamp, status, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
  ).bind(id, event.guid, await sha256(rawBody), event.eventType, event.details.externalGroupRef ?? null,
    event.details.externalRestaurantRef ?? null, event.details.restaurantGuid, event.details.managementGroupGuid ?? null,
    event.details.restaurantName, event.details.locationName ?? null, event.details.restaurantTimezone ?? null,
    event.timestamp, now).run();
  if (!inserted.meta.changes) return new Response(null, { status: 204 });

  if (event.eventType === "partner_removed") await processPartnerEvent(env, id);
  else await env.CAFE_MCP_JOBS.send({ kind: "partner_event", partnerEventId: id });
  return new Response(null, { status: 204 });
}

export async function processPartnerEvent(env: CafeEnvironment, eventId: string): Promise<void> {
  const event = await env.TOAST_MCP_DB.prepare("SELECT * FROM partner_events WHERE id = ? AND status IN ('queued','failed')")
    .bind(eventId).first<{
      id: string; event_type: PartnerEvent["eventType"]; external_group_ref: string | null;
      external_restaurant_ref: string | null; restaurant_guid: string; management_group_guid: string | null;
      restaurant_name: string; location_name: string | null; restaurant_timezone: string | null;
      event_timestamp: string;
    }>();
  if (!event) return;
  const newer = await env.TOAST_MCP_DB.prepare(
    `SELECT 1 FROM partner_events WHERE restaurant_guid = ? AND external_group_ref IS ? AND id != ?
      AND julianday(event_timestamp) > julianday(?) AND status IN ('queued','processed') LIMIT 1`,
  ).bind(event.restaurant_guid, event.external_group_ref, event.id, event.event_timestamp).first();
  if (newer) {
    await env.TOAST_MCP_DB.prepare("UPDATE partner_events SET status = 'processed', error_code = 'SUPERSEDED', processed_at = ? WHERE id = ?").bind(new Date().toISOString(), event.id).run();
    return;
  }
  const organization = event.external_group_ref ? await env.TOAST_MCP_DB.prepare("SELECT id, created_by_user_id FROM organizations WHERE external_group_ref = ? AND deleted_at IS NULL").bind(event.external_group_ref).first<{ id: string; created_by_user_id: string }>() : null;
  if (!organization) {
    await env.TOAST_MCP_DB.prepare("UPDATE partner_events SET status = 'quarantined', error_code = 'UNKNOWN_CLAIM_CODE', processed_at = ? WHERE id = ?").bind(new Date().toISOString(), event.id).run();
    return;
  }
  const timestamp = new Date().toISOString();
  if (event.event_type === "partner_removed") {
    await env.TOAST_MCP_DB.batch([
      env.TOAST_MCP_DB.prepare("UPDATE toast_locations SET status = 'removed', removed_at = ?, updated_at = ? WHERE organization_id = ? AND toast_guid = ? AND connection_id IN (SELECT id FROM toast_connections WHERE kind = 'partner')").bind(timestamp, timestamp, organization.id, event.restaurant_guid),
      env.TOAST_MCP_DB.prepare("UPDATE toast_locations SET pending_connection_id = NULL, status = 'active', removed_at = NULL, updated_at = ? WHERE organization_id = ? AND toast_guid = ? AND pending_connection_id IN (SELECT id FROM toast_connections WHERE kind = 'partner') AND connection_id IN (SELECT id FROM toast_connections WHERE kind = 'byo')").bind(timestamp, organization.id, event.restaurant_guid),
      env.TOAST_MCP_DB.prepare("UPDATE partner_events SET status = 'processed', processed_at = ? WHERE id = ?").bind(timestamp, event.id),
    ]);
    return;
  }
  const existingConnection = await env.TOAST_MCP_DB.prepare(
    "SELECT id, status FROM toast_connections WHERE organization_id = ? AND kind = 'partner' ORDER BY created_at LIMIT 1",
  ).bind(organization.id).first<{ id: string; status: "active" | "invalid" | "disconnected" | "removed" }>();
  const partnerEnvironment = env.TOAST_PARTNER_ENVIRONMENT === "sandbox" ? "sandbox" : "production";
  if (existingConnection && existingConnection.status !== "active" && event.event_type !== "partner_added") {
    await env.TOAST_MCP_DB.prepare(
      "UPDATE partner_events SET status = 'processed', error_code = 'LOCALLY_DISCONNECTED', processed_at = ? WHERE id = ?",
    ).bind(timestamp, event.id).run();
    return;
  }
  const connection = { id: existingConnection?.id ?? `con_${organization.id.slice("org_".length)}` };
  await env.TOAST_MCP_DB.prepare(
    `INSERT INTO toast_connections (id, organization_id, kind, environment, label, status, created_by_user_id, created_at, updated_at)
     VALUES (?, ?, 'partner', ?, 'Toast partner installation', 'active', ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET environment = excluded.environment, status = 'active', deleted_at = NULL, updated_at = excluded.updated_at`,
  ).bind(connection.id, organization.id, partnerEnvironment, organization.created_by_user_id, timestamp, timestamp).run();
  const existing = await env.TOAST_MCP_DB.prepare("SELECT id, connection_id FROM toast_locations WHERE organization_id = ? AND toast_guid = ?").bind(organization.id, event.restaurant_guid).first<{ id: string; connection_id: string }>();
  if (existing && existing.connection_id !== connection.id) {
    await env.TOAST_MCP_DB.prepare(
      `UPDATE toast_locations SET pending_connection_id = ?, status = 'active', restaurant_name = ?, location_name = ?,
              timezone = ?, management_group_guid = ?, external_restaurant_ref = ?, updated_at = ? WHERE id = ?`,
    ).bind(connection.id, event.restaurant_name, event.location_name, event.restaurant_timezone, event.management_group_guid, event.external_restaurant_ref, timestamp, existing.id).run();
  } else if (existing) {
    await env.TOAST_MCP_DB.prepare(
      `UPDATE toast_locations SET status = 'active', restaurant_name = ?, location_name = ?, timezone = ?,
              management_group_guid = ?, external_restaurant_ref = ?, removed_at = NULL, updated_at = ? WHERE id = ?`,
    ).bind(event.restaurant_name, event.location_name, event.restaurant_timezone, event.management_group_guid, event.external_restaurant_ref, timestamp, existing.id).run();
  } else {
    await env.TOAST_MCP_DB.prepare(
      `INSERT INTO toast_locations
        (id, organization_id, connection_id, toast_guid, management_group_guid, restaurant_name, location_name,
         timezone, status, external_restaurant_ref, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    ).bind(`loc_${crypto.randomUUID()}`, organization.id, connection.id, event.restaurant_guid, event.management_group_guid,
      event.restaurant_name, event.location_name, event.restaurant_timezone, event.external_restaurant_ref, timestamp, timestamp).run();
  }
  await env.TOAST_MCP_DB.prepare("UPDATE partner_events SET status = 'processed', processed_at = ?, error_code = NULL WHERE id = ?").bind(timestamp, event.id).run();
}

export async function confirmPartnerMigration(env: CafeEnvironment, userId: string, organizationId: string, locationId: string): Promise<void> {
  const { requireMembership } = await import("./db");
  await requireMembership(env, userId, organizationId, true);
  const location = await env.TOAST_MCP_DB.prepare("SELECT connection_id, pending_connection_id FROM toast_locations WHERE id = ? AND organization_id = ? AND status = 'active' AND pending_connection_id IS NOT NULL").bind(locationId, organizationId).first<{ connection_id: string; pending_connection_id: string | null }>();
  if (!location?.pending_connection_id) throw new CafeError("NOT_FOUND", "No partner migration is pending.", 404);
  const timestamp = new Date().toISOString();
  await env.TOAST_MCP_DB.batch([
    env.TOAST_MCP_DB.prepare("UPDATE toast_locations SET connection_id = ?, pending_connection_id = NULL, status = 'active', updated_at = ? WHERE id = ? AND organization_id = ?").bind(location.pending_connection_id, timestamp, locationId, organizationId),
    env.TOAST_MCP_DB.prepare(
      `UPDATE toast_connections SET status = 'removed', client_id = NULL, encrypted_client_secret = NULL, secret_nonce = NULL,
              secret_key_version = NULL, deleted_at = ?, updated_at = ?
        WHERE id = ? AND kind = 'byo' AND NOT EXISTS (SELECT 1 FROM toast_locations WHERE connection_id = ? AND id != ?)`,
    ).bind(timestamp, timestamp, location.connection_id, location.connection_id, locationId),
  ]);
}

const connectedRestaurantsSchema = z.object({
  results: z.array(z.object({
    restaurantGuid: z.string().uuid(),
    managementGroupGuid: z.string().uuid().nullable().optional(),
    restaurantName: z.string(),
    locationName: z.string().nullable().optional(),
    externalGroupRef: z.string().nullable().optional(),
    externalRestaurantRef: z.string().nullable().optional(),
    modifiedDate: z.number().optional(),
  }).passthrough()),
  nextPageToken: z.string().nullable().optional(),
});

export async function reconcilePartnerLocations(env: CafeEnvironment): Promise<void> {
  if (env.TOAST_PARTNER_MODE !== "enabled" || !env.TOAST_PARTNER_CLIENT_ID || !env.TOAST_PARTNER_CLIENT_SECRET) return;
  const environment = env.TOAST_PARTNER_ENVIRONMENT === "sandbox" ? "sandbox" : "production";
  const broker = env.CAFE_CREDENTIAL_BROKER.getByName(`partner-v1-${environment}`);
  const credentials = {
    credentialKey: `partner-v1-${environment}`,
    environment,
    clientId: env.TOAST_PARTNER_CLIENT_ID,
    clientSecret: env.TOAST_PARTNER_CLIENT_SECRET,
  } as const;
  let token = await broker.getAccessToken(credentials);
  const host = environment === "production" ? "https://ws-api.toasttab.com" : "https://ws-sandbox-api.eng.toasttab.com";
  const seen = new Set<string>();
  let pageToken: string | null = null;
  let completed = false;
  for (let page = 0; page < 100; page += 1) {
    let permit = await broker.acquirePermit();
    if (!permit.allowed && permit.retryAfterMilliseconds <= 10_000) {
      await new Promise((resolve) => setTimeout(resolve, Math.max(10, permit.retryAfterMilliseconds)));
      permit = await broker.acquirePermit();
    }
    if (!permit.allowed) throw new CafeError("TOAST_RATE_LIMITED", "Partner reconciliation was rate-limited.", 429, permit.retryAfterSeconds);
    const url = new URL("/partners/v1/connectedRestaurants", host);
    url.searchParams.set("pageSize", "200");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    let response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": "CafeMCP/0.1" }, redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (response.status === 401) {
      await broker.invalidateToken();
      token = await broker.getAccessToken(credentials);
      response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": "CafeMCP/0.1" }, redirect: "error", signal: AbortSignal.timeout(30_000) });
    }
    if (response.status === 401 || response.status === 403) {
      await broker.invalidateToken();
      throw new CafeError("TOAST_AUTH_FAILED", "Toast rejected the partner credentials.", 401);
    }
    if (response.status === 429) {
      const retryAfter = Math.max(1, Number.parseInt(response.headers.get("Retry-After") ?? "60", 10));
      await broker.reportRateLimit(retryAfter);
      throw new CafeError("TOAST_RATE_LIMITED", "Partner reconciliation was rate-limited.", 429, retryAfter);
    }
    if (!response.ok) throw new CafeError("TOAST_UPSTREAM_ERROR", `Partner reconciliation returned HTTP ${response.status}.`, 502);
    const parsed = connectedRestaurantsSchema.safeParse(await response.json());
    if (!parsed.success) throw new CafeError("TOAST_UPSTREAM_ERROR", "Partner reconciliation returned invalid data.", 502);
    for (const restaurant of parsed.data.results) {
      if (!restaurant.externalGroupRef) continue;
      seen.add(`${restaurant.externalGroupRef}:${restaurant.restaurantGuid}`);
      const version = restaurant.modifiedDate ?? await sha256(JSON.stringify(restaurant));
      const idempotency = `reconcile:${restaurant.externalGroupRef}:${restaurant.restaurantGuid}:${version}`;
      const eventId = `pev_${crypto.randomUUID()}`;
      const now = new Date().toISOString();
      const inserted = await env.TOAST_MCP_DB.prepare(
        `INSERT OR IGNORE INTO partner_events
          (id, idempotency_key, payload_hash, event_type, external_group_ref, external_restaurant_ref, restaurant_guid,
           management_group_guid, restaurant_name, location_name, event_timestamp, status, received_at)
         VALUES (?, ?, ?, 'partner_updated', ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
      ).bind(eventId, idempotency, await sha256(idempotency), restaurant.externalGroupRef, restaurant.externalRestaurantRef ?? null,
        restaurant.restaurantGuid, restaurant.managementGroupGuid ?? null, restaurant.restaurantName, restaurant.locationName ?? null, now, now).run();
      if (inserted.meta.changes) await processPartnerEvent(env, eventId);
    }
    pageToken = parsed.data.nextPageToken ?? null;
    if (!pageToken) { completed = true; break; }
  }
  if (!completed) throw new CafeError("TOAST_UPSTREAM_ERROR", "Partner reconciliation exceeded its pagination safety limit.", 502);
  const { results: active } = await env.TOAST_MCP_DB.prepare(
    `SELECT l.id, l.toast_guid, o.external_group_ref, c.kind AS connection_kind, pc.kind AS pending_kind
       FROM toast_locations l JOIN organizations o ON o.id = l.organization_id
       JOIN toast_connections c ON c.id = l.connection_id
       LEFT JOIN toast_connections pc ON pc.id = l.pending_connection_id
      WHERE (c.kind = 'partner' OR pc.kind = 'partner') AND l.status IN ('active','pending_migration')`,
  ).all<{ id: string; toast_guid: string; external_group_ref: string; connection_kind: "byo" | "partner"; pending_kind: "partner" | null }>();
  const now = new Date().toISOString();
  const missing = active.filter((location) => !seen.has(`${location.external_group_ref}:${location.toast_guid}`));
  if (missing.length) await env.TOAST_MCP_DB.batch(missing.map((location) => location.connection_kind === "partner"
    ? env.TOAST_MCP_DB.prepare("UPDATE toast_locations SET status = 'removed', removed_at = ?, updated_at = ? WHERE id = ?").bind(now, now, location.id)
    : env.TOAST_MCP_DB.prepare("UPDATE toast_locations SET pending_connection_id = NULL, status = 'active', removed_at = NULL, updated_at = ? WHERE id = ?").bind(now, location.id)));
}
