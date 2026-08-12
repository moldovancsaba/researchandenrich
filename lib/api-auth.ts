import { NextResponse } from 'next/server'

const API_KEY = process.env.ADMIN_API_KEY || ''

export function requireApiKey(request: Request): NextResponse | null {
  if (!API_KEY) {
    // Fail open only outside production -- a local/dev/test environment with
    // no key configured shouldn't need one. In production, an unset
    // ADMIN_API_KEY is a misconfiguration and must fail closed instead of
    // silently dropping auth on every route this guards (mirrors
    // salesleadgenerator's own requireApiKey, issue #105 there).
    if (process.env.NODE_ENV === 'production') {
      return NextResponse.json(
        { error: 'Unauthorized', details: 'ADMIN_API_KEY is not configured' },
        { status: 401 }
      )
    }
    return null
  }

  const headerKey = request.headers.get('x-api-key')
  if (headerKey === API_KEY) {
    return null
  }

  return NextResponse.json(
    { error: 'Unauthorized', details: 'Missing or invalid x-api-key' },
    { status: 401 }
  )
}
