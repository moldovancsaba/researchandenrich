/**
 * Input validation for the admin API.
 *
 * Two distinct controls live here, both absent before:
 *
 * 1. Identifier validation. `POST /api/admin/{tenants,apps}` took tenantId /
 *    appId straight from the parsed JSON body into `findOne({ tenantId })`.
 *    Because the body is arbitrary JSON, `{"tenantId": {"$ne": null}}` was
 *    interpreted by the driver as a query OPERATOR rather than compared as a
 *    value, and the same object was then persisted where a string is expected.
 *    Rejecting non-strings at the type level removes the vector entirely,
 *    rather than trying to sanitise operator syntax.
 *
 * 2. Field allowlisting. The PUT handlers built their update as
 *    `{ ...existing, ...body }`, pinning only the identifier. Every other field
 *    was caller-writable -- including `tenantIds`, which guards app deletion,
 *    and `status`, which CLAUDE.md designates as the single most consequential
 *    field in the system and wraps in commit-message discipline. That same
 *    mutation was reachable over HTTP with no commit and no diff.
 */

/**
 * The only shape an identifier may take. Excludes `$` and `.` -- the two
 * characters MongoDB treats specially in field names -- so a validated
 * identifier is inert in any query position, including ones added later.
 */
export const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

export type FieldError = { field: string; reason: string }

export type IdentifierResult =
  | { ok: true; value: string }
  | { ok: false; field: string; reason: string }

export function asIdentifier(value: unknown, field: string): IdentifierResult {
  // Reject non-primitives outright. An object reaching a query document is
  // exactly what allows operator interpretation.
  if (typeof value !== "string") {
    return { ok: false, field, reason: "must be a string" }
  }
  const trimmed = value.trim()
  if (trimmed === "") {
    return { ok: false, field, reason: "must not be empty" }
  }
  if (!IDENTIFIER_PATTERN.test(trimmed)) {
    return {
      ok: false,
      field,
      reason: "must match ^[a-z0-9][a-z0-9_-]{0,63}$",
    }
  }
  return { ok: true, value: trimmed }
}

export type FieldRule = {
  type: "string" | "number" | "boolean" | "string[]" | "object"
  enum?: readonly string[]
  required?: boolean // on create only
  immutable?: boolean // rejected on update
  maxLength?: number
}

export const TENANT_SCHEMA: Record<string, FieldRule> = {
  tenantId: { type: "string", required: true, immutable: true, maxLength: 64 },
  appId: { type: "string", required: true, maxLength: 64 },
  displayName: { type: "string", maxLength: 128 },
  description: { type: "string", maxLength: 1024 },
  status: { type: "string", enum: ["active", "paused"] },
  apiBase: { type: "string", maxLength: 512 },
  board: { type: "string", maxLength: 64 },
  scope: { type: "string", maxLength: 4096 },
  brandFields: { type: "object" },
  forbiddenFields: { type: "string[]" },
  iceScoring: { type: "boolean" },
  schemaFamily: { type: "string", enum: ["sales-lead-api", "program-api"] },
  forecastModel: {
    type: "string",
    enum: ["deal-size-band", "pricing-by-company"],
  },
  discovery: { type: "object" },
  enrichment: { type: "object" },
  sortOrder: { type: "number" },
}

export const APP_SCHEMA: Record<string, FieldRule> = {
  appId: { type: "string", required: true, immutable: true, maxLength: 64 },
  displayName: { type: "string", required: true, maxLength: 128 },
  description: { type: "string", maxLength: 1024 },
  apiBase: { type: "string", maxLength: 512 },
  verifier: { type: "string", enum: ["list-based", "response-based"] },
  schemaMapper: { type: "string", maxLength: 256 },
  searchEngines: { type: "string[]" },
  qualityPipeline: { type: "string[]" },
  maxResultsPerRun: { type: "number" },
  // Derived from tenant membership and maintained server-side. Caller-writable
  // tenantIds is what made the app delete guard bypassable in two requests:
  // clear the array, then delete.
  tenantIds: { type: "string[]", immutable: true },
}

function checkType(value: unknown, rule: FieldRule): string | null {
  switch (rule.type) {
    case "string":
      if (typeof value !== "string") return "must be a string"
      if (rule.maxLength !== undefined && value.length > rule.maxLength) {
        return `must be at most ${rule.maxLength} characters`
      }
      return null
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? null
        : "must be a finite number"
    case "boolean":
      return typeof value === "boolean" ? null : "must be a boolean"
    case "string[]":
      if (!Array.isArray(value)) return "must be an array of strings"
      return value.every((v) => typeof v === "string")
        ? null
        : "must be an array of strings"
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value)
        ? null
        : "must be an object"
    default:
      return "unsupported field type"
  }
}

export type ValidationResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; errors: FieldError[] }

/**
 * Validate a request body against a schema, returning only allowlisted fields.
 *
 * All errors are collected rather than short-circuiting, so a caller with two
 * bad fields fixes both in one round trip. Unknown fields are REJECTED, not
 * dropped: silently ignoring one would let a caller believe a change took
 * effect when it did not.
 */
export function validateAgainstSchema(
  schema: Record<string, FieldRule>,
  body: unknown,
  { partial }: { partial: boolean }
): ValidationResult {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return {
      ok: false,
      errors: [{ field: "<root>", reason: "body must be a JSON object" }],
    }
  }

  const errors: FieldError[] = []
  const out: Record<string, unknown> = {}
  const input = body as Record<string, unknown>

  for (const key of Object.keys(input)) {
    const rule = schema[key]
    if (!rule) {
      errors.push({ field: key, reason: "not an accepted field" })
      continue
    }
    if (rule.immutable && partial) {
      errors.push({ field: key, reason: "cannot be modified after creation" })
      continue
    }
    const value = input[key]
    if (value === null) {
      // Clearing a field requires an explicit empty value of the right type.
      errors.push({ field: key, reason: "must not be null" })
      continue
    }
    const typeError = checkType(value, rule)
    if (typeError) {
      errors.push({ field: key, reason: typeError })
      continue
    }
    if (rule.enum && !rule.enum.includes(value as string)) {
      errors.push({ field: key, reason: `must be one of: ${rule.enum.join(", ")}` })
      continue
    }
    out[key] = value
  }

  if (!partial) {
    for (const [key, rule] of Object.entries(schema)) {
      if (rule.required && out[key] === undefined) {
        errors.push({ field: key, reason: "required" })
      }
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: out }
}

/** Structural equality sufficient for JSON-shaped config values. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (typeof a !== "object") return false
  return JSON.stringify(a) === JSON.stringify(b)
}
