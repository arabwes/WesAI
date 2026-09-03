import { GENERATED_OPERATION_CATALOG } from "./operation-catalog.generated";
import type { ToastStandardScope } from "../scopes";

export interface CatalogParameter {
  name: string;
  in: "path" | "query";
  required: boolean;
  type: "string" | "integer" | "number" | "boolean" | "array";
  description: string;
}

export interface CatalogOperation {
  id: string;
  sourceOperationId?: string;
  domain: string;
  method: "GET" | "POST";
  path: string;
  specificationPath?: string;
  description: string;
  requiredScope: ToastStandardScope;
  additionalScopes: readonly ToastStandardScope[];
  sensitivity: "operational" | "pii" | "orders" | "labor" | "cash";
  persistable: boolean;
  parameters: readonly CatalogParameter[];
  requestBody: boolean;
  bodyRequired: boolean;
  bodyRootType: string | null;
  bodyRequiredProperties: readonly string[];
  pagination: "none" | "parameterized";
  source: string;
  classification?: "exposed";
  reviewedReadOnlyPost?: boolean;
  exclusionReason?: null;
}

const catalog = GENERATED_OPERATION_CATALOG as readonly CatalogOperation[];
const byId = new Map(catalog.map((operation) => [operation.id, operation]));

export function getOperation(operationId: string): CatalogOperation | null {
  return byId.get(operationId) ?? null;
}

export function searchOperations(options: {
  text?: string | undefined;
  domain?: string | undefined;
  scope?: string | undefined;
  sensitivity?: string | undefined;
  permittedScopes: ReadonlySet<string>;
  limit?: number | undefined;
}): CatalogOperation[] {
  const text = options.text?.trim().toLowerCase();
  const scope = options.scope?.startsWith("toast/") ? options.scope.slice("toast/".length) : options.scope;
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
  return catalog
    .filter((operation) => options.permittedScopes.has(`toast/${operation.requiredScope}`))
    .filter((operation) => operation.additionalScopes.every((scope) => options.permittedScopes.has(`toast/${scope}`)))
    .filter((operation) => !options.domain || operation.domain === options.domain)
    .filter((operation) => !scope || operation.requiredScope === scope)
    .filter((operation) => !options.sensitivity || operation.sensitivity === options.sensitivity)
    .filter((operation) => !text || `${operation.id} ${operation.domain} ${operation.description} ${operation.path}`.toLowerCase().includes(text))
    .slice(0, limit);
}

export function listCatalog(): readonly CatalogOperation[] {
  return catalog;
}
