import { NextResponse } from "next/server";
import { getDb } from "@/lib/db.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The deployment preflight checks that a health endpoint exists. This one actually touches the
// database, so it fails when the database is unreachable instead of reporting a cheerful 200.
export async function GET() {
  try {
    getDb().prepare("select 1 as ok").get();
    return NextResponse.json({
      ok: true,
      service: "universal-business-os",
      database: "reachable",
      time: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, service: "universal-business-os", database: "unreachable" },
      { status: 503 },
    );
  }
}
