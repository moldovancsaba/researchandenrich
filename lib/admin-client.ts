/**
 * Admin API client.
 *
 * Framework-free and side-effect-free so the state mapping is testable without
 * a browser.
 *
 * The defect this replaces: every admin `fetch` sent
 * `process.env.NEXT_PUBLIC_SLG_API_KEY`, which Next.js inlines into the client
 * bundle at build time — the page published its own credential. The queue page
 * sent nothing at all. Authentication is now a `HttpOnly` session cookie the
 * browser cannot read, sent automatically with `credentials: "same-origin"`.
 */

export type AdminAuthState =
  | { status: "unknown" }
  | { status: "signed-out" }
  | { status: "signing-in" }
  | { status: "signed-in" }
  | { status: "invalid"; message: string }
  | { status: "expired" }
  | { status: "misconfigured"; message: string }
  | { status: "rate-limited"; message: string; retryAfterSeconds: number }
  | { status: "offline"; message: string }

/** A parsed error envelope, as produced by `lib/errors.ts`. */
export type ApiError = {
  code?: string
  message?: string
  requestId?: string
  fields?: { field: string; reason: string }[]
}

export class SessionEnded extends Error {
  readonly path: string
  readonly init: RequestInit
  readonly nextState: AdminAuthState

  // Fields are assigned explicitly rather than declared as constructor
  // parameter properties: the verify-*.js scripts require these modules
  // directly, and Node's type-stripping rejects parameter properties because
  // they emit code rather than only types.
  constructor(path: string, init: RequestInit, nextState: AdminAuthState) {
    super("admin session ended")
    this.name = "SessionEnded"
    this.path = path
    this.init = init
    this.nextState = nextState
  }
}

export class AdminRequestFailed extends Error {
  readonly status: number
  readonly body: ApiError

  constructor(status: number, body: ApiError) {
    super(body.message ?? `Request failed with status ${status}`)
    this.name = "AdminRequestFailed"
    this.status = status
    this.body = body
  }
}

/**
 * Map an HTTP response to the auth state it implies.
 *
 * `401 missing_credential` means the request carried no accepted credential.
 * From a browser that had a session, the session ended — so it maps to
 * `expired`, not `invalid`. Conflating the two would tell an operator their
 * key is wrong when it is merely stale.
 */
export function stateForResponse(
  status: number,
  body: ApiError,
  hadSession: boolean,
  retryAfterHeader: string | null
): AdminAuthState | null {
  if (status === 401) {
    if (body.code === "missing_credential") {
      return hadSession ? { status: "expired" } : { status: "signed-out" }
    }
    return {
      status: "invalid",
      message: body.message ?? "Sign-in was not accepted.",
    }
  }
  if (status === 429) {
    const seconds = Number(retryAfterHeader ?? "") || 60
    return {
      status: "rate-limited",
      message: body.message ?? "Too many attempts. Try again shortly.",
      retryAfterSeconds: seconds,
    }
  }
  if (status === 503) {
    return {
      status: "misconfigured",
      message:
        body.message ?? "The service is not fully configured. Retry shortly.",
    }
  }
  return null
}

/** A 401/403/404/409/400 is terminal; a 503 or network failure is retryable. */
export function isRetryable(state: AdminAuthState): boolean {
  return state.status === "misconfigured" || state.status === "offline"
}

export type AdminFetchDeps = {
  fetchImpl: typeof fetch
  hadSession: () => boolean
  setAuthState: (state: AdminAuthState) => void
}

/**
 * Perform an admin API request.
 *
 * On a session-ending or service-level failure it throws `SessionEnded`
 * carrying the ORIGINAL request, so the caller can replay it after
 * re-authenticating. Discarding an operator's unsaved edit on session expiry
 * would be a silent failure.
 */
export async function adminFetch(
  path: string,
  init: RequestInit,
  deps: AdminFetchDeps
): Promise<Response> {
  let response: Response
  try {
    response = await deps.fetchImpl(path, { ...init, credentials: "same-origin" })
  } catch (err) {
    const state: AdminAuthState = {
      status: "offline",
      message: "Could not reach the server. Check your connection and retry.",
    }
    deps.setAuthState(state)
    throw new SessionEnded(path, init, state)
  }

  if (response.ok) return response

  const body: ApiError = await response
    .clone()
    .json()
    .catch(() => ({}) as ApiError)

  const state = stateForResponse(
    response.status,
    body,
    deps.hadSession(),
    response.headers.get("retry-after")
  )

  if (state) {
    deps.setAuthState(state)
    throw new SessionEnded(path, init, state)
  }

  throw new AdminRequestFailed(response.status, body)
}

/**
 * Build an admin API path with every segment encoded.
 *
 * Client code previously interpolated raw: `${apiBase}/tenants/${tenantId}`.
 */
export function adminPath(...segments: string[]): string {
  return `/api/admin/${segments.map((s) => encodeURIComponent(s)).join("/")}`
}
