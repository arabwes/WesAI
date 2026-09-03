import type { CatalogOperation } from "./toast/operations";

const guestFields = new Set([
  "customer", "guest", "guestname", "customername", "firstname", "lastname",
  "email", "emailaddress", "phone", "phonenumber",
]);
const deliveryAddressFields = new Set(["deliveryinfo", "deliveryaddress"]);

/**
 * Toast credential tokens cannot be down-scoped per request. Defense-in-depth
 * redaction therefore removes optional order PII unless the local three-way
 * authorization intersection contains the corresponding sensitive scope.
 */
export function applyResponsePolicy(
  value: unknown,
  operation: CatalogOperation,
  effectiveScopes: ReadonlySet<string>,
): unknown {
  if (operation.domain !== "orders") return value;
  const allowGuest = effectiveScopes.has("toast/guest.pi:read");
  const allowDeliveryAddress = effectiveScopes.has("toast/delivery_info.address:read");
  if (allowGuest && allowDeliveryAddress) return value;

  const visit = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(visit);
    if (!current || typeof current !== "object") return current;
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
      const normalized = key.replace(/[^a-z]/giu, "").toLowerCase();
      if (!allowGuest && guestFields.has(normalized)) continue;
      if (!allowDeliveryAddress && deliveryAddressFields.has(normalized)) continue;
      output[key] = visit(child);
    }
    return output;
  };
  return visit(value);
}
