import { NextRequest, NextResponse } from "next/server"

export async function GET(request: NextRequest) {
  return NextResponse.json({
    status: "ok",
    framework: "nextjs",
    timestamp: new Date().toISOString(),
  })
}