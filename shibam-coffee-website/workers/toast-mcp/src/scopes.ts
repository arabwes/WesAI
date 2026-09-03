export const CAFE_SCOPES = [
  "cafe/catalog:read",
  "cafe/locations:read",
  "cafe/results:read",
] as const;

export const TOAST_STANDARD_SCOPES = [
  "cashmgmt:read",
  "config:read",
  "delivery_info.address:read",
  "device-details.info:read",
  "digital_schedule:read",
  "guest.pi:read",
  "kitchen:read",
  "labor.employees:read",
  "labor:read",
  "menus:read",
  "orders:read",
  "packaging:read",
  "restaurants:read",
  "stock:read",
] as const;

export type ToastStandardScope = (typeof TOAST_STANDARD_SCOPES)[number];
export type CafeScope = (typeof CAFE_SCOPES)[number];
export type OAuthScope = CafeScope | `toast/${ToastStandardScope}`;

export const SENSITIVE_TOAST_SCOPES = new Set<ToastStandardScope>([
  "guest.pi:read",
  "delivery_info.address:read",
]);

export const ALL_OAUTH_SCOPES: OAuthScope[] = [
  ...CAFE_SCOPES,
  ...TOAST_STANDARD_SCOPES.map((scope) => `toast/${scope}` as const),
];

export const BASE_MCP_SCOPES: OAuthScope[] = ["cafe/catalog:read", "cafe/locations:read"];

export function toOAuthToastScope(scope: ToastStandardScope): OAuthScope {
  return `toast/${scope}`;
}

export function isSupportedOAuthScope(scope: string): scope is OAuthScope {
  return (ALL_OAUTH_SCOPES as string[]).includes(scope);
}

export function isSensitiveOAuthScope(scope: string): boolean {
  if (!scope.startsWith("toast/")) return false;
  return SENSITIVE_TOAST_SCOPES.has(scope.slice("toast/".length) as ToastStandardScope);
}

export function intersectAuthorizationScopes(
  organizationScopes: ReadonlySet<string>,
  membershipScopes: ReadonlySet<string>,
  consentScopes: readonly string[],
): Set<string> {
  return new Set(consentScopes.filter((scope) => organizationScopes.has(scope) && membershipScopes.has(scope)));
}
