import { NextResponse } from "next/server";
import { getDb } from "@/lib/db.mjs";
import { ensurePlans } from "@/lib/plans.mjs";
import { planForDisplay } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The price list, from the database rather than from the marketing page.
//
// One source of truth matters more than it sounds: the website, the app and the structured data all
// quote the same numbers, so a price change is one deploy rather than three edits that drift.
export async function GET() {
  try {
    const db = getDb();
    ensurePlans(db);

    return NextResponse.json({
      ok: true,
      data: {
        currency: "USD",
        plans: planForDisplay(db).map((plan) => ({
          id: plan.id,
          name: plan.name,
          monthly: plan.monthly,
          setup: plan.setup,
          liveInDays: plan.liveInDays,
          limits: plan.limits,
        })),
      },
    });
  } catch (error) {
    console.error("[plans] failed:", error);
    return NextResponse.json(
      { ok: false, error: { code: "unavailable", message: "The price list is temporarily unavailable." } },
      { status: 503 },
    );
  }
}
