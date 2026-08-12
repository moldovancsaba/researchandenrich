import { createHmac, timingSafeEqual, randomUUID } from "node:crypto"

/**
 * Admin session tokens.
 *
 * Framework-free so it stays testable without a bundler.
 *
 * The token is opaque to the browser and carries NO credential material: it is
 * a signed assertion that someone presented the admin credential once. It
 * cannot be replayed against the `x-api-key` header path, because that path
 * compares against `ADMIN_API_KEY` and a session token is not that value.
 *
 * `ADMIN_SESSION_SECRET` is deliberately a different value from
 * `ADMIN_API_KEY`: rotating it invalidates every live session without changing
 * the credential the automation path uses, which is the emergency revoke.
 */

export const SESSION_COOKIE = "rae_admin"
export const SESSION_TTL_SECONDS = 8 * 60 * 60

export type SessionPayload = {
  sub: "operator"
  iat: number
  exp: number
  jti: string
}

export type VerifyResult =
  | { ok: true; payload: SessionPayload }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" | "unconfigured" }

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

function fromB64url(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/")
  return Buffer.from(padded, "base64")
}

function sign(body: string, secret: string): string {
  return b64url(createHmac("sha256", secret).update(body).digest())
}

/**
 * Issue a token. `nowSeconds` is injected rather than read from the clock so
 * expiry behaviour is testable without waiting.
 */
export function createSession(
  secret: string,
  nowSeconds: number,
  ttlSeconds: number = SESSION_TTL_SECONDS
): { token: string; payload: SessionPayload } {
  const payload: SessionPayload = {
    sub: "operator",
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
    jti: randomUUID(),
  }
  const body = b64url(JSON.stringify(payload))
  return { token: `${body}.${sign(body, secret)}`, payload }
}

/**
 * Verify a token.
 *
 * The signature is checked BEFORE expiry: an attacker-supplied token should not
 * learn whether its forged payload would otherwise have been in date.
 */
export function verifySession(
  token: unknown,
  secret: string,
  nowSeconds: number
): VerifyResult {
  if (!secret || secret.trim() === "") return { ok: false, reason: "unconfigured" }
  if (typeof token !== "string" || token === "") return { ok: false, reason: "malformed" }

  const parts = token.split(".")
  if (parts.length !== 2) return { ok: false, reason: "malformed" }

  const [body, signature] = parts
  const expected = sign(body, secret)
  const a = Buffer.from(signature, "utf8")
  const b = Buffer.from(expected, "utf8")
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad_signature" }
  }

  let payload: SessionPayload
  try {
    payload = JSON.parse(fromB64url(body).toString("utf8"))
  } catch {
    return { ok: false, reason: "malformed" }
  }

  if (
    payload === null ||
    typeof payload !== "object" ||
    payload.sub !== "operator" ||
    typeof payload.exp !== "number" ||
    typeof payload.iat !== "number"
  ) {
    return { ok: false, reason: "malformed" }
  }

  // Server-side exp is authoritative; the client never decides expiry locally.
  if (nowSeconds >= payload.exp) return { ok: false, reason: "expired" }

  return { ok: true, payload }
}

/**
 * Serialise the session cookie.
 *
 * `SameSite=Strict` is the CSRF control for the state-changing admin routes.
 * `HttpOnly` keeps the token out of reach of any script, so an XSS cannot
 * exfiltrate it. `Secure` is omitted only on http://localhost, where browsers
 * would otherwise reject the cookie entirely and local development could not
 * authenticate at all.
 */
export function serializeSessionCookie(
  token: string,
  maxAgeSeconds: number,
  { secure }: { secure: boolean }
): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
  ]
  if (secure) parts.push("Secure")
  return parts.join("; ")
}

export function clearSessionCookie({ secure }: { secure: boolean }): string {
  return serializeSessionCookie("", 0, { secure })
}

export function readSessionCookie(headerValue: string | null): string | null {
  if (!headerValue) return null
  for (const part of headerValue.split(";")) {
    const [name, ...rest] = part.trim().split("=")
    if (name === SESSION_COOKIE) {
      const value = rest.join("=").trim()
      return value === "" ? null : value
    }
  }
  return null
}
