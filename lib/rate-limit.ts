/**
 * Fixed-window rate limiting, framework-free so it stays testable.
 *
 * HONEST BOUNDS, stated because an exact-looking number would be worse than an
 * approximate one: counters are per-instance and in memory. Vercel runs
 * multiple serverless instances, so the effective global limit is
 * (configured limit x instance count), and a cold start resets counters. This
 * is a MITIGATION, not a guaranteed ceiling.
 *
 * Chosen over a KV-backed limiter deliberately: it adds no dependency, no
 * latency and no new failure mode, and the credential it protects is 32 bytes
 * of CSPRNG. The goal is bounding attempt VOLUME so online guessing is
 * irrelevant, not enforcing an exact count. An exact limit needs a KV backend
 * and is separate work.
 */

export type RateLimitBucket = {
  name: string
  limit: number
  windowMs: number
}

export type RateLimitResult = {
  allowed: boolean
  remaining: number
  resetMs: number
}

type CounterEntry = { count: number; windowStart: number }

const counters = new Map<string, CounterEntry>()

/** Above this, expired entries are swept. A full LRU would be more precise;
 *  a size-triggered sweep bounds memory adequately at this scale with far less
 *  code. Ceiling: ~10k entries x ~64 bytes ~= 640 KB. */
const SWEEP_THRESHOLD = 10_000
const SWEEP_MAX_AGE_MS = 60 * 60_000

export function sweep(now: number): void {
  if (counters.size < SWEEP_THRESHOLD) return
  // Array.from rather than iterating the Map directly: tsconfig targets es5,
  // where Map iteration needs downlevelIteration. Collecting first also avoids
  // deleting from a Map while iterating it.
  for (const key of Array.from(counters.keys())) {
    const entry = counters.get(key)
    if (entry && now - entry.windowStart > SWEEP_MAX_AGE_MS) counters.delete(key)
  }
}

export function checkLimit(
  bucket: RateLimitBucket,
  clientKey: string,
  now: number
): RateLimitResult {
  const key = `${bucket.name}:${clientKey}`
  const entry = counters.get(key)

  if (!entry || now - entry.windowStart >= bucket.windowMs) {
    counters.set(key, { count: 1, windowStart: now })
    return { allowed: true, remaining: bucket.limit - 1, resetMs: bucket.windowMs }
  }

  entry.count += 1
  const resetMs = bucket.windowMs - (now - entry.windowStart)
  return {
    allowed: entry.count <= bucket.limit,
    remaining: Math.max(0, bucket.limit - entry.count),
    resetMs,
  }
}

/** Test seam. Not used at runtime. */
export function resetLimiter(): void {
  counters.clear()
}

/**
 * Derive a client key.
 *
 * All unattributable traffic shares one bucket deliberately: a caller should
 * not earn a fresh quota by hiding its origin.
 *
 * On Vercel the first `x-forwarded-for` hop is set by the edge and is not
 * client-controllable. On any other host that assumption must be re-verified
 * before this is trusted.
 */
export function clientKey(headers: { get(name: string): string | null }): string {
  const forwarded = headers.get("x-forwarded-for")
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim()
    if (first) return first
  }
  const real = headers.get("x-real-ip")
  if (real && real.trim() !== "") return real.trim()
  return "unknown"
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function buckets(): Record<"signin" | "adminWrite", RateLimitBucket> {
  return {
    signin: {
      name: "signin",
      limit: intFromEnv("RATE_LIMIT_SIGNIN_MAX", 5),
      windowMs: intFromEnv("RATE_LIMIT_SIGNIN_WINDOW_MS", 15 * 60_000),
    },
    adminWrite: {
      name: "admin-write",
      limit: intFromEnv("RATE_LIMIT_WRITE_MAX", 60),
      windowMs: intFromEnv("RATE_LIMIT_WRITE_WINDOW_MS", 60_000),
    },
  }
}

/**
 * Which bucket applies to a request, if any.
 *
 * /api/health is never limited: it is a GET outside /api/admin, and external
 * monitoring polls it. Breaking that would be a self-inflicted outage.
 */
export function bucketFor(
  pathname: string,
  method: string
): RateLimitBucket | null {
  const b = buckets()
  if (pathname === "/api/admin/session") return b.signin
  if (pathname.startsWith("/api/admin/") && method !== "GET") return b.adminWrite
  return null
}

/** Human-readable retry hint. Announced to a screen reader verbatim, so it is a
 *  duration rather than an epoch. */
export function retryAfterText(resetMs: number): string {
  const seconds = Math.max(1, Math.ceil(resetMs / 1000))
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`
  const minutes = Math.ceil(seconds / 60)
  return `${minutes} minute${minutes === 1 ? "" : "s"}`
}
