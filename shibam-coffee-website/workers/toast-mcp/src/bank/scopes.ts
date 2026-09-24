export const BANK_SCOPES = [
  "bank/accounts:read",
  "bank/balances:read",
  "bank/transactions:read",
] as const;

export type BankScope = (typeof BANK_SCOPES)[number];

export const BANK_BASE_SCOPES: readonly BankScope[] = ["bank/accounts:read"];

export const BANK_SCOPE_DESCRIPTIONS: Record<BankScope, string> = {
  "bank/accounts:read": "Account names, types, and last four digits",
  "bank/balances:read": "Current and available balances",
  "bank/transactions:read": "Transaction history (dates, merchants, amounts)",
};

export function isBankScope(scope: string): scope is BankScope {
  return (BANK_SCOPES as readonly string[]).includes(scope);
}

/** Consent result: only bank scopes the client requested AND the owner ticked. */
export function grantedBankScopes(requested: readonly string[], selected: readonly string[]): BankScope[] {
  const requestedBank = requested.filter(isBankScope);
  const ceiling = new Set<BankScope>(requestedBank.length ? requestedBank : BANK_BASE_SCOPES);
  return [...new Set(selected.filter(isBankScope))].filter((scope) => ceiling.has(scope));
}
