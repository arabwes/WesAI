export type CafeErrorCode =
  | "AUTH_REQUIRED"
  | "CSRF_INVALID"
  | "VALIDATION_FAILED"
  | "SCOPE_DENIED"
  | "LOCATION_DENIED"
  | "OPERATION_DENIED"
  | "OPERATION_NOT_ALLOWED"
  | "TOAST_AUTH_FAILED"
  | "TOAST_RATE_LIMITED"
  | "TOAST_UPSTREAM_ERROR"
  | "RESULT_TOO_LARGE_SENSITIVE"
  | "OVERSIZED_SENSITIVE_RESULT"
  | "RESULT_NOT_FOUND"
  | "RATE_LIMITED"
  | "FEATURE_DISABLED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INTERNAL_ERROR";

export class CafeError extends Error {
  readonly code: CafeErrorCode;
  readonly status: number;
  readonly retryAfterSeconds?: number;

  constructor(code: CafeErrorCode, message: string, status = 400, retryAfterSeconds?: number) {
    super(message);
    this.name = "CafeError";
    this.code = code;
    this.status = status;
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

export function publicError(error: unknown): CafeError {
  if (error instanceof CafeError) return error;
  return new CafeError("INTERNAL_ERROR", "Cafe MCP could not complete the request.", 500);
}

export function toPublicError(error: unknown): { code: CafeErrorCode; message: string; retry_after_seconds?: number } {
  const safe = publicError(error);
  return {
    code: safe.code,
    message: safe.message,
    ...(safe.retryAfterSeconds === undefined ? {} : { retry_after_seconds: safe.retryAfterSeconds }),
  };
}

export function toErrorResponse(error: unknown, _genericProductionErrors = true, requestId: string = crypto.randomUUID()): Response {
  return errorResponse(error, requestId);
}

export function errorResponse(error: unknown, requestId: string): Response {
  const safe = publicError(error);
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Request-Id": requestId,
  });
  if (safe.retryAfterSeconds !== undefined) {
    headers.set("Retry-After", String(safe.retryAfterSeconds));
  }
  return new Response(
    JSON.stringify({
      error: { code: safe.code, message: safe.message, request_id: requestId },
    }),
    { status: safe.status, headers },
  );
}
