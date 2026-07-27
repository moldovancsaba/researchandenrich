export function requireApiKey(request: Request): Response | null {
  const authHeader = request.headers.get("authorization")
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "Missing or invalid API key" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    })
  }
  return null
}
