import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { CafeCredentialBroker } from "./toast/credential-broker";

export type ConnectionEnvironment = "production" | "sandbox";
export type ConnectionKind = "byo" | "partner";
export type ConnectionStatus = "active" | "invalid" | "disconnected" | "removed";
export type LocationStatus = ConnectionStatus | "pending_migration";
export type MembershipRole = "owner" | "member";

export type CafeJob =
  | {
      kind: "invitation_email";
      invitationId: string;
      token: string;
    }
  | {
      kind: "partner_event";
      partnerEventId: string;
    };

export interface WorkerSecrets {
  AUTH0_CLIENT_SECRET: string;
  SESSION_SIGNING_KEY: string;
  CREDENTIAL_KEK_V1: string;
  RESULT_KEK_V1: string;
  RESEND_API_KEY?: string;
  TOAST_PARTNER_CLIENT_ID?: string;
  TOAST_PARTNER_CLIENT_SECRET?: string;
  TOAST_PARTNER_WEBHOOK_SECRET?: string;
}

export type BrokerEnvironment = Env & WorkerSecrets;

export type CafeEnvironment = Omit<Env, keyof WorkerSecrets | "CAFE_CREDENTIAL_BROKER" | "CAFE_MCP_JOBS" | "TOAST_PARTNER_MODE" | "TOAST_BYO_MODE"> &
  WorkerSecrets & {
    TOAST_PARTNER_MODE: "disabled" | "enabled";
    TOAST_BYO_MODE: "disabled" | "enabled";
    OAUTH_PROVIDER: OAuthHelpers;
    CAFE_MCP_JOBS: Queue<CafeJob>;
    CAFE_CREDENTIAL_BROKER: DurableObjectNamespace<CafeCredentialBroker>;
  };

export interface AuthProps extends Record<string, unknown> {
  userId: string;
  organizationId: string;
  membershipId: string;
}

export interface IdentityClaims {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
}

export interface SessionIdentity {
  sessionToken: string;
  csrfToken: string;
  userId: string;
  activeOrganizationId: string | null;
  email: string;
  displayName: string | null;
}

export interface EffectiveAccess {
  userId: string;
  organizationId: string;
  membershipId: string;
  role: MembershipRole;
  scopes: Set<string>;
  locationIds: Set<string> | null;
  sensitivePiiEnabled: boolean;
}

export interface ToastConnectionRecord {
  id: string;
  organization_id: string;
  kind: ConnectionKind;
  environment: ConnectionEnvironment;
  client_id: string | null;
  encrypted_client_secret: string | null;
  secret_nonce: string | null;
  secret_key_version: number | null;
  status: ConnectionStatus;
}

export interface ToastLocationRecord {
  id: string;
  organization_id: string;
  connection_id: string;
  toast_guid: string;
  restaurant_name: string;
  location_name: string | null;
  timezone: string | null;
  status: LocationStatus;
  pending_connection_id?: string | null;
}
