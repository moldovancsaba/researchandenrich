import { NextResponse, type NextRequest } from "next/server"
import {
  bucketFor,
  checkLimit,
  clientKey,
  retryAfterText,
  sweep,
} from "./lib/rate-limit"
import { policyFromEnv, securityHeaders } from "./lib/security-headers"

/**
 * Edge middleware: security headers on every response, rate limiting on the
 * sign-in and admin write paths.
 *
 * Rate-limited requests short-circuit BEFORE the handler, so they cost no
 * compute and acquire no MongoDB connection.
 *
 * The limiter is a mitigation with stated bounds, not a guaranteed ceiling --
 * see lib/rate-limit.ts. It exists so a single shared admin credential is
 * defensible against online guessing; a 32-byte CSPRNG secret at ~20
 * attempts/hour is not guessable.
 */
export function middleware(request: NextRequest) {
  const now = Date.now()
  sweep(now)

  const { pathname } = request.nextUrl
  const bucket = bucketFor(pathname, request.method)

  if (bucket) {
    const result = checkLimit(bucket, clientKey(request.headers), now)
    if (!result.allowed) {
      const retryAfterSeconds = Math.max(1, Math.ceil(result.resetMs / 1000))
      return NextResponse.json(
        {
          error: "rate_limited",
          code: "rate_limited",
          message: `Too many attempts. Try again in ${retryAfterText(result.resetMs)}.`,
          requestId: request.headers.get("x-vercel-id") ?? "local",
        },
        {
          status: 429,
          headers: {
            "Retry-After": String(retryAfterSeconds),
            "X-RateLimit-Limit": String(bucket.limit),
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": String(Math.ceil((now + result.resetMs) / 1000)),
          },
        }
      )
    }
  }

  // crypto.randomUUID is available in the edge runtime; Node's crypto is not.
  const nonce = crypto.randomUUID().replace(/-/g, "")
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set("x-nonce", nonce)

  const response = NextResponse.next({ request: { headers: requestHeaders } })
  for (const [name, value] of Object.entries(securityHeaders(nonce, policyFromEnv()))) {
    response.headers.set(name, value)
  }
  return response
}

export const config = {
  // Static assets are excluded: they need no nonce, and a nonce-bearing policy
  // on a statically generated response would be wrong.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
}
