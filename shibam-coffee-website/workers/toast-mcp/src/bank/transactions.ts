import { CafeError } from "../errors";
import type { PlaidTransaction } from "./plaid";

export const MAX_TRANSACTION_SPAN_DAYS = 730;

export function assertTransactionWindow(startDate: string, endDate: string, today = new Date()): void {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  if (start > end) throw new CafeError("VALIDATION_FAILED", "start_date must be on or before end_date.");
  if ((end - start) / 86_400_000 > MAX_TRANSACTION_SPAN_DAYS) {
    throw new CafeError("VALIDATION_FAILED", `The date range cannot exceed ${MAX_TRANSACTION_SPAN_DAYS} days.`);
  }
  if (end > today.getTime() + 86_400_000) throw new CafeError("VALIDATION_FAILED", "end_date cannot be in the future.");
}

export interface TransactionFilter {
  direction?: "outflow" | "inflow" | undefined;
  minAbsAmount?: number | undefined;
  maxAbsAmount?: number | undefined;
  text?: string | undefined;
  includePending: boolean;
}

export function filterTransactions(transactions: readonly PlaidTransaction[], filter: TransactionFilter): PlaidTransaction[] {
  const needle = filter.text?.toLowerCase();
  return transactions.filter((transaction) => {
    if (!filter.includePending && transaction.pending) return false;
    if (filter.direction === "outflow" && transaction.amount <= 0) return false;
    if (filter.direction === "inflow" && transaction.amount >= 0) return false;
    const magnitude = Math.abs(transaction.amount);
    if (filter.minAbsAmount !== undefined && magnitude < filter.minAbsAmount) return false;
    if (filter.maxAbsAmount !== undefined && magnitude > filter.maxAbsAmount) return false;
    if (needle) {
      const haystack = `${transaction.merchant_name ?? ""} ${transaction.name ?? ""}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
}

/** Public transaction shape: internal account IDs only, no Plaid identifiers. */
export function toPublicTransaction(transaction: PlaidTransaction, accountIdByPlaidId: ReadonlyMap<string, string>) {
  return {
    account_id: accountIdByPlaidId.get(transaction.account_id) ?? null,
    date: transaction.date,
    authorized_date: transaction.authorized_date ?? null,
    description: transaction.name ?? null,
    merchant_name: transaction.merchant_name ?? null,
    amount: transaction.amount,
    currency: transaction.iso_currency_code ?? transaction.unofficial_currency_code ?? null,
    pending: transaction.pending,
    category_primary: transaction.personal_finance_category?.primary ?? null,
    category_detailed: transaction.personal_finance_category?.detailed ?? null,
    payment_channel: transaction.payment_channel ?? null,
  };
}
