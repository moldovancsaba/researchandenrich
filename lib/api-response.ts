import { NextResponse } from "next/server"
import {
  classify,
  errorName,
  log,
  requestIdFrom,
  validationCode,
  type ErrorEnvelope,
  type FieldError,
} from "./errors"

/**
 * NextResponse glue over the framework-free logic in `errors.ts`.
 * All classification, redaction and logging lives there so it stays testable
 * without a bundler.
 */

export { log, classify }
export const requestId = requestIdFrom

export function errorResponse(
  status: number,
  code: string,
  message: string,
  reqId: string,
  fields?: FieldError[]
): NextResponse {
  const body: ErrorEnvelope = { error: code, code, message, requestId: reqId }
  if (fields && fields.length > 0) body.fields = fields
  return NextResponse.json(body, { status })
}

export function validationError(reqId: string, fields: FieldError[]): NextResponse {
  return errorResponse(
    400,
    validationCode(fields),
    "One or more fields failed validation.",
    reqId,
    fields
  )
}

/**
 * Wrap a route handler so no handler can omit error handling by forgetting a
 * try block, and so no exception message can reach a client.
 */
export function withErrorHandling(
  route: string,
  handler: (request: Request) => Promise<Response>
): (request: Request) => Promise<Response> {
  return async (request: Request) => {
    const reqId = requestIdFrom(request)
    const started = Date.now()
    try {
      return await handler(request)
    } catch (err) {
      const { status, code, message } = classify(err)
      // Full detail server-side ONLY. This line is why the response can safely
      // say nothing.
      log({
        level: "error",
        requestId: reqId,
        route,
        method: request.method,
        status,
        code,
        errorClass: errorName(err),
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        durationMs: Date.now() - started,
      })
      return errorResponse(status, code, message, reqId)
    }
  }
}
