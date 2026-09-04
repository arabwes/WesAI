import { z } from "zod";
import { decryptValue, sha256 } from "../crypto";
import { CafeError } from "../errors";
import type {
  CafeEnvironment,
  ConnectionEnvironment,
  ToastConnectionRecord,
  ToastLocationRecord,
} from "../runtime";
import type { CatalogOperation } from "./operations";
import type { CredentialInput } from "./credential-broker";

const MAX_TOAST_RESPONSE_BYTES = 32 * 1024 * 1024;

const restaurantSchema = z
  .object({
    guid: z.string().optional(),
    restaurantGuid: z.string().optional(),
    general: z
      .object({
        name: z.string().optional(),
        locationName: z.string().nullable().optional(),
        timeZone: z.string().nullable().optional(),
      })
      .optional(),
    restaurantName: z.string().optional(),
    locationName: z.string().nullable().optional(),
    timezone: z.string().nullable().optional(),
  })
  .passthrough();

export interface ToastCredentials {
  credentialKey: string;
  environment: ConnectionEnvironment;
  clientId: string;
  clientSecret: string;
}

export interface ToastResponse {
  status: number;
  data: unknown;
  bytes: number;
  requestId: string | null;
  rateLimitRemaining: number | null;
  rateLimitReset: string | null;
}

function baseUrl(environment: ConnectionEnvironment): string {
  return environment === "production" ? "https://ws-api.toasttab.com" : "https://ws-sandbox-api.eng.toasttab.com";
}

export async function credentialsForConnection(
  env: CafeEnvironment,
  connection: ToastConnectionRecord,
): Promise<ToastCredentials> {
  if (connection.kind === "partner") {
    if (
      env.TOAST_PARTNER_MODE !== "enabled" ||
      !env.TOAST_PARTNER_CLIENT_ID ||
      !env.TOAST_PARTNER_CLIENT_SECRET
    ) {
      throw new CafeError("FEATURE_DISABLED", "Toast partner access is not enabled.", 503);
    }
    return {
      credentialKey: `partner-v1-${connection.environment}`,
      environment: connection.environment,
      clientId: env.TOAST_PARTNER_CLIENT_ID,
      clientSecret: env.TOAST_PARTNER_CLIENT_SECRET,
    };
  }

  if (
    !connection.client_id ||
    !connection.encrypted_client_secret ||
    !connection.secret_nonce ||
    connection.secret_key_version !== 1
  ) {
    throw new CafeError("TOAST_AUTH_FAILED", "The Toast credential record is invalid.", 409);
  }
  const clientSecret = await decryptValue(
    {
      ciphertext: connection.encrypted_client_secret,
      nonce: connection.secret_nonce,
      keyVersion: connection.secret_key_version,
    },
    env.CREDENTIAL_KEK_V1,
    `toast-connection:${connection.organization_id}:${connection.id}`,
  );
  return {
    credentialKey: await sha256(`${connection.id}:${connection.client_id}:${connection.secret_nonce}:${connection.secret_key_version}`),
    environment: connection.environment,
    clientId: connection.client_id,
    clientSecret,
  };
}

async function readBoundedJson(response: Response): Promise<{ data: unknown; bytes: number }> {
  if (!response.body) return { data: null, bytes: 0 };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_TOAST_RESPONSE_BYTES) {
      await reader.cancel("Toast response exceeded the Cafe MCP safety limit");
      throw new CafeError("TOAST_UPSTREAM_ERROR", "Toast returned a response larger than the 32 MiB safety limit.", 502);
    }
    chunks.push(value);
  }
  if (total === 0) return { data: null, bytes: 0 };
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { data: JSON.parse(new TextDecoder().decode(joined)), bytes: total };
  } catch {
    throw new CafeError("TOAST_UPSTREAM_ERROR", "Toast returned a non-JSON response.", 502);
  }
}

function parseRetryAfter(value: string | null): number {
  if (!value) return 1;
  const seconds = Number.parseFloat(value);
  if (Number.isFinite(seconds)) return Math.max(1, Math.ceil(seconds));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(1, Math.ceil((date - Date.now()) / 1000)) : 1;
}

function parseRateLimitReset(value: string | null): number | null {
  if (!value) return null;
  const numeric = Number.parseFloat(value);
  if (Number.isFinite(numeric)) {
    if (numeric > 1_000_000_000_000) return Math.max(1, Math.ceil((numeric - Date.now()) / 1000));
    if (numeric > 1_000_000_000) return Math.max(1, Math.ceil(numeric - Date.now() / 1000));
    return Math.max(1, Math.ceil(numeric));
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(1, Math.ceil((date - Date.now()) / 1000)) : null;
}

export function minimumToastRequestIntervalMs(
  operation: Pick<CatalogOperation, "id" | "path">,
  query: Record<string, string | number | boolean | string[]>,
): number {
  // Toast documents Menus V2 at one request per second per restaurant.
  if (operation.id === "menus_menusGet" || operation.path === "/menus/v2/menus") return 1_000;
  // Toast recommends slow polling when ordersBulk is queried by modified-date range.
  if (
    (operation.id === "orders_ordersBulkGet" || operation.path === "/orders/v2/ordersBulk") &&
    (query.startDate !== undefined || query.endDate !== undefined)
  ) return 5_000;
  return 100;
}

export function buildOperationUrl(
  environment: ConnectionEnvironment,
  operation: CatalogOperation,
  pathParams: Record<string, string | number>,
  query: Record<string, string | number | boolean | string[]>,
): URL {
  let path = operation.path;
  const pathParameters = operation.parameters.filter((item) => item.in === "path");
  const allowedPath = new Set(pathParameters.map((parameter) => parameter.name));
  for (const name of Object.keys(pathParams)) {
    if (!allowedPath.has(name)) throw new CafeError("VALIDATION_FAILED", `Unsupported path parameter: ${name}`);
  }
  for (const parameter of pathParameters) {
    const value = pathParams[parameter.name];
    if (value === undefined) {
      if (parameter.required) throw new CafeError("VALIDATION_FAILED", `Missing path parameter: ${parameter.name}`);
      continue;
    }
    validateParameterType(parameter.name, parameter.type, value);
    path = path.replace(`{${parameter.name}}`, encodeURIComponent(String(value)));
  }
  if (/\{[^}]+\}/u.test(path)) throw new CafeError("VALIDATION_FAILED", "A required path parameter is missing.");
  const fixedBaseUrl = baseUrl(environment);
  const url = new URL(path, fixedBaseUrl);
  if (url.origin !== fixedBaseUrl) {
    throw new CafeError("OPERATION_NOT_ALLOWED", "The catalog operation does not use the fixed Toast API host.", 403);
  }
  const queryParameters = operation.parameters.filter((parameter) => parameter.in === "query");
  const allowedQuery = new Map(queryParameters.map((parameter) => [parameter.name, parameter]));
  for (const [name, value] of Object.entries(query)) {
    const parameter = allowedQuery.get(name);
    if (!parameter) throw new CafeError("VALIDATION_FAILED", `Unsupported query parameter: ${name}`);
    validateParameterType(name, parameter.type, value);
    for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(name, String(item));
  }
  for (const parameter of queryParameters) {
    if (parameter.required && !url.searchParams.has(parameter.name)) {
      throw new CafeError("VALIDATION_FAILED", `Missing query parameter: ${parameter.name}`);
    }
  }
  return url;
}

function validateParameterType(name: string, type: CatalogOperation["parameters"][number]["type"], value: unknown): void {
  const valid = type === "array" ? Array.isArray(value) && value.every((item) => typeof item === "string")
    : type === "integer" ? typeof value === "number" && Number.isInteger(value)
      : type === "number" ? typeof value === "number" && Number.isFinite(value)
        : type === "boolean" ? typeof value === "boolean"
          : typeof value === "string" || typeof value === "number";
  if (!valid) throw new CafeError("VALIDATION_FAILED", `Invalid value for parameter: ${name}`);
}

async function executeWithCredentials(
  env: CafeEnvironment,
  brokerName: string,
  credentials: ToastCredentials,
  locationGuid: string,
  method: "GET" | "POST",
  url: URL,
  body: unknown,
  minimumIntervalMs = 100,
  waitForPermit = false,
  refreshed = false,
  skipPermit = false,
): Promise<ToastResponse> {
  const broker = env.CAFE_CREDENTIAL_BROKER.getByName(brokerName);
  if (!skipPermit) {
    let permit = await broker.acquirePermit(minimumIntervalMs);
    if (!permit.allowed && waitForPermit && permit.retryAfterMilliseconds <= 10_000) {
      await new Promise((resolve) => setTimeout(resolve, Math.max(10, permit.retryAfterMilliseconds)));
      permit = await broker.acquirePermit(minimumIntervalMs);
    }
    if (!permit.allowed) {
      throw new CafeError("TOAST_RATE_LIMITED", "Cafe MCP is pacing requests for this Toast credential.", 429, permit.retryAfterSeconds);
    }
  }
  const accessToken = await broker.getAccessToken(credentials satisfies CredentialInput);
  const headers = new Headers({
    Accept: "application/json",
    Authorization: `Bearer ${accessToken}`,
    "Toast-Restaurant-External-ID": locationGuid,
    "User-Agent": "CafeMCP/0.1",
  });
  const init: RequestInit = {
    method,
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  };
  if (method === "POST") {
    headers.set("Content-Type", "application/json");
    init.body = JSON.stringify(body ?? {});
  }
  const response = await fetch(url, init);
  if (response.status === 401 && !refreshed) {
    await broker.invalidateToken();
    return executeWithCredentials(env, brokerName, credentials, locationGuid, method, url, body, minimumIntervalMs, waitForPermit, true, true);
  }
  if (response.status === 401 || response.status === 403) {
    await broker.invalidateToken();
    throw new CafeError("TOAST_AUTH_FAILED", "Toast rejected the credential, scope, or restaurant access.", 401);
  }
  if (response.status === 429) {
    const retryAfter = parseRetryAfter(response.headers.get("Retry-After"));
    await broker.reportRateLimit(retryAfter);
    throw new CafeError("TOAST_RATE_LIMITED", "Toast rate-limited this request.", 429, retryAfter);
  }
  if (!response.ok) {
    throw new CafeError("TOAST_UPSTREAM_ERROR", `Toast returned HTTP ${response.status}.`, 502);
  }
  const parsed = await readBoundedJson(response);
  const remaining = Number.parseInt(response.headers.get("X-Toast-RateLimit-Remaining") ?? "", 10);
  const rateLimitReset = response.headers.get("X-Toast-RateLimit-Reset");
  if (remaining === 0) {
    const resetAfter = parseRateLimitReset(rateLimitReset);
    if (resetAfter !== null) await broker.reportRateLimit(resetAfter);
  }
  return {
    status: response.status,
    data: parsed.data,
    bytes: parsed.bytes,
    requestId: response.headers.get("X-Request-ID") ?? response.headers.get("Toast-Request-Id"),
    rateLimitRemaining: Number.isFinite(remaining) ? remaining : null,
    rateLimitReset,
  };
}

export async function executeToastOperation(
  env: CafeEnvironment,
  connection: ToastConnectionRecord,
  location: ToastLocationRecord,
  operation: CatalogOperation,
  pathParams: Record<string, string | number>,
  query: Record<string, string | number | boolean | string[]>,
  body: unknown,
): Promise<ToastResponse> {
  if (operation.bodyRequired && body === undefined) {
    throw new CafeError("VALIDATION_FAILED", "This operation requires a request body.");
  }
  if (body !== undefined) {
    let serialized: string;
    try { serialized = JSON.stringify(body); } catch { throw new CafeError("VALIDATION_FAILED", "The request body must be JSON-serializable."); }
    if (!serialized || new TextEncoder().encode(serialized).byteLength > 256 * 1024) {
      throw new CafeError("VALIDATION_FAILED", "The request body exceeds the 256 KiB safety limit.", 413);
    }
    if (operation.bodyRootType === "object" && (!body || typeof body !== "object" || Array.isArray(body))) {
      throw new CafeError("VALIDATION_FAILED", "The request body must be a JSON object.");
    }
    if (operation.bodyRootType === "array" && !Array.isArray(body)) {
      throw new CafeError("VALIDATION_FAILED", "The request body must be a JSON array.");
    }
    if (["string", "number", "integer", "boolean"].includes(operation.bodyRootType ?? "")) {
      const expected = operation.bodyRootType === "integer" ? "number" : operation.bodyRootType;
      if (typeof body !== expected || (operation.bodyRootType === "integer" && !Number.isInteger(body))) {
        throw new CafeError("VALIDATION_FAILED", `The request body must be a JSON ${operation.bodyRootType}.`);
      }
    }
    if (body && typeof body === "object" && !Array.isArray(body)) {
      for (const property of operation.bodyRequiredProperties) {
        if (!(property in body)) throw new CafeError("VALIDATION_FAILED", `The request body is missing required property: ${property}`);
      }
    }
  }
  const credentials = await credentialsForConnection(env, connection);
  const url = buildOperationUrl(connection.environment, operation, pathParams, query);
  return executeWithCredentials(
    env,
    connection.kind === "partner" ? `partner-v1-${connection.environment}` : connection.id,
    credentials,
    location.toast_guid,
    operation.method,
    url,
    body,
    minimumToastRequestIntervalMs(operation, query),
    false,
  );
}

export async function verifyToastRestaurant(
  env: CafeEnvironment,
  brokerName: string,
  credentials: ToastCredentials,
  restaurantGuid: string,
): Promise<{ restaurantName: string; locationName: string | null; timezone: string | null }> {
  const url = new URL(`/restaurants/v1/restaurants/${encodeURIComponent(restaurantGuid)}`, baseUrl(credentials.environment));
  const response = await executeWithCredentials(
    env,
    brokerName,
    credentials,
    restaurantGuid,
    "GET",
    url,
    undefined,
    100,
    true,
  );
  const parsed = restaurantSchema.safeParse(response.data);
  if (!parsed.success) throw new CafeError("TOAST_UPSTREAM_ERROR", "Toast returned an invalid restaurant response.", 502);
  return {
    restaurantName: parsed.data.general?.name ?? parsed.data.restaurantName ?? `Toast restaurant ${restaurantGuid.slice(0, 8)}`,
    locationName: parsed.data.general?.locationName ?? parsed.data.locationName ?? null,
    timezone: parsed.data.general?.timeZone ?? parsed.data.timezone ?? null,
  };
}
