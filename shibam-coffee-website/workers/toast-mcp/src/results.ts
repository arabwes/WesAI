import { decryptValue, encryptValue } from "./crypto";
import { CafeError } from "./errors";
import type { CafeEnvironment, EffectiveAccess } from "./runtime";
import type { CatalogOperation } from "./toast/operations";

const encoder = new TextEncoder();

export function splitUtf8Fragments(value: string, maxBytes: number): string[] {
  if (encoder.encode(value).byteLength <= maxBytes) return [value];
  const chunks: string[] = [];
  let start = 0;
  while (start < value.length) {
    let low = start + 1;
    let high = value.length;
    let accepted = start + 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (encoder.encode(value.slice(start, middle)).byteLength <= maxBytes) {
        accepted = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    // Never split a UTF-16 surrogate pair.
    if (accepted < value.length && /[\uD800-\uDBFF]/u.test(value.charAt(accepted - 1))) accepted -= 1;
    if (accepted <= start) {
      throw new CafeError("INTERNAL_ERROR", "The configured result chunk size cannot hold one UTF-8 character.", 500);
    }
    chunks.push(value.slice(start, accepted));
    start = accepted;
  }
  return chunks;
}

export interface StoredResultHandle {
  resultId: string;
  chunks: number;
  totalBytes: number;
  expiresAt: string;
}

export async function storeOversizedResult(
  env: CafeEnvironment,
  access: EffectiveAccess,
  operation: CatalogOperation,
  locationId: string,
  value: unknown,
): Promise<StoredResultHandle> {
  if (!access.scopes.has("cafe/results:read")) {
    throw new CafeError(
      "SCOPE_DENIED",
      "The result exceeds the inline limit and this grant does not include temporary result access.",
      403,
    );
  }
  if (!operation.persistable || operation.sensitivity !== "operational") {
    throw new CafeError(
      "OVERSIZED_SENSITIVE_RESULT",
      "The sensitive result is too large to return safely. Narrow the Toast query and try again.",
      413,
    );
  }
  const serialized = JSON.stringify(value);
  const totalBytes = encoder.encode(serialized).byteLength;
  const configuredMax = Number.parseInt(env.RESULT_CHUNK_MAX_BYTES, 10);
  // Leave room for AES-GCM and base64 envelope overhead while keeping each R2 object small.
  const chunks = splitUtf8Fragments(serialized, Math.min(configuredMax, 180 * 1024));
  const resultId = `res_${crypto.randomUUID()}`;
  const expiresAt = new Date(Date.now() + Number.parseInt(env.RESULT_TTL_SECONDS, 10) * 1000).toISOString();

  try {
    for (const [index, fragment] of chunks.entries()) {
      const aad = `toast-result:${access.organizationId}:${access.userId}:${resultId}:${index}`;
      const encrypted = await encryptValue(fragment, env.RESULT_KEK_V1, aad);
      await env.TOAST_RESULTS.put(`results/${resultId}/chunk-${index}.json`, JSON.stringify(encrypted), {
        httpMetadata: { contentType: "application/json", cacheControl: "no-store" },
      });
    }
    await env.TOAST_MCP_DB.prepare(
      `INSERT INTO result_objects
        (id, user_id, organization_id, operation_id, location_id, chunk_count, total_bytes, key_version, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
      .bind(resultId, access.userId, access.organizationId, operation.id, locationId, chunks.length, totalBytes, expiresAt, new Date().toISOString())
      .run();
  } catch (error) {
    await env.TOAST_RESULTS.delete(chunks.map((_, index) => `results/${resultId}/chunk-${index}.json`));
    throw error;
  }
  return { resultId, chunks: chunks.length, totalBytes, expiresAt };
}

export async function readResultChunk(
  env: CafeEnvironment,
  access: EffectiveAccess,
  resultId: string,
  cursor = 0,
): Promise<{ resultId: string; fragment: string; cursor: number | null; complete: boolean }> {
  if (!access.scopes.has("cafe/results:read")) {
    throw new CafeError("SCOPE_DENIED", "The grant does not include result access.", 403);
  }
  const row = await env.TOAST_MCP_DB.prepare(
    `SELECT id, chunk_count FROM result_objects
      WHERE id = ? AND user_id = ? AND organization_id = ? AND expires_at > ?`,
  )
    .bind(resultId, access.userId, access.organizationId, new Date().toISOString())
    .first<{ id: string; chunk_count: number }>();
  if (!row || cursor < 0 || cursor >= row.chunk_count) throw new CafeError("NOT_FOUND", "The result handle or cursor is unavailable.", 404);
  const object = await env.TOAST_RESULTS.get(`results/${resultId}/chunk-${cursor}.json`);
  if (!object) throw new CafeError("NOT_FOUND", "The result chunk has expired.", 404);
  const encrypted = JSON.parse(await object.text()) as { ciphertext: string; nonce: string; keyVersion: number };
  const fragment = await decryptValue(
    encrypted,
    env.RESULT_KEK_V1,
    `toast-result:${access.organizationId}:${access.userId}:${resultId}:${cursor}`,
  );
  const next = cursor + 1 < row.chunk_count ? cursor + 1 : null;
  return { resultId, fragment, cursor: next, complete: next === null };
}
