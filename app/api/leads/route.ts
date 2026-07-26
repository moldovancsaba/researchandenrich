import { NextRequest, NextResponse } from "next/server"
import { readFileSync } from "fs"
import { join } from "path"

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const brand = searchParams.get("brand") || "cogmap"
  const limit = parseInt(searchParams.get("limit") || "1000", 10)

  return NextResponse.json({
    brand,
    limit,
    leads: [],
    note: "ContentCreator API — leads endpoint",
  })
}

export async function POST(request: Request) {
  const body = await request.json()
  return NextResponse.json({ success: true, ...body }, { status: 201 })
}

export async function PUT(request: Request) {
  const body = await request.json()
  return NextResponse.json({ success: true, ...body })
}