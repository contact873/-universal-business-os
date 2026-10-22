import { NextResponse } from "next/server";
import { getDb } from "@/lib/db.mjs";
import { applyEvent } from "@/lib/types";
import {
  normaliseStripeEvent,
  verifyStripeSignature,
  verifyHmacSignature,
} from "@/lib/billing.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Billing webhooks. This endpoint decides when a customer is paying, so it is the most dangerous
// surface in the application and is written to fail closed.
//
//   * No secret configured means every request is refused with 503. An endpoint that trusts an
//     unsigned body because the secret was forgotten is worse than one that is switched off.
//   * The raw body is verified before it is parsed, because a signature covers bytes and a parsed
//     object no longer has them.
//   * A duplicate event answers 200 and changes nothing. Providers retry by design, and answering
//     500 to a retry causes an infinite loop.
//   * An event about a subscription we do not know is recorded and ignored. Creating a customer
//     from a webhook alone would mean anything that can sign an event can create a paying account.

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET?.trim() ?? "";
const BILLING_WEBHOOK_SECRET = process.env.BILLING_WEBHOOK_SECRET?.trim() ?? "";

export async function POST(request: Request) {
  const raw = await request.text();

  const stripeHeader = request.headers.get("stripe-signature");
  const sandboxHeader = request.headers.get("x-billing-signature");

  // The presence of Stripe's header selects Stripe. Otherwise the sandbox shape is used, which
  // exists so that the whole path can be exercised without a payment account.
  const isStripe = Boolean(stripeHeader);
  const provider = isStripe ? "stripe" : "sandbox";

  const check = isStripe
    ? verifyStripeSignature(raw, stripeHeader, STRIPE_WEBHOOK_SECRET)
    : verifyHmacSignature(raw, sandboxHeader, BILLING_WEBHOOK_SECRET);

  if (!check.ok) {
    const notConfigured = check.reason === "no_secret";
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: check.reason,
          message: notConfigured
            ? "This endpoint is not configured, so it refuses every request rather than trusting an unsigned body."
            : "The signature did not verify.",
        },
      },
      { status: notConfigured ? 503 : 401 },
    );
  }

  let body: Record<string, any>;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: "invalid_json", message: "The body is not JSON." } },
      { status: 400 },
    );
  }

  const event = isStripe
    ? normaliseStripeEvent(body)
    : {
        type: body.type ?? "ignored",
        providerEventId: body.eventId ?? body.id ?? null,
        data: body.data ?? {},
      };

  const eventId = event.providerEventId ?? body.id ?? null;
  if (!eventId) {
    return NextResponse.json(
      { ok: false, error: { code: "no_event_id", message: "The event has no id, so it cannot be deduplicated." } },
      { status: 400 },
    );
  }

  try {
    const result = applyEvent(getDb(), {
      provider,
      eventId,
      type: event.type,
      data: event.data,
      raw,
    });

    // 200 for a duplicate, an ignored type, or an unknown subscription: all three are handled, and
    // a retry of any of them would behave identically.
    return NextResponse.json({ ok: true, applied: result.applied, reason: result.reason ?? null });
  } catch (error) {
    // Only a genuine failure earns a retry.
    console.error("[billing] webhook failed:", error);
    return NextResponse.json(
      { ok: false, error: { code: "processing_failed", message: "Something went wrong on our side." } },
      { status: 500 },
    );
  }
}
