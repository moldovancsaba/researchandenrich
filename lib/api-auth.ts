export function requireApiKey(request: Request): Response | null {
  const authHeader = request.headers.get("authorization")
  const xApiKey = request.headers.get("x-api-key")
  const hasBearer = authHeader && authHeader.startsWith("Bearer ")
  const hasXKey = xApiKey && xApiKey.trim().length > 0
  if (!hasBearer && !hasXKey) {
    return new Response(JSON.stringify({ error: "Missing or invalid API key" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    })
  }
  return null
}
