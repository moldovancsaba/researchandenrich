import { timingSafeEqual, createHash } from "node:crypto"

/**
 * Framework-free admin authorization decision.
 *
 * Kept free of any `next/*` import so it can be exercised directly by
 * `scripts/verify-auth.js` without a bundler. `api-auth.ts` maps the decision
 * to a NextResponse.
 */

export type AuthOutcome =
  | "pass"
  | "bypass"
  | "missing_credential"
  | "invalid_credential"
  | "misconfigured"

export type AuthDecision = {
  outcome: AuthOutcome
  /** null when the caller may proceed. */
  status: number | null
  code: string | null
  message: string | null
  keyFingerprint: string | null
}

export const SESSION_COOKIE = "rae_admin"

/** First 6 hex chars of sha256. Distinguishes "operator used a stale key" from
 *  "an unknown party is probing" without recording the credential itself. */
export function fingerprint(presented: string): string {
  return createHash("sha256").update(presented).digest("hex").slice(0, 6)
}

/**
 * Constant-time equality.
 *
 * Length is compared first because `timingSafeEqual` throws on unequal buffer
 * lengths. That leaks only the length of the CONFIGURED secret — a fixed
 * property of the deployment, not of the guess.
 *
 * Compared as UTF-8 bytes: a `String.length` check would be wrong for a
 * multi-byte credential.
 */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8")
  const bb = Buffer.from(b, "utf8")
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/** `x-api-key` wins over `Authorization: Bearer` by documented precedence, so a
 *  request carrying both is deterministic rather than order-dependent. */
export function extractCredential(headers: {
  get(name: string): string | null
}): string | null {
  const direct = headers.get("x-api-key")
  if (direct && direct.trim() !== "") return direct.trim()

  const auth = headers.get("authorization")
  if (auth && auth.startsWith("Bearer ")) {
    const token = auth.slice(7).trim()
    if (token !== "") return token
  }
  return null
}

export function extractSessionCookie(headers: {
  get(name: string): string | null
}): string | null {
  const header = headers.get("cookie")
  if (!header) return null
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=")
    if (name === SESSION_COOKIE) {
      const value = rest.join("=").trim()
      return value === "" ? null : value
    }
  }
  return null
}

/**
 * Decide whether a request may proceed.
 *
 * Fails closed: no configuration state yields a pass while enforcement is on.
 */
export function decideAuth(
  headers: { get(name: string): string | null },
  env: {
    enabled: boolean
    secret: string
    /** Supplied by the route layer, which owns session verification. When it
     *  returns true the caller is authorized without presenting a header --
     *  this is how the browser authenticates. */
    sessionValid?: boolean
  }
): AuthDecision {
  if (!env.enabled) {
    // A bypass is still an outcome to record. An invisible bypass is how the
    // original no-op stub survived in production unnoticed.
    return {
      outcome: "bypass",
      status: null,
      code: null,
      message: null,
      keyFingerprint: null,
    }
  }

  if (env.secret.trim() === "") {
    return {
      outcome: "misconfigured",
      status: 503,
      code: "auth_misconfigured",
      message:
        "Admin authentication is enabled but no credential is configured on the server.",
      keyFingerprint: null,
    }
  }

  // A valid session cookie authorizes the browser. Checked before the header
  // so an operator with a live session is never asked for a credential.
  if (env.sessionValid) {
    return {
      outcome: "pass",
      status: null,
      code: null,
      message: null,
      keyFingerprint: null,
    }
  }

  const presented = extractCredential(headers)
  if (presented === null) {
    return {
      outcome: "missing_credential",
      status: 401,
      code: "missing_credential",
      message: "Provide the admin credential in the x-api-key header.",
      keyFingerprint: null,
    }
  }

  if (!safeEqual(presented, env.secret.trim())) {
    return {
      outcome: "invalid_credential",
      status: 401,
      code: "invalid_credential",
      // Deliberately non-specific: distinguishing "wrong length" from "wrong
      // value" would leak comparison detail.
      message: "The provided admin credential was not accepted.",
      keyFingerprint: fingerprint(presented),
    }
  }

  return {
    outcome: "pass",
    status: null,
    code: null,
    message: null,
    keyFingerprint: fingerprint(presented),
  }
}
