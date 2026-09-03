import { McpServer, type ServerContext } from "@modelcontextprotocol/server";
import { getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";
import { auditEvent, listLocationsForAccess, loadEffectiveAccess, requireLocationAccess } from "./db";
import { applyResponsePolicy } from "./data-policy";
import { CafeError, toPublicError } from "./errors";
import { readResultChunk, storeOversizedResult } from "./results";
import type { AuthProps, CafeEnvironment, EffectiveAccess } from "./runtime";
import { executeToastOperation } from "./toast/client";
import { getOperation, searchOperations } from "./toast/operations";

const authPropsSchema = z.object({
  userId: z.string().startsWith("usr_"),
  organizationId: z.string().startsWith("org_"),
  membershipId: z.string().startsWith("mem_"),
});

const pathParameter = z.union([z.string(), z.number()]);
const queryParameter = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);

function result(data: Record<string, unknown>, text: string) {
  return { structuredContent: data, content: [{ type: "text" as const, text }] };
}

function failure(error: unknown) {
  const publicError = toPublicError(error);
  return {
    isError: true,
    structuredContent: { ok: false, error: publicError },
    content: [{ type: "text" as const, text: `${publicError.code}: ${publicError.message}` }],
  };
}

async function accessFor(env: CafeEnvironment, context: ServerContext): Promise<EffectiveAccess> {
  const parsed = authPropsSchema.safeParse(getMcpAuthContext()?.props);
  if (!parsed.success) throw new CafeError("AUTH_REQUIRED", "The MCP authorization context is invalid.", 401);
  const scopes = context.http?.authInfo?.scopes ?? [];
  await enforceRequestLimit(env, parsed.data);
  return loadEffectiveAccess(env, parsed.data, scopes);
}

async function enforceRequestLimit(env: CafeEnvironment, props: AuthProps): Promise<void> {
  const minute = Math.floor(Date.now() / 60_000);
  const key = `limit:${props.organizationId}:${props.userId}:${minute}`;
  const row = await env.TOAST_MCP_DB.prepare(
    `INSERT INTO request_rate_buckets (bucket_key, request_count, expires_at) VALUES (?, 1, ?)
     ON CONFLICT(bucket_key) DO UPDATE SET request_count = request_count + 1
     RETURNING request_count`,
  ).bind(key, new Date((minute + 2) * 60_000).toISOString()).first<{ request_count: number }>();
  if (!row || row.request_count > 120) throw new CafeError("RATE_LIMITED", "Cafe MCP request limit exceeded.", 429, 60);
}

export function createCafeMcpServer(env: CafeEnvironment): McpServer {
  const server = new McpServer({ name: "Cafe MCP", version: "0.1.0" });

  server.registerTool(
    "toast_list_locations",
    {
      title: "List permitted Toast locations",
      description: "Lists only active Toast locations granted to the current user and organization.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (_input, context) => {
      try {
        const access = await accessFor(env, context);
        if (!access.scopes.has("cafe/locations:read")) throw new CafeError("SCOPE_DENIED", "The grant does not include location access.", 403);
        const locations = (await listLocationsForAccess(env, access)).map((location) => ({
          location_id: location.id,
          restaurant_name: location.restaurant_name,
          location_name: location.location_name,
          timezone: location.timezone,
        }));
        return result({ ok: true, locations }, `${locations.length} permitted Toast location${locations.length === 1 ? "" : "s"}.`);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "toast_search_operations",
    {
      title: "Search Toast read operations",
      description: "Searches the reviewed read-only Toast operation catalog within the current OAuth grant.",
      inputSchema: z.object({
        text: z.string().max(200).optional(),
        domain: z.string().max(50).optional(),
        scope: z.string().max(80).optional(),
        sensitivity: z.enum(["operational", "pii", "orders", "labor", "cash"]).optional(),
        limit: z.number().int().min(1).max(100).default(25),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input, context) => {
      try {
        const access = await accessFor(env, context);
        if (!access.scopes.has("cafe/catalog:read")) throw new CafeError("SCOPE_DENIED", "The grant does not include catalog access.", 403);
        const operations = searchOperations({ ...input, permittedScopes: access.scopes }).map((operation) => ({
          operation_id: operation.id,
          domain: operation.domain,
          description: operation.description,
          method: operation.method,
          required_scope: `toast/${operation.requiredScope}`,
          additional_scopes: operation.additionalScopes.map((scope) => `toast/${scope}`),
          sensitivity: operation.sensitivity,
          parameters: operation.parameters,
          request_body: operation.requestBody,
          request_body_required: operation.bodyRequired,
          request_body_required_properties: operation.bodyRequiredProperties,
          pagination: operation.pagination,
        }));
        return result({ ok: true, operations }, `${operations.length} permitted read operation${operations.length === 1 ? "" : "s"}.`);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "toast_execute_read",
    {
      title: "Execute a reviewed Toast read",
      description: "Executes one catalog-approved Toast request for one permitted location. URLs, methods, and headers are never accepted from callers.",
      inputSchema: z.object({
        operation_id: z.string().min(1).max(200),
        location_id: z.string().startsWith("loc_"),
        path_parameters: z.record(z.string(), pathParameter).default({}),
        query_parameters: z.record(z.string(), queryParameter).default({}),
        body: z.unknown().optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input, context) => {
      const started = Date.now();
      let audit: { userId?: string; organizationId?: string; locationId?: string } = {};
      try {
        const access = await accessFor(env, context);
        audit = { userId: access.userId, organizationId: access.organizationId, locationId: input.location_id };
        const operation = getOperation(input.operation_id);
        if (!operation) throw new CafeError("OPERATION_DENIED", "The Toast operation is not in the read-only catalog.", 403);
        const requiredScopes = [operation.requiredScope, ...operation.additionalScopes].map((scope) => `toast/${scope}`);
        if (requiredScopes.some((scope) => !access.scopes.has(scope))) {
          throw new CafeError("SCOPE_DENIED", "The grant does not include every scope required by this operation.", 403);
        }
        if (operation.additionalScopes.length && !access.sensitivePiiEnabled) {
          throw new CafeError("SCOPE_DENIED", "Sensitive Toast data is disabled for this organization.", 403);
        }
        if (input.body !== undefined && !operation.requestBody) {
          throw new CafeError("VALIDATION_FAILED", "This operation does not accept a request body.");
        }
        const { location, connection } = await requireLocationAccess(env, access, input.location_id);
        const response = await executeToastOperation(
          env,
          connection,
          location,
          operation,
          input.path_parameters as Record<string, string | number>,
          input.query_parameters,
          input.body,
        );
        const safeData = applyResponsePolicy(response.data, operation, access.scopes);
        const safeBytes = new TextEncoder().encode(JSON.stringify(safeData)).byteLength;
        let output: Record<string, unknown>;
        if (safeBytes <= Number.parseInt(env.INLINE_RESULT_MAX_BYTES, 10)) {
          output = { ok: true, operation_id: operation.id, location_id: location.id, data: safeData, toast_request_id: response.requestId };
        } else {
          const handle = await storeOversizedResult(env, access, operation, location.id, safeData);
          output = { ok: true, operation_id: operation.id, location_id: location.id, result: handle, toast_request_id: response.requestId };
        }
        await auditEvent(env, { requestId: response.requestId ?? crypto.randomUUID(), ...audit, operationId: operation.id, eventType: "toast_read", outcome: "success", statusCode: response.status, durationMs: Date.now() - started });
        return result(output, output.result ? "Toast returned a temporary encrypted result handle." : "Toast read completed.");
      } catch (error) {
        const publicError = toPublicError(error);
        await auditEvent(env, { requestId: crypto.randomUUID(), ...audit, operationId: input.operation_id, eventType: "toast_read", outcome: publicError.code, statusCode: error instanceof CafeError ? error.status : 500, durationMs: Date.now() - started }).catch(() => undefined);
        return failure(error);
      }
    },
  );

  server.registerTool(
    "toast_read_result",
    {
      title: "Read a temporary Toast result chunk",
      description: "Reads one encrypted, user-bound chunk of a non-sensitive oversized result.",
      inputSchema: z.object({ result_id: z.string().startsWith("res_"), cursor: z.number().int().min(0).default(0) }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input, context) => {
      try {
        const access = await accessFor(env, context);
        const chunk = await readResultChunk(env, access, input.result_id, input.cursor);
        return result({ ok: true, ...chunk }, chunk.complete ? "Final result fragment." : `Result fragment; continue with cursor ${chunk.cursor}.`);
      } catch (error) {
        return failure(error);
      }
    },
  );

  return server;
}
