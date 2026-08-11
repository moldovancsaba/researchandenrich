import { NextResponse } from "next/server"
import { decideAuth } from "./auth-core"
import { log } from "./errors"

/**
 * Admin API authorization.
 *
 * This was `return null` — an unconditional pass — while every admin route
 * called it, so `DELETE /api/admin/tenants/<id>` accepted anonymous requests
 * against production MongoDB.
 *
 * Filling the stub in was not sufficient on its own. The credential the system
 * was designed around, `NEXT_PUBLIC_SLG_API_KEY`, is inlined into the client
 * bundle by Next.js at build time, so checking against it would have been
 * theatre: it passes for anyone who opens DevTools. The credential itself had
 * to change, which is why `ADMIN_API_KEY` is server-only.
 *
 * SHIPS DISABLED. `ADMIN_AUTH_ENABLED` must be "true" to enforce, and must not
 * be set until the browser clients have migrated — enabling it early makes the
 * dashboard unusable with no recovery path.
 *
 * The decision logic lives in `auth-core.ts`, free of any `next/*` import so it
 * stays testable without a bundler.
 */

const WWW_AUTH = { "WWW-Authenticate": 'Bearer realm="admin"' }

export function requireApiKey(request: Request): Response | null {
  const route = (() => {
    try {
      return new URL(request.url).pathname
    } catch {
      return "<unparseable>"
    }
  })()

  const decision = decideAuth(request.headers, {
    enabled: process.env.ADMIN_AUTH_ENABLED === "true",
    secret: process.env.ADMIN_API_KEY ?? "",
  })

  log({
    level: decision.outcome === "misconfigured" ? "error" : "warn",
    event: "auth",
    outcome: decision.outcome,
    keyFingerprint: decision.keyFingerprint,
    requestId: request.headers.get("x-vercel-id"),
    route,
    method: request.method,
  })

  if (decision.status === null) return null

  return NextResponse.json(
    { error: decision.code, code: decision.code, message: decision.message },
    {
      status: decision.status,
      headers: decision.status === 401 ? WWW_AUTH : undefined,
    }
  )
}

/** Rollout state, surfaced at /api/health so it is observable without reading
 *  environment variables on the deployment. */
export function adminAuthState(): "enabled" | "disabled" {
  return process.env.ADMIN_AUTH_ENABLED === "true" ? "enabled" : "disabled"
}
