import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/lib/db.mjs";
import { SESSION_COOKIE } from "@/lib/config.mjs";
import { verifySession } from "@/lib/sessions.mjs";
import { startCheckout } from "@/lib/billing.mjs";
import { assertCan } from "@/lib/roles.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Starting a checkout.
//
// No payment provider is connected, and this endpoint says so with a 503 rather than pretending:
// a button that silently does nothing is worse than one that explains itself. The order of checks
// is the order that matters: session, then role, then configuration.

export async function POST(request: Request) {
  const jar = await cookies();
  const session = verifySession(getDb(), jar.get(SESSION_COOKIE)?.value ?? "");

  if (!session.ok) {
    return NextResponse.json(
      { ok: false, error: { code: "unauthorized", message: "Sign in to change your plan." } },
      { status: 401 },
    );
  }
  if (!session.orgId) {
    return NextResponse.json(
      { ok: false, error: { code: "no_workspace", message: "Choose a workspace first." } },
      { status: 400 },
    );
  }

  // Only somebody who can commit the business can commit it to a subscription.
  try {
    assertCan(session.role, "billing:write");
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: "forbidden", message: "Only an owner can change the plan." } },
      { status: 403 },
    );
  }

  let body: { planId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: "invalid_json", message: "The body is not JSON." } },
      { status: 400 },
    );
  }

  const planId = String(body.planId ?? "").trim();
  if (!planId) {
    return NextResponse.json(
      { ok: false, error: { code: "no_plan", message: "Which plan?" } },
      { status: 400 },
    );
  }

  if (!process.env.PAYMENT_PROVIDER_KEY?.trim()) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "provider_not_configured",
          message:
            "No payment provider is connected yet, so nothing can be charged. The plan is recorded and no card is taken.",
        },
      },
      { status: 503 },
    );
  }

  // The record exists so that the webhook has something to attach to when it arrives. Everything
  // after this point is the provider adapter, which is the piece a developer adds with real keys.
  const pending = startCheckout(getDb(), session.orgId, planId);

  return NextResponse.json(
    {
      ok: false,
      error: {
        code: "adapter_missing",
        message: `Plan ${pending.plan.name} recorded as pending. The provider adapter that returns a checkout URL is not built.`,
      },
    },
    { status: 501 },
  );
}
