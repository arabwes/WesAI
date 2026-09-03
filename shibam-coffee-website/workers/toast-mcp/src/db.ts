import { CafeError } from "./errors";
import { randomToken, sha256, signSessionToken } from "./crypto";
import {
  CAFE_SCOPES,
  SENSITIVE_TOAST_SCOPES,
  TOAST_STANDARD_SCOPES,
  isSensitiveOAuthScope,
  isSupportedOAuthScope,
  intersectAuthorizationScopes,
  toOAuthToastScope,
  type OAuthScope,
} from "./scopes";
import { normalizeEmail, parseCookies } from "./security";
import type {
  AuthProps,
  CafeEnvironment,
  EffectiveAccess,
  IdentityClaims,
  MembershipRole,
  SessionIdentity,
  ToastConnectionRecord,
  ToastLocationRecord,
} from "./runtime";

interface UserRow {
  id: string;
  email: string;
  display_name: string | null;
}

interface MembershipRow {
  id: string;
  organization_id: string;
  organization_name: string;
  organization_slug: string;
  external_group_ref: string;
  sensitive_pii_enabled: number;
  role: MembershipRole;
}

interface SessionRow extends UserRow {
  active_organization_id: string | null;
  csrf_token_hash: string;
  last_seen_at: string;
}

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  externalGroupRef: string | null;
  sensitivePiiEnabled: boolean;
  role: MembershipRole;
}

export interface MemberSummary {
  id: string;
  userId: string;
  email: string;
  displayName: string | null;
  role: MembershipRole;
  status: "active" | "revoked";
  scopes: string[];
  locationIds: string[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function futureIso(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function safeSlug(value: string): string {
  const cleaned = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 42);
  return cleaned || "cafe";
}

export async function upsertIdentityAndEnsureOrganization(
  env: CafeEnvironment,
  claims: IdentityClaims,
): Promise<{ userId: string; organizationId: string }> {
  if (!claims.emailVerified) {
    throw new CafeError("AUTH_REQUIRED", "Verify your email address before using Cafe MCP.", 403);
  }

  const timestamp = nowIso();
  const emailNormalized = normalizeEmail(claims.email);
  const existing = await env.TOAST_MCP_DB.prepare("SELECT id FROM users WHERE auth0_sub = ?")
    .bind(claims.sub)
    .first<{ id: string }>();
  const userId = existing?.id ?? `usr_${crypto.randomUUID()}`;

  await env.TOAST_MCP_DB.prepare(
    `INSERT INTO users
      (id, auth0_sub, email, email_normalized, email_verified, display_name, created_at, updated_at, last_login_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
     ON CONFLICT(auth0_sub) DO UPDATE SET
       email = excluded.email,
       email_normalized = excluded.email_normalized,
       email_verified = 1,
       display_name = excluded.display_name,
       updated_at = excluded.updated_at,
       last_login_at = excluded.last_login_at`,
  )
    .bind(userId, claims.sub, claims.email.trim(), emailNormalized, claims.name, timestamp, timestamp, timestamp)
    .run();

  const membership = await env.TOAST_MCP_DB.prepare(
    "SELECT organization_id FROM memberships WHERE user_id = ? AND status = 'active' ORDER BY created_at LIMIT 1",
  )
    .bind(userId)
    .first<{ organization_id: string }>();
  if (membership) return { userId, organizationId: membership.organization_id };

  const organizationId = `org_${crypto.randomUUID()}`;
  const membershipId = `mem_${crypto.randomUUID()}`;
  const displayBase = claims.name?.trim() || claims.email.split("@")[0] || "Cafe";
  const name = `${displayBase}'s Cafe MCP`;
  const slug = `${safeSlug(displayBase)}-${randomToken(5).toLowerCase()}`;
  const externalGroupRef = `cafe_${randomToken(18)}`;

  const statements: D1PreparedStatement[] = [
    env.TOAST_MCP_DB.prepare(
      `INSERT INTO organizations
        (id, name, slug, external_group_ref, created_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(organizationId, name, slug, externalGroupRef, userId, timestamp, timestamp),
    env.TOAST_MCP_DB.prepare(
      `INSERT INTO memberships (id, organization_id, user_id, role, status, created_at, updated_at)
       VALUES (?, ?, ?, 'owner', 'active', ?, ?)`,
    ).bind(membershipId, organizationId, userId, timestamp, timestamp),
  ];

  for (const scope of TOAST_STANDARD_SCOPES) {
    statements.push(
      env.TOAST_MCP_DB.prepare(
        "INSERT INTO organization_scopes (organization_id, scope, enabled, updated_at) VALUES (?, ?, ?, ?)",
      ).bind(organizationId, scope, SENSITIVE_TOAST_SCOPES.has(scope) ? 0 : 1, timestamp),
    );
  }
  await env.TOAST_MCP_DB.batch(statements);
  return { userId, organizationId };
}

export async function createSession(
  env: CafeEnvironment,
  userId: string,
  activeOrganizationId: string,
): Promise<{ sessionToken: string; csrfToken: string }> {
  const sessionToken = randomToken();
  const csrfToken = randomToken();
  const [tokenHash, csrfHash] = await Promise.all([
    signSessionToken(env.SESSION_SIGNING_KEY, sessionToken),
    sha256(csrfToken),
  ]);
  const timestamp = nowIso();
  const ttl = Number.parseInt(env.SESSION_TTL_SECONDS, 10);
  await env.TOAST_MCP_DB.prepare(
    `INSERT INTO sessions
      (token_hash, user_id, active_organization_id, csrf_token_hash, created_at, last_seen_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(tokenHash, userId, activeOrganizationId, csrfHash, timestamp, timestamp, futureIso(ttl))
    .run();
  return { sessionToken, csrfToken };
}

export async function readSession(env: CafeEnvironment, request: Request): Promise<SessionIdentity | null> {
  const cookies = parseCookies(request);
  const sessionToken = cookies.get("__Host-cafe_mcp_session");
  if (!sessionToken) return null;
  const tokenHash = await signSessionToken(env.SESSION_SIGNING_KEY, decodeURIComponent(sessionToken));
  const timestamp = nowIso();
  const row = await env.TOAST_MCP_DB.prepare(
    `SELECT u.id, u.email, u.display_name, s.active_organization_id, s.csrf_token_hash, s.last_seen_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?`,
  )
    .bind(tokenHash, timestamp)
    .first<SessionRow>();
  if (!row) return null;

  if (Date.now() - Date.parse(row.last_seen_at) > 15 * 60 * 1000) {
    await env.TOAST_MCP_DB.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?")
      .bind(timestamp, tokenHash)
      .run();
  }

  return {
    sessionToken: decodeURIComponent(sessionToken),
    csrfToken: decodeURIComponent(cookies.get("__Host-cafe_mcp_csrf") ?? ""),
    userId: row.id,
    activeOrganizationId: row.active_organization_id,
    email: row.email,
    displayName: row.display_name,
  };
}

export async function requireSession(env: CafeEnvironment, request: Request): Promise<SessionIdentity> {
  const session = await readSession(env, request);
  if (!session) throw new CafeError("AUTH_REQUIRED", "Sign in to continue.", 401);
  return session;
}

export async function validateSessionCsrf(
  env: CafeEnvironment,
  request: Request,
  session: SessionIdentity,
): Promise<void> {
  await validateSessionCsrfValue(env, session, request.headers.get("X-CSRF-Token") ?? "");
}

export async function validateSessionCsrfValue(
  env: CafeEnvironment,
  session: SessionIdentity,
  supplied: string,
): Promise<void> {
  if (!supplied || !session.csrfToken || supplied !== session.csrfToken) {
    throw new CafeError("CSRF_INVALID", "The security token is missing or invalid.", 403);
  }
  const tokenHash = await signSessionToken(env.SESSION_SIGNING_KEY, session.sessionToken);
  const row = await env.TOAST_MCP_DB.prepare("SELECT csrf_token_hash FROM sessions WHERE token_hash = ?")
    .bind(tokenHash)
    .first<{ csrf_token_hash: string }>();
  if (!row || (await sha256(supplied)) !== row.csrf_token_hash) {
    throw new CafeError("CSRF_INVALID", "The security token is missing or invalid.", 403);
  }
}

export async function revokeSession(env: CafeEnvironment, sessionToken: string): Promise<void> {
  const tokenHash = await signSessionToken(env.SESSION_SIGNING_KEY, sessionToken);
  await env.TOAST_MCP_DB.prepare("UPDATE sessions SET revoked_at = ? WHERE token_hash = ?")
    .bind(nowIso(), tokenHash)
    .run();
}

export async function listOrganizations(env: CafeEnvironment, userId: string): Promise<OrganizationSummary[]> {
  const { results } = await env.TOAST_MCP_DB.prepare(
    `SELECT o.id, o.name, o.slug, o.external_group_ref, o.sensitive_pii_enabled, m.role
       FROM memberships m
       JOIN organizations o ON o.id = m.organization_id
      WHERE m.user_id = ? AND m.status = 'active' AND o.deleted_at IS NULL
      ORDER BY o.name`,
  )
    .bind(userId)
    .all<{
      id: string;
      name: string;
      slug: string;
      external_group_ref: string;
      sensitive_pii_enabled: number;
      role: MembershipRole;
    }>();
  return results.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    externalGroupRef: row.role === "owner" ? row.external_group_ref : null,
    sensitivePiiEnabled: row.sensitive_pii_enabled === 1,
    role: row.role,
  }));
}

export async function setActiveOrganization(
  env: CafeEnvironment,
  session: SessionIdentity,
  organizationId: string,
): Promise<void> {
  const membership = await env.TOAST_MCP_DB.prepare(
    "SELECT 1 FROM memberships WHERE user_id = ? AND organization_id = ? AND status = 'active'",
  )
    .bind(session.userId, organizationId)
    .first();
  if (!membership) throw new CafeError("LOCATION_DENIED", "You do not belong to that organization.", 403);
  const tokenHash = await signSessionToken(env.SESSION_SIGNING_KEY, session.sessionToken);
  await env.TOAST_MCP_DB.prepare("UPDATE sessions SET active_organization_id = ?, last_seen_at = ? WHERE token_hash = ?")
    .bind(organizationId, nowIso(), tokenHash)
    .run();
}

export async function requireMembership(
  env: CafeEnvironment,
  userId: string,
  organizationId: string,
  ownerOnly = false,
): Promise<MembershipRow> {
  const row = await env.TOAST_MCP_DB.prepare(
    `SELECT m.id, m.organization_id, m.role, o.name AS organization_name, o.slug AS organization_slug,
            o.external_group_ref, o.sensitive_pii_enabled
       FROM memberships m
       JOIN organizations o ON o.id = m.organization_id
      WHERE m.user_id = ? AND m.organization_id = ? AND m.status = 'active' AND o.deleted_at IS NULL`,
  )
    .bind(userId, organizationId)
    .first<MembershipRow>();
  if (!row) throw new CafeError("AUTH_REQUIRED", "Your organization access is no longer active.", 403);
  if (ownerOnly && row.role !== "owner") {
    throw new CafeError("SCOPE_DENIED", "Only an organization owner can perform this action.", 403);
  }
  return row;
}

export async function loadEffectiveAccess(
  env: CafeEnvironment,
  props: AuthProps,
  tokenScopes: readonly string[],
): Promise<EffectiveAccess> {
  const membership = await requireMembership(env, props.userId, props.organizationId);
  if (membership.id !== props.membershipId) {
    throw new CafeError("AUTH_REQUIRED", "The authorization grant is no longer valid.", 403);
  }

  const { results: organizationScopeRows } = await env.TOAST_MCP_DB.prepare(
    "SELECT scope FROM organization_scopes WHERE organization_id = ? AND enabled = 1",
  )
    .bind(props.organizationId)
    .all<{ scope: string }>();
  const organizationScopes = new Set<string>([
    ...CAFE_SCOPES,
    ...organizationScopeRows.map((row) => `toast/${row.scope}`),
  ]);

  let membershipScopes = organizationScopes;
  let locationIds: Set<string> | null = null;
  if (membership.role === "member") {
    const [{ results: scopeRows }, { results: locationRows }] = await Promise.all([
      env.TOAST_MCP_DB.prepare("SELECT scope FROM member_scopes WHERE membership_id = ?")
        .bind(membership.id)
        .all<{ scope: string }>(),
      env.TOAST_MCP_DB.prepare("SELECT location_id FROM member_locations WHERE membership_id = ?")
        .bind(membership.id)
        .all<{ location_id: string }>(),
    ]);
    membershipScopes = new Set<string>(scopeRows.map((row) => row.scope));
    locationIds = new Set(locationRows.map((row) => row.location_id));
  }

  const scopes = intersectAuthorizationScopes(organizationScopes, membershipScopes, tokenScopes);
  return {
    userId: props.userId,
    organizationId: props.organizationId,
    membershipId: props.membershipId,
    role: membership.role,
    scopes,
    locationIds,
    sensitivePiiEnabled: membership.sensitive_pii_enabled === 1,
  };
}

export async function availableScopesForMembership(
  env: CafeEnvironment,
  membership: MembershipRow,
): Promise<OAuthScope[]> {
  const { results: rows } = await env.TOAST_MCP_DB.prepare(
    "SELECT scope FROM organization_scopes WHERE organization_id = ? AND enabled = 1",
  )
    .bind(membership.organization_id)
    .all<{ scope: string }>();
  if (membership.role === "owner") return membershipScopeCeiling("owner", rows.map((row) => row.scope));
  const { results: memberRows } = await env.TOAST_MCP_DB.prepare("SELECT scope FROM member_scopes WHERE membership_id = ?")
    .bind(membership.id).all<{ scope: string }>();
  return membershipScopeCeiling("member", rows.map((row) => row.scope), memberRows.map((row) => row.scope));
}

export function membershipScopeCeiling(
  role: MembershipRole,
  enabledToastScopes: readonly string[],
  explicitMemberScopes: readonly string[] = [],
): OAuthScope[] {
  const toastScopes = enabledToastScopes
    .filter((scope): scope is (typeof TOAST_STANDARD_SCOPES)[number] => (TOAST_STANDARD_SCOPES as readonly string[]).includes(scope))
    .map(toOAuthToastScope);
  const organizationScopes = new Set<OAuthScope>([...CAFE_SCOPES, ...toastScopes]);
  if (role === "owner") return [...organizationScopes];
  return explicitMemberScopes.filter(
    (scope): scope is OAuthScope => isSupportedOAuthScope(scope) && organizationScopes.has(scope),
  );
}

export async function listLocationsForAccess(
  env: CafeEnvironment,
  access: EffectiveAccess,
  includeInactive = false,
): Promise<ToastLocationRecord[]> {
  const statusClause = includeInactive ? "" : " AND l.status = 'active'";
  const { results } = await env.TOAST_MCP_DB.prepare(
    `SELECT l.id, l.organization_id, l.connection_id, l.toast_guid, l.restaurant_name, l.location_name,
            l.timezone, l.status, l.pending_connection_id
       FROM toast_locations l
      WHERE l.organization_id = ?${statusClause}
      ORDER BY COALESCE(l.location_name, l.restaurant_name), l.restaurant_name`,
  )
    .bind(access.organizationId)
    .all<ToastLocationRecord>();
  return access.locationIds === null ? results : results.filter((row) => access.locationIds?.has(row.id));
}

export async function requireLocationAccess(
  env: CafeEnvironment,
  access: EffectiveAccess,
  locationId: string,
): Promise<{ location: ToastLocationRecord; connection: ToastConnectionRecord }> {
  if (access.locationIds !== null && !access.locationIds.has(locationId)) {
    throw new CafeError("LOCATION_DENIED", "You do not have access to that Toast location.", 403);
  }
  const location = await env.TOAST_MCP_DB.prepare(
    `SELECT id, organization_id, connection_id, toast_guid, restaurant_name, location_name, timezone, status, pending_connection_id
       FROM toast_locations
      WHERE id = ? AND organization_id = ? AND status = 'active'`,
  )
    .bind(locationId, access.organizationId)
    .first<ToastLocationRecord>();
  if (!location) throw new CafeError("LOCATION_DENIED", "The Toast location is unavailable.", 403);
  const connection = await env.TOAST_MCP_DB.prepare(
    `SELECT id, organization_id, kind, environment, client_id, encrypted_client_secret,
            secret_nonce, secret_key_version, status
       FROM toast_connections
      WHERE id = ? AND organization_id = ? AND status = 'active'`,
  )
    .bind(location.connection_id, access.organizationId)
    .first<ToastConnectionRecord>();
  if (!connection) throw new CafeError("TOAST_AUTH_FAILED", "The Toast connection is unavailable.", 409);
  return { location, connection };
}

export async function listMembers(
  env: CafeEnvironment,
  organizationId: string,
): Promise<MemberSummary[]> {
  const { results } = await env.TOAST_MCP_DB.prepare(
    `SELECT m.id, m.user_id, u.email, u.display_name, m.role, m.status
       FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = ? ORDER BY m.role DESC, u.email`,
  )
    .bind(organizationId)
    .all<{
      id: string;
      user_id: string;
      email: string;
      display_name: string | null;
      role: MembershipRole;
      status: "active" | "revoked";
    }>();
  const members: MemberSummary[] = [];
  for (const row of results) {
    const [scopes, locations] = await Promise.all([
      env.TOAST_MCP_DB.prepare("SELECT scope FROM member_scopes WHERE membership_id = ? ORDER BY scope")
        .bind(row.id)
        .all<{ scope: string }>(),
      env.TOAST_MCP_DB.prepare("SELECT location_id FROM member_locations WHERE membership_id = ? ORDER BY location_id")
        .bind(row.id)
        .all<{ location_id: string }>(),
    ]);
    members.push({
      id: row.id,
      userId: row.user_id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      status: row.status,
      scopes: scopes.results.map((item) => item.scope),
      locationIds: locations.results.map((item) => item.location_id),
    });
  }
  return members;
}

export async function createInvitation(
  env: CafeEnvironment,
  ownerUserId: string,
  organizationId: string,
  email: string,
  locationIds: string[],
  scopes: string[],
): Promise<{ id: string; token: string }> {
  const membership = await requireMembership(env, ownerUserId, organizationId, true);
  const emailNormalized = normalizeEmail(email);
  if (!emailNormalized.includes("@")) throw new CafeError("VALIDATION_FAILED", "Enter a valid email address.");

  const normalizedScopes = [...new Set(scopes)].filter(isSupportedOAuthScope);
  if (normalizedScopes.some(isSensitiveOAuthScope) && membership.sensitive_pii_enabled !== 1) {
    throw new CafeError("SCOPE_DENIED", "Sensitive PII scopes are not enabled for this organization.", 403);
  }
  const { results: validLocations } = await env.TOAST_MCP_DB.prepare(
    "SELECT id FROM toast_locations WHERE organization_id = ? AND status = 'active'",
  )
    .bind(organizationId)
    .all<{ id: string }>();
  const validLocationIds = new Set(validLocations.map((row) => row.id));
  if (locationIds.some((id) => !validLocationIds.has(id))) {
    throw new CafeError("LOCATION_DENIED", "An invitation contains an unavailable location.", 403);
  }

  const token = randomToken();
  const tokenHash = await sha256(token);
  const id = `inv_${crypto.randomUUID()}`;
  const timestamp = nowIso();
  await env.TOAST_MCP_DB.prepare(
    `INSERT INTO invitations
      (id, organization_id, email_normalized, token_hash, location_ids_json, scopes_json,
       invited_by_user_id, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      organizationId,
      emailNormalized,
      tokenHash,
      JSON.stringify([...new Set(locationIds)]),
      JSON.stringify(normalizedScopes),
      ownerUserId,
      futureIso(7 * 24 * 60 * 60),
      timestamp,
      timestamp,
    )
    .run();
  return { id, token };
}

export async function acceptInvitation(
  env: CafeEnvironment,
  userId: string,
  userEmail: string,
  token: string,
): Promise<string> {
  const tokenHash = await sha256(token);
  const timestamp = nowIso();
  const invitation = await env.TOAST_MCP_DB.prepare(
    `SELECT id, organization_id, email_normalized, location_ids_json, scopes_json
       FROM invitations
      WHERE token_hash = ? AND status = 'pending' AND expires_at > ?`,
  )
    .bind(tokenHash, timestamp)
    .first<{
      id: string;
      organization_id: string;
      email_normalized: string;
      location_ids_json: string;
      scopes_json: string;
    }>();
  if (!invitation) throw new CafeError("NOT_FOUND", "The invitation is invalid or expired.", 404);
  if (invitation.email_normalized !== normalizeEmail(userEmail)) {
    throw new CafeError("AUTH_REQUIRED", "Sign in with the email address that received this invitation.", 403);
  }

  const existingMembership = await env.TOAST_MCP_DB.prepare(
    "SELECT id FROM memberships WHERE organization_id = ? AND user_id = ?",
  )
    .bind(invitation.organization_id, userId)
    .first<{ id: string }>();
  const membershipId = existingMembership?.id ?? `mem_${crypto.randomUUID()}`;
  const locationIds = JSON.parse(invitation.location_ids_json) as string[];
  const scopes = JSON.parse(invitation.scopes_json) as string[];
  const statements: D1PreparedStatement[] = [
    env.TOAST_MCP_DB.prepare(
      `UPDATE invitations SET status = 'accepted', accepted_by_user_id = ?, accepted_at = ?, updated_at = ?
        WHERE id = ? AND status = 'pending' AND expires_at > ? AND email_normalized = ?`,
    ).bind(userId, timestamp, timestamp, invitation.id, timestamp, normalizeEmail(userEmail)),
    env.TOAST_MCP_DB.prepare(
      `INSERT INTO memberships (id, organization_id, user_id, role, status, created_at, updated_at)
       SELECT ?, organization_id, ?, 'member', 'active', ?, ? FROM invitations
        WHERE id = ? AND accepted_by_user_id = ? AND accepted_at = ?
       ON CONFLICT(organization_id, user_id) DO UPDATE SET status = 'active', revoked_at = NULL, updated_at = excluded.updated_at`,
    ).bind(membershipId, userId, timestamp, timestamp, invitation.id, userId, timestamp),
    env.TOAST_MCP_DB.prepare(
      "DELETE FROM member_scopes WHERE membership_id = ? AND EXISTS (SELECT 1 FROM invitations WHERE id = ? AND accepted_by_user_id = ? AND accepted_at = ?)",
    ).bind(membershipId, invitation.id, userId, timestamp),
    env.TOAST_MCP_DB.prepare(
      "DELETE FROM member_locations WHERE membership_id = ? AND EXISTS (SELECT 1 FROM invitations WHERE id = ? AND accepted_by_user_id = ? AND accepted_at = ?)",
    ).bind(membershipId, invitation.id, userId, timestamp),
  ];
  for (const scope of scopes.filter(isSupportedOAuthScope)) {
    statements.push(
      env.TOAST_MCP_DB.prepare(
        `INSERT OR IGNORE INTO member_scopes (membership_id, scope, created_at)
         SELECT ?, ?, ? WHERE EXISTS
          (SELECT 1 FROM invitations WHERE id = ? AND accepted_by_user_id = ? AND accepted_at = ?)`,
      ).bind(membershipId, scope, timestamp, invitation.id, userId, timestamp),
    );
  }
  for (const locationId of locationIds) {
    statements.push(
      env.TOAST_MCP_DB.prepare(
        `INSERT OR IGNORE INTO member_locations (membership_id, location_id, created_at)
         SELECT ?, ?, ? WHERE EXISTS
          (SELECT 1 FROM invitations WHERE id = ? AND accepted_by_user_id = ? AND accepted_at = ?)`,
      ).bind(membershipId, locationId, timestamp, invitation.id, userId, timestamp),
    );
  }
  const results = await env.TOAST_MCP_DB.batch(statements);
  if (!results[0]?.meta.changes) throw new CafeError("NOT_FOUND", "The invitation was already used or expired.", 404);
  return invitation.organization_id;
}

export async function setSensitivePiiEnabled(
  env: CafeEnvironment,
  ownerUserId: string,
  organizationId: string,
  enabled: boolean,
): Promise<void> {
  await requireMembership(env, ownerUserId, organizationId, true);
  const timestamp = nowIso();
  const statements = [
    env.TOAST_MCP_DB.prepare("UPDATE organizations SET sensitive_pii_enabled = ?, updated_at = ? WHERE id = ?")
      .bind(enabled ? 1 : 0, timestamp, organizationId),
    ...[...SENSITIVE_TOAST_SCOPES].map((scope) =>
      env.TOAST_MCP_DB.prepare(
        "UPDATE organization_scopes SET enabled = ?, updated_at = ? WHERE organization_id = ? AND scope = ?",
      ).bind(enabled ? 1 : 0, timestamp, organizationId, scope),
    ),
  ];
  await env.TOAST_MCP_DB.batch(statements);
}

export async function auditEvent(
  env: CafeEnvironment,
  input: {
    requestId: string;
    userId?: string;
    organizationId?: string;
    locationId?: string;
    operationId?: string;
    eventType: string;
    outcome: string;
    statusCode?: number;
    durationMs?: number;
  },
): Promise<void> {
  await env.TOAST_MCP_DB.prepare(
    `INSERT INTO audit_events
      (id, request_id, user_id, organization_id, location_id, operation_id,
       event_type, outcome, status_code, duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      `aud_${crypto.randomUUID()}`,
      input.requestId,
      input.userId ?? null,
      input.organizationId ?? null,
      input.locationId ?? null,
      input.operationId ?? null,
      input.eventType,
      input.outcome,
      input.statusCode ?? null,
      input.durationMs ?? null,
      nowIso(),
    )
    .run();
}

export async function cleanupExpiredRecords(env: CafeEnvironment): Promise<void> {
  const timestamp = nowIso();
  const auditCutoff = new Date(Date.now() - Number.parseInt(env.AUDIT_RETENTION_DAYS, 10) * 86_400_000).toISOString();
  const expiredResults = await env.TOAST_MCP_DB.prepare(
    "SELECT id, chunk_count FROM result_objects WHERE expires_at <= ? LIMIT 100",
  )
    .bind(timestamp)
    .all<{ id: string; chunk_count: number }>();
  for (const result of expiredResults.results) {
    const keys = Array.from({ length: result.chunk_count }, (_, index) => `results/${result.id}/chunk-${index}.json`);
    await env.TOAST_RESULTS.delete(keys);
    await env.TOAST_MCP_DB.prepare("DELETE FROM result_objects WHERE id = ? AND expires_at <= ?")
      .bind(result.id, timestamp).run();
  }
  await env.TOAST_MCP_DB.batch([
    env.TOAST_MCP_DB.prepare("DELETE FROM sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL").bind(timestamp),
    env.TOAST_MCP_DB.prepare("UPDATE invitations SET status = 'expired', updated_at = ? WHERE status = 'pending' AND expires_at <= ?")
      .bind(timestamp, timestamp),
    env.TOAST_MCP_DB.prepare("DELETE FROM audit_events WHERE created_at < ?").bind(auditCutoff),
    env.TOAST_MCP_DB.prepare("DELETE FROM request_rate_buckets WHERE expires_at <= ?").bind(timestamp),
  ]);
}
