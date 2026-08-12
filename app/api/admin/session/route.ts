import { NextResponse } from 'next/server'
import { safeEqual, fingerprint } from '../../../../lib/auth-core'
import {
  createSession,
  serializeSessionCookie,
  clearSessionCookie,
  SESSION_TTL_SECONDS,
} from '../../../../lib/session'
import {
  withErrorHandling,
  errorResponse,
  requestId,
  log,
} from '../../../../lib/api-response'

export const dynamic = 'force-dynamic'

/**
 * Sign-in.
 *
 * This is the ONE admin route deliberately exempt from `requireApiKey` -- it is
 * the path by which a caller obtains authorization. It is therefore also the
 * only admin route an unauthenticated party may repeatedly call, which is why
 * `middleware.ts` gives it the strict rate-limit bucket (5 per 15 minutes).
 *
 * The credential is validated once, server-side, and exchanged for an opaque
 * signed cookie. The browser never holds the credential -- that is the whole
 * point: `NEXT_PUBLIC_SLG_API_KEY` was inlined into the client bundle, so the
 * previous design published its own key.
 */
export const POST = withErrorHandling('/api/admin/session', async (request) => {
  const reqId = requestId(request)
  const body = await request.json().catch(() => null)
  const credential = (body as any)?.credential

  // Trimmed: a paste carrying a trailing newline must not read as a wrong key.
  const presented = typeof credential === 'string' ? credential.trim() : ''

  if (presented === '') {
    return errorResponse(
      401,
      'missing_credential',
      'Enter the admin credential to sign in.',
      reqId
    )
  }

  const secret = (process.env.ADMIN_API_KEY ?? '').trim()
  const sessionSecret = (process.env.ADMIN_SESSION_SECRET ?? '').trim()

  if (secret === '' || sessionSecret === '') {
    log({
      level: 'error',
      requestId: reqId,
      event: 'auth',
      outcome: 'misconfigured',
      route: '/api/admin/session',
      detail: secret === '' ? 'ADMIN_API_KEY unset' : 'ADMIN_SESSION_SECRET unset',
    })
    return errorResponse(
      503,
      'auth_misconfigured',
      'Sign-in is not available: the server is not fully configured.',
      reqId
    )
  }

  if (!safeEqual(presented, secret)) {
    log({
      level: 'warn',
      requestId: reqId,
      event: 'auth',
      outcome: 'invalid_credential',
      route: '/api/admin/session',
      keyFingerprint: fingerprint(presented),
    })
    return errorResponse(
      401,
      'invalid_credential',
      'The provided admin credential was not accepted.',
      reqId
    )
  }

  const nowSeconds = Math.floor(Date.now() / 1000)
  const { token, payload } = createSession(sessionSecret, nowSeconds)

  log({
    level: 'warn',
    requestId: reqId,
    event: 'auth',
    outcome: 'session_issued',
    route: '/api/admin/session',
    jti: payload.jti,
  })

  const response = NextResponse.json({
    ok: true,
    expiresAt: new Date(payload.exp * 1000).toISOString(),
  })
  response.headers.set(
    'Set-Cookie',
    serializeSessionCookie(token, SESSION_TTL_SECONDS, {
      // Browsers reject Secure cookies on http://localhost, which would make
      // local development unable to authenticate at all.
      secure: process.env.NODE_ENV === 'production',
    })
  )
  return response
})

/**
 * Sign-out. Clears the cookie.
 *
 * Sessions are stateless, so this revokes only the presented cookie. Rotating
 * ADMIN_SESSION_SECRET is what revokes every live session at once.
 */
export const DELETE = withErrorHandling('/api/admin/session', async (request) => {
  const reqId = requestId(request)
  log({
    level: 'warn',
    requestId: reqId,
    event: 'auth',
    outcome: 'session_cleared',
    route: '/api/admin/session',
  })

  const response = NextResponse.json({ ok: true })
  response.headers.set(
    'Set-Cookie',
    clearSessionCookie({ secure: process.env.NODE_ENV === 'production' })
  )
  return response
})
