import { CafeError } from "../errors";
import type { CafeEnvironment } from "../runtime";

export interface BankBindings {
  BANK_OAUTH_KV?: KVNamespace;
  BANK_BASE_PATH?: string;
  BANK_MODE?: string;
}

export type BankEnvironment = CafeEnvironment & {
  BANK_MODE: "disabled" | "enabled";
};

function isUnder(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function isBankPath(pathname: string, env: CafeEnvironment & BankBindings): boolean {
  const base = env.BANK_BASE_PATH;
  if (!base || base === env.BASE_PATH) return false;
  return isUnder(pathname, base)
    || isUnder(pathname, `/.well-known/oauth-protected-resource${base}`)
    || isUnder(pathname, `/.well-known/oauth-authorization-server${base}`);
}

/**
 * BankCafeMCP reuses the Worker's D1 identity tables and Auth0 app, but gets its
 * own base path and its own OAuth KV namespace, so bank OAuth clients, grants,
 * and tokens are never stored alongside (or readable by) the Toast provider.
 */
export function bankEnvironment(env: CafeEnvironment & BankBindings): BankEnvironment {
  if (!env.BANK_OAUTH_KV || !env.BANK_BASE_PATH || env.BANK_BASE_PATH === env.BASE_PATH) {
    throw new CafeError("FEATURE_DISABLED", "BankCafeMCP is not configured.", 503);
  }
  if (env.BANK_OAUTH_KV === env.OAUTH_KV) {
    throw new CafeError("INTERNAL_ERROR", "BankCafeMCP requires its own OAuth KV namespace.", 500);
  }
  // The OAuth provider only creates helpers when env.OAUTH_PROVIDER is absent, and the
  // Worker env object is reused across requests, so the Toast provider's helpers (bound
  // to the Toast KV) must never be copied into the bank environment.
  const { OAUTH_PROVIDER: _toastHelpers, ...shared } = env;
  return {
    ...shared,
    OAUTH_KV: env.BANK_OAUTH_KV,
    BASE_PATH: env.BANK_BASE_PATH,
    BANK_MODE: env.BANK_MODE === "enabled" ? "enabled" : "disabled",
  } as BankEnvironment;
}

export function assertBankMode(env: BankEnvironment): void {
  if (env.BANK_MODE !== "enabled") {
    throw new CafeError("FEATURE_DISABLED", "BankCafeMCP is disabled for this deployment.", 503);
  }
}
