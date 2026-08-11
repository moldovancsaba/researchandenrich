import { NextResponse } from "next/server"
import { getDbHealth } from "../../../lib/mongodb"
import { adminAuthState } from "../../../lib/api-auth"

export const dynamic = "force-dynamic"

/**
 * Health probe. Public and unauthenticated by design -- apps.yaml's
 * healthCheckTemplate and external monitoring both consume it.
 *
 * The database probe reports reachability WITHOUT failing the endpoint, so
 * monitoring can distinguish "app up, database unreachable" from "app down".
 * It deliberately exposes no hostname, topology, or database name: this route
 * is unauthenticated.
 */
export async function GET() {
  const database = await getDbHealth()

  return NextResponse.json({
    status: "ok",
    framework: "nextjs",
    database,
    adminAuth: adminAuthState(),
    timestamp: new Date().toISOString(),
  })
}
