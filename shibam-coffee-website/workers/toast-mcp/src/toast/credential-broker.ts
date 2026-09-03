import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { CafeError } from "../errors";
import type { BrokerEnvironment, ConnectionEnvironment } from "../runtime";

const tokenResponseSchema = z.object({
  token: z.object({
    accessToken: z.string().min(1),
    expiresIn: z.number().positive().optional(),
  }),
});

export interface CredentialInput {
  credentialKey: string;
  environment: ConnectionEnvironment;
  clientId: string;
  clientSecret: string;
}

export interface PermitResult {
  allowed: boolean;
  retryAfterSeconds: number;
  retryAfterMilliseconds: number;
}

function authUrl(environment: ConnectionEnvironment): string {
  return environment === "production"
    ? "https://ws-api.toasttab.com/authentication/v1/authentication/login"
    : "https://ws-sandbox-api.eng.toasttab.com/authentication/v1/authentication/login";
}

export class CafeCredentialBroker extends DurableObject<BrokerEnvironment> {
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;
  private credentialKey: string | null = null;
  private refreshPromise: Promise<string> | null = null;
  private nextPermitAt = 0;
  private blockedUntil = 0;

  async acquirePermit(minimumIntervalMs = 100): Promise<PermitResult> {
    const now = Date.now();
    const availableAt = Math.max(this.nextPermitAt, this.blockedUntil);
    if (now < availableAt) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((availableAt - now) / 1000)),
        retryAfterMilliseconds: availableAt - now,
      };
    }
    const boundedInterval = Math.max(100, Math.min(10_000, Math.ceil(minimumIntervalMs)));
    this.nextPermitAt = now + boundedInterval;
    return { allowed: true, retryAfterSeconds: 0, retryAfterMilliseconds: 0 };
  }

  async getAccessToken(credentials: CredentialInput): Promise<string> {
    if (this.credentialKey !== null && this.credentialKey !== credentials.credentialKey) {
      this.accessToken = null;
      this.tokenExpiresAt = 0;
    }
    this.credentialKey = credentials.credentialKey;
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60_000) return this.accessToken;
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.fetchAccessToken(credentials);
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  async invalidateToken(): Promise<void> {
    this.accessToken = null;
    this.tokenExpiresAt = 0;
  }

  async reportRateLimit(retryAfterSeconds: number): Promise<void> {
    const bounded = Math.max(1, Math.min(900, Math.ceil(retryAfterSeconds)));
    this.blockedUntil = Math.max(this.blockedUntil, Date.now() + bounded * 1000);
  }

  private async fetchAccessToken(credentials: CredentialInput): Promise<string> {
    const response = await fetch(authUrl(credentials.environment), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "CafeMCP/0.1",
      },
      body: JSON.stringify({
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        userAccessType: "TOAST_MACHINE_CLIENT",
      }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401 || response.status === 403) {
      throw new CafeError("TOAST_AUTH_FAILED", "Toast rejected the integration credentials.", 401);
    }
    if (!response.ok) {
      throw new CafeError("TOAST_UPSTREAM_ERROR", "Toast authentication is temporarily unavailable.", 502);
    }
    const parsed = tokenResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new CafeError("TOAST_UPSTREAM_ERROR", "Toast returned an invalid authentication response.", 502);
    }
    this.accessToken = parsed.data.token.accessToken;
    this.tokenExpiresAt = Date.now() + (parsed.data.token.expiresIn ?? 86_400) * 1000;
    return this.accessToken;
  }
}
