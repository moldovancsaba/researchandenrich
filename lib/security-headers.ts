/**
 * Security response headers.
 *
 * The application set none: no CSP, HSTS, nosniff, Referrer-Policy,
 * Permissions-Policy or frame protection. There was also no place to express
 * them -- no `next.config.js`, an empty `vercel.json`, and no middleware.
 */

export type HeaderPolicy = {
  /** CSP is delivered report-only until a clean reporting period is observed.
   *  Enforcing an unvalidated policy on the admin surface would break it. */
  cspReportOnly: boolean
  /** HSTS max-age. Short first: `preload` is difficult to reverse, so the long
   *  value is only appropriate once no HTTP-only dependency remains. */
  hstsMaxAge: number
  hstsPreload: boolean
}

export function policyFromEnv(): HeaderPolicy {
  const reportOnly = process.env.CSP_REPORT_ONLY !== "false"
  const maxAge = Number(process.env.HSTS_MAX_AGE ?? "") || 86400
  return {
    cspReportOnly: reportOnly,
    hstsMaxAge: maxAge,
    hstsPreload: process.env.HSTS_PRELOAD === "true",
  }
}

/**
 * Build the CSP.
 *
 * `unsafe-inline` and `unsafe-eval` are prohibited in `script-src`. GDS is a
 * Mantine-based system that emits inline styles, so `style-src` carries
 * `unsafe-inline` — the alternative would be to weaken the design system's
 * styling, and §7 of every issue forbids overriding GDS to satisfy a local
 * constraint. This is a deliberate, recorded trade rather than an oversight;
 * a nonce-based style policy is possible once GDS documents nonce support.
 *
 * `https://i.ibb.co` is present because ImgBB is the mandated image host for
 * classscout provider records, which may be previewed in the admin surface.
 */
export function buildCsp(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://i.ibb.co",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ")
}

export function securityHeaders(
  nonce: string,
  policy: HeaderPolicy
): Record<string, string> {
  const hsts = [
    `max-age=${policy.hstsMaxAge}`,
    "includeSubDomains",
    ...(policy.hstsPreload ? ["preload"] : []),
  ].join("; ")

  return {
    "Strict-Transport-Security": hsts,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
    "Permissions-Policy":
      "camera=(), microphone=(), geolocation=(), interest-cohort=()",
    [policy.cspReportOnly
      ? "Content-Security-Policy-Report-Only"
      : "Content-Security-Policy"]: buildCsp(nonce),
  }
}

export const SECURITY_HEADER_NAMES = [
  "Strict-Transport-Security",
  "X-Content-Type-Options",
  "Referrer-Policy",
  "X-Frame-Options",
  "Permissions-Policy",
] as const
