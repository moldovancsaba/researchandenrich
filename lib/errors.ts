import { randomUUID } from "node:crypto"

/**
 * Framework-free error classification and structured logging.
 *
 * Kept free of any `next/*` import so it can be exercised directly by
 * `scripts/verify-api-validation.js` without a bundler. The NextResponse
 * wrappers live in `api-response.ts`.
 *
 * Every admin route previously ended its catch block with
 * `{ error: error?.message || 'Unknown failure' }` at status 500. MongoDB
 * driver errors carry resolved hostnames, replica-set topology and, on
 * connection failures, connection-string fragments -- all returned verbatim to
 * an unauthenticated caller. The same failures were logged with `console.error`
 * and an ad-hoc prefix, with no correlation id and no severity, so removing
 * detail from the response would have made failures untraceable. Correlation is
 * therefore part of this change, not a follow-up.
 */

export type FieldError = { field: string; reason: string }

export type ErrorEnvelope = {
  error: string
  code: string
  message: string
  requestId: string
  fields?: FieldError[]
}

export type Classification = {
  status: number
  code: string
  message: string
}

/** Masks anything credential-shaped before a log line is emitted. */
const REDACTIONS: RegExp[] = [
  /mongodb(\+srv)?:\/\/[^\s"']+/gi,
  /slg_[a-f0-9]{16,}/gi,
  /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, // JWTs
]

const MAX_LOG_FIELD = 8192

export function redact(text: string): string {
  let out = text
  for (const pattern of REDACTIONS) out = out.replace(pattern, "[redacted]")
  if (out.length > MAX_LOG_FIELD) {
    out = `${out.slice(0, MAX_LOG_FIELD)}…[truncated ${out.length - MAX_LOG_FIELD} chars]`
  }
  return out
}

export function requestIdFrom(request: Request): string {
  return request.headers.get("x-vercel-id") ?? randomUUID()
}

export function log(record: Record<string, unknown>): void {
  try {
    const safe: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(record)) {
      safe[k] = typeof v === "string" ? redact(v) : v
    }
    const line = JSON.stringify({ ts: new Date().toISOString(), ...safe })
    if (record.level === "error") console.error(line)
    else console.warn(line)
  } catch {
    // Logging must never throw or fail a request.
  }
}

/**
 * Map a thrown value to a safe status and code.
 *
 * Distinguishing 503 database_unavailable from 500 internal_error is the one
 * place where MORE information is safer: it tells the operator to check the
 * database rather than the code, and tells the client the request is
 * retryable, without disclosing which host was unreachable.
 */
export function classify(err: unknown): Classification {
  const name = err instanceof Error ? err.constructor.name : "Unknown"

  if (name === "ConfigurationError") {
    return {
      status: 503,
      code: "misconfigured",
      message: "The service is not fully configured. Retry shortly.",
    }
  }
  if (
    name === "MongoServerSelectionError" ||
    name === "MongoNetworkError" ||
    name === "MongoNetworkTimeoutError" ||
    name === "MongoTimeoutError"
  ) {
    return {
      status: 503,
      code: "database_unavailable",
      message: "The configuration store is temporarily unreachable. Retry shortly.",
    }
  }
  if (name === "MongoWriteConcernError" || name === "MongoBulkWriteError") {
    return {
      status: 503,
      code: "write_failed",
      message: "The change could not be saved. Retry shortly.",
    }
  }
  if (err instanceof SyntaxError) {
    return {
      status: 400,
      code: "malformed_body",
      message: "Request body was not valid JSON.",
    }
  }
  return {
    status: 500,
    code: "internal_error",
    message:
      "The request could not be completed. Quote the request id when reporting this.",
  }
}

/** Pick the machine-readable code that best describes a set of field errors. */
export function validationCode(fields: FieldError[]): string {
  if (fields.some((f) => f.reason === "not an accepted field")) return "unknown_field"
  if (fields.some((f) => f.reason.includes("cannot be modified"))) return "immutable_field"
  return "invalid_value"
}
