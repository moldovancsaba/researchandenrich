/**
 * Framework-free queue logic, kept free of any `next/*` import so it stays
 * exercisable without a bundler. The route imports these.
 */

export type Operation = "discovery" | "enrichment"

/**
 * Effective enablement: the tenant-level master switch AND the per-operation
 * switch. Returning the two inputs alongside this is what lets a UI distinguish
 * "you turned this off" from "the tenant is paused, so it cannot run" -- two
 * states that were previously indistinguishable.
 */
export function effectiveEnabled(tenant: any, operation: Operation): boolean {
  return tenant?.status === "active" && tenant?.[operation]?.enabled !== false
}

const IDENTIFIER = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** Type-guarded: a non-string id previously reached `.match()` and threw a
 *  TypeError, surfacing as a generic 500. */
export function parseJobId(
  raw: unknown
): { tenantId: string; operation: Operation } | null {
  if (typeof raw !== "string") return null
  const match = raw.match(/^queue-(.+?)-(discovery|enrichment)$/)
  if (!match) return null
  if (!IDENTIFIER.test(match[1])) return null
  return { tenantId: match[1], operation: match[2] as Operation }
}

/** Fields a reorder must never modify. Accepting `schedule` here is what let a
 *  reorder omitting it erase a tenant's schedule. */
export const REORDER_FORBIDDEN_FIELDS = ["schedule", "enabled", "prompt", "tenantId"] as const
