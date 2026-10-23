// Billing: provider events in, subscription state and entitlements out.
//
// The rule this file exists to enforce, from the blueprint and from bitter experience with
// payment providers: billing state is driven by verified webhook events, never by the customer
// landing back on a success page. A browser redirect can be forged, replayed, or simply never
// happen if the customer closes the tab.
//
// Two properties are load-bearing and both are tested:
//   1. Idempotency. Providers retry. A retried payment must not grant a second subscription or a
//      second round of credits. The provider's own event id is the defence, and its uniqueness is
//      enforced by the database rather than by an application check, because two concurrent
//      retries would both pass an application check.
//   2. Fail closed. With no webhook secret configured, the endpoint refuses everything rather than
//      trusting an unsigned body.

import { createHmac, timingSafeEqual, createHash } from "node:crypto";
import { id as newId, nowIso } from "./identities.mjs";
import { grant } from "./accounts.mjs";
import { writeAudit } from "./audit.mjs";
import { isPaying } from "./subscription-state.mjs";

export { isPaying };

// How long the signature may be old before it is refused. Stripe's own guidance is five minutes.
const SIGNATURE_TOLERANCE_SECONDS = 300;

export const SUBSCRIPTION_STATUSES = ["trialing", "active", "past_due", "canceled", "incomplete"];

/* signatures ---------------------------------------------------------------- */

function safeEqualHex(a, b) {
  const left = Buffer.from(String(a), "utf8");
  const right = Buffer.from(String(b), "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Stripe signs `${timestamp}.${rawBody}` with the endpoint secret and sends
 * `stripe-signature: t=...,v1=...`. The timestamp is checked so a captured request cannot be
 * replayed tomorrow.
 */
export function verifyStripeSignature(rawBody, header, secret, { now = Date.now(), tolerance = SIGNATURE_TOLERANCE_SECONDS } = {}) {
  if (!secret) return { ok: false, reason: "no_secret" };
  if (!header) return { ok: false, reason: "missing_header" };

  const parts = Object.fromEntries(
    String(header)
      .split(",")
      .map((piece) => piece.split("=").map((s) => s.trim()))
      .filter((pair) => pair.length === 2),
  );

  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp)) return { ok: false, reason: "no_timestamp" };
  if (Math.abs(now / 1000 - timestamp) > tolerance) return { ok: false, reason: "stale_timestamp" };
  if (!parts.v1) return { ok: false, reason: "no_signature" };

  const expected = createHmac("sha256", secret).update(`${parts.t}.${rawBody}`).digest("hex");
  if (!safeEqualHex(expected, parts.v1)) return { ok: false, reason: "bad_signature" };
  return { ok: true };
}

/** The same shape, in a simpler header, so a test or a sandbox can drive it without Stripe. */
export function verifyHmacSignature(rawBody, header, secret, { now = Date.now(), tolerance = SIGNATURE_TOLERANCE_SECONDS } = {}) {
  if (!secret) return { ok: false, reason: "no_secret" };
  if (!header) return { ok: false, reason: "missing_header" };

  const value = String(header).startsWith("sha256=") ? String(header).slice(7) : String(header);
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  if (!safeEqualHex(expected, value)) return { ok: false, reason: "bad_signature" };
  return { ok: true };
}

export function payloadHashOf(rawBody) {
  return createHash("sha256").update(String(rawBody)).digest("hex").slice(0, 32);
}

/* normalising provider events ---------------------------------------------- */

// Internally there are five events that matter. Everything else is recorded and ignored, which is
// the correct treatment: a provider will send dozens of types you do not care about, and treating
// an unknown type as a failure would cause endless retries.
const STRIPE_TYPES = {
  "customer.subscription.created": "subscription.updated",
  "customer.subscription.updated": "subscription.updated",
  "customer.subscription.deleted": "subscription.canceled",
  "invoice.paid": "payment.succeeded",
  "invoice.payment_failed": "payment.failed",
};

const STATUS_MAP = {
  trialing: "trialing",
  active: "active",
  past_due: "past_due",
  canceled: "canceled",
  unpaid: "past_due",
  incomplete: "incomplete",
  incomplete_expired: "canceled",
};

export function normaliseStripeEvent(event) {
  const type = STRIPE_TYPES[event?.type];
  if (!type) return { type: "ignored", providerEventId: event?.id ?? null, data: {} };

  const object = event.data?.object ?? {};
  const seconds = Number(object.current_period_end ?? object.period_end ?? 0);

  return {
    type,
    providerEventId: event.id,
    data: {
      providerSubscriptionId: object.subscription ?? object.id ?? null,
      status: STATUS_MAP[object.status] ?? null,
      planId: object.metadata?.plan_id ?? object.plan?.metadata?.plan_id ?? null,
      organisationId: object.metadata?.organisation_id ?? null,
      periodEnd: seconds ? new Date(seconds * 1000).toISOString() : null,
      atPeriodEnd: Boolean(object.cancel_at_period_end),
      amountMinor: Number.isInteger(object.amount_paid ?? object.amount_due) ? (object.amount_paid ?? object.amount_due) : null,
      currency: object.currency ?? null,
    },
  };
}

/* applying an event --------------------------------------------------------- */

/**
 * Applies one verified event. Returns { applied, reason } and never throws for a provider mistake:
 * a webhook that returns 500 gets retried forever, so a malformed event is recorded and answered.
 */
export function applyEvent(db, { provider, eventId, type, data = {}, raw = null, now = Date.now() }) {
  if (!provider || !eventId) return { applied: false, reason: "missing_ids" };

  const at = new Date(now).toISOString();

  return db.transaction(() => {
    // The unique index on (provider, event_id) is the idempotency, not this check. Two retries
    // arriving together both reach the insert, and the second one fails on the constraint.
    try {
      db.prepare(
        `insert into webhook_events (id, provider, event_id, payload_hash, processed_at, created_at)
         values (?, ?, ?, ?, ?, ?)`,
      ).run(newId("wh"), provider, String(eventId), raw ? payloadHashOf(raw) : null, at, at);
    } catch {
      return { applied: false, reason: "duplicate" };
    }

    if (type === "ignored") return { applied: false, reason: "ignored_type" };

    const subscription = data.providerSubscriptionId
      ? db
          .prepare("select * from subscriptions where provider_id = ?")
          .get(String(data.providerSubscriptionId))
      : null;

    if (!subscription) {
      // Recorded, answered with 200, and deliberately not acted on. Creating a subscription from a
      // webhook alone would mean anyone who can sign an event can create a paying customer.
      return { applied: false, reason: "unknown_subscription" };
    }

    const orgId = subscription.organization_id;
    const changes = {};

    if (type === "subscription.updated" || type === "subscription.activated") {
      changes.status = data.status ?? subscription.status;
      changes.plan_id = data.planId ?? subscription.plan_id;
      changes.period_end = data.periodEnd ?? subscription.period_end;
      changes.trial_end = data.status === "trialing" ? data.periodEnd ?? subscription.trial_end : subscription.trial_end;
    } else if (type === "payment.succeeded") {
      // A successful payment is the moment the plan becomes real.
      changes.status = "active";
      changes.period_end = data.periodEnd ?? subscription.period_end;
      changes.plan_id = data.planId ?? subscription.plan_id;
    } else if (type === "payment.failed") {
      // Access continues to the end of the paid period. Cutting a clinic off the moment a card
      // expires loses the customer over a bank problem.
      changes.status = "past_due";
      changes.period_end = data.periodEnd ?? subscription.period_end;
    } else if (type === "subscription.canceled") {
      changes.status = "canceled";
      changes.period_end = data.atPeriodEnd && data.periodEnd ? data.periodEnd : at;
    }

    db.prepare(
      `update subscriptions
          set status = ?, plan_id = ?, trial_end = ?, period_end = ?
        where id = ?`,
    ).run(
      changes.status ?? subscription.status,
      changes.plan_id ?? subscription.plan_id,
      changes.trial_end ?? subscription.trial_end,
      changes.period_end ?? subscription.period_end,
      subscription.id,
    );

    const entitlementChange = syncEntitlements(db, orgId, changes.plan_id ?? subscription.plan_id, {
      now,
      status: changes.status ?? subscription.status,
      periodEnd: changes.period_end ?? subscription.period_end,
      trialEnd: changes.trial_end ?? subscription.trial_end,
    });

    writeAudit(db, {
      orgId,
      actorUserId: null,
      action: `billing.${type}`,
      entity: "subscription",
      entityId: subscription.id,
      meta: { provider, eventId, status: changes.status, planId: changes.plan_id, entitlements: entitlementChange },
    });

    return { applied: true, orgId, status: changes.status ?? subscription.status, entitlements: entitlementChange };
  })();
}

/**
 * Brings the entitlement rows in line with the plan. Revoking matters as much as granting: a
 * downgrade that only adds entitlements is not a downgrade.
 */
export function syncEntitlements(db, orgId, planId, { now = Date.now(), status = "active", periodEnd = null, trialEnd = null } = {}) {
  if (!planId) return { granted: 0, revoked: 0, reason: "no_plan" };

  const plan = db.prepare("select * from plans where id = ?").get(planId);
  if (!plan) return { granted: 0, revoked: 0, reason: "unknown_plan" };

  // trialEnd has to be passed through, or a trial resolves as "not paying" and the workspace it was
  // just granted access to loses it in the same breath.
  const paying = isPaying({ status, period_end: periodEnd, trial_end: trialEnd }, now);
  const limits = plan.limits_json ? JSON.parse(plan.limits_json) : {};

  if (!paying) {
    const revoked = db
      .prepare("delete from entitlements where organization_id = ?")
      .run(orgId).changes;
    return { granted: 0, revoked, reason: "not_paying" };
  }

  for (const [feature, limit] of Object.entries(limits)) {
    grant(db, orgId, feature, typeof limit === "number" ? limit : null);
  }

  const keep = Object.keys(limits);
  const placeholders = keep.map(() => "?").join(", ");
  const revoked = keep.length
    ? db
        .prepare(
          `delete from entitlements where organization_id = ? and feature not in (${placeholders})`,
        )
        .run(orgId, ...keep).changes
    : 0;

  return { granted: keep.length, revoked };
}

/* reading state ------------------------------------------------------------- */

export function currentSubscription(db, orgId) {
  return (
    db
      .prepare(
        "select * from subscriptions where organization_id = ? order by created_at desc limit 1",
      )
      .get(orgId) ?? null
  );
}

export function startCheckout(db, orgId, planId) {
  const plan = db.prepare("select * from plans where id = ?").get(planId);
  if (!plan) {
    const error = new Error(`Unknown plan "${planId}".`);
    error.status = 400;
    throw error;
  }

  // A pending subscription, so the webhook has something to attach to when it arrives. Status
  // "incomplete" grants nothing.
  const subscriptionId = newId("sub");
  const providerReference = `local_${orgId}_${planId}_${Date.now().toString(36)}`;

  db.prepare(
    `insert into subscriptions (id, organization_id, provider, provider_id, status, plan_id, trial_end, period_end, created_at)
     values (?, ?, NULL, ?, 'incomplete', ?, null, null, ?)`,
  ).run(subscriptionId, orgId, providerReference, planId, nowIso());

  return { subscriptionId, providerReference, plan };
}

/* card-on-file trials ------------------------------------------------------ */

export const TRIAL_DAYS = 7;

/**
 * A pending subscription that requires a card.
 *
 * Status is 'incomplete', which `isPaying` treats as not paying, so a visitor who registers but
 * never attaches a card gets no access. That is what makes "card first" a property of the system
 * rather than a promise in the interface.
 */
export function beginCardTrial(db, orgId, planId, { trialDays = TRIAL_DAYS, now = Date.now() } = {}) {
  const plan = db.prepare("select * from plans where id = ?").get(planId);
  if (!plan) {
    const error = new Error(`Unknown plan "${planId}".`);
    error.status = 400;
    throw error;
  }

  const subscriptionId = newId("sub");
  db.prepare(
    `insert into subscriptions
       (id, organization_id, provider, provider_id, status, plan_id, trial_end, period_end, trial_days, created_at)
     values (?, ?, null, null, 'incomplete', ?, null, null, ?, ?)`,
  ).run(subscriptionId, orgId, planId, trialDays, new Date(now).toISOString());

  writeAudit(db, {
    orgId,
    actorUserId: null,
    action: "billing.trial_awaiting_card",
    entity: "subscription",
    entityId: subscriptionId,
    meta: { planId, trialDays },
  });

  return { subscriptionId, plan, trialDays, status: "incomplete" };
}

/**
 * Called by the provider adapter once a card is confirmed attached.
 *
 * Only brand and last four are stored. The card itself lives with the provider, which is what keeps
 * this database out of PCI scope.
 */
export function attachPaymentMethod(db, orgId, { customerId, brand = null, last4 = null, now = Date.now(), trialDays = null }) {
  if (!customerId) return { ok: false, reason: "no_customer" };

  const subscription = db
    .prepare("select * from subscriptions where organization_id = ? order by created_at desc limit 1")
    .get(orgId);
  if (!subscription) return { ok: false, reason: "no_subscription" };

  const days = trialDays ?? subscription.trial_days ?? TRIAL_DAYS;
  const trialEnd = new Date(now + days * 86_400_000).toISOString();
  const at = new Date(now).toISOString();

  db.prepare(
    `update subscriptions
        set status = 'trialing',
            provider_customer_id = ?,
            payment_method_brand = ?,
            payment_method_last4 = ?,
            card_on_file_at = ?,
            trial_end = ?,
            trial_days = ?
      where id = ?`,
  ).run(customerId, brand, last4, at, trialEnd, days, subscription.id);

  const entitlements = syncEntitlements(db, orgId, subscription.plan_id, {
    now,
    status: "trialing",
    trialEnd,
  });

  writeAudit(db, {
    orgId,
    actorUserId: null,
    action: "billing.card_attached",
    entity: "subscription",
    entityId: subscription.id,
    // Deliberately no card number, no expiry, no CVV. Only what a support agent needs to identify
    // the card the customer is talking about.
    meta: { brand, last4, trialEnd },
  });

  return { ok: true, subscriptionId: subscription.id, status: "trialing", trialEnd, entitlements };
}

/** What the provider is expected to do next, expressed for a human reading a support ticket. */
export function trialState(db, orgId, { now = Date.now() } = {}) {
  const subscription = currentSubscription(db, orgId);
  if (!subscription) return { status: "none", paying: false, cardOnFile: false };

  const trialEnd = subscription.trial_end ? Date.parse(subscription.trial_end) : null;

  return {
    status: subscription.status,
    paying: isPaying(subscription, now),
    cardOnFile: Boolean(subscription.card_on_file_at),
    trialDays: subscription.trial_days ?? null,
    trialEnd: subscription.trial_end ?? null,
    endsInDays: trialEnd ? Math.ceil((trialEnd - now) / 86_400_000) : null,
  };
}

/**
 * Plan limits, checked on the server. The interface hiding a button is not enforcement: anybody
 * with a session can post to the action directly.
 *
 * Two kinds of limit, and the distinction matters to a customer:
 *
 *   standing   contacts and seats. A count of what exists. Hitting the ceiling stops new records
 *              and nothing else; existing records stay readable, searchable and editable, and the
 *              ceiling does not move on its own.
 *   metered    assistant minutes and SMS. A monthly allowance that resets on the first of the
 *              month, so one busy week cannot burn an account permanently.
 *
 * Nothing here deletes a customer's data to enforce a limit, ever. Reaching a cap is a reason to
 * upgrade, not a reason to lose work.
 *
 * The subscription state is consulted here as well as the entitlement row, because entitlement
 * rows survive a lapse. Without this check the two halves of the system would disagree: hasFeature
 * would correctly say no while withinLimit said yes, which is exactly the kind of gap that ends up
 * as a paying feature used by a non-paying workspace.
 */
export function withinLimit(db, orgId, feature, { current = null, now = Date.now() } = {}) {
  const row = db
    .prepare("select limit_value from entitlements where organization_id = ? and feature = ?")
    .get(orgId, feature);

  if (!row) return { allowed: false, limit: 0, current, reason: "not_entitled" };

  if (!isPaying(currentSubscription(db, orgId), now)) {
    return { allowed: false, limit: row.limit_value, current, reason: "not_paying" };
  }

  if (row.limit_value === null) return { allowed: true, limit: null, current, reason: "unlimited" };

  const count = current ?? countFor(db, orgId, feature, now);
  return {
    allowed: count < row.limit_value,
    limit: row.limit_value,
    current: count,
    reason: count < row.limit_value ? "within_limit" : "limit_reached",
    // Metered features reset; standing counts do not. The interface needs to know which it is
    // showing, or it will offer a reset that never comes.
    resets: METERED_FEATURES.has(feature),
  };
}

/** Metered against a monthly allowance, resetting on the first of the month, UTC. */
const METERED_FEATURES = new Set(["assistant-minutes", "sms-messages"]);

/** The start of the allowance window that `now` falls in. */
export function periodStart(now = Date.now()) {
  const date = new Date(now);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString();
}

/**
 * Records consumption so the allowance means something. Called by whatever does the work: a
 * completed assistant call, a sent SMS.
 */
export function recordUsage(db, orgId, eventType, quantity = 1, { now = Date.now() } = {}) {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    const error = new Error("Usage quantity must be a positive whole number.");
    error.status = 400;
    throw error;
  }

  db.prepare(
    "insert into usage_events (id, organization_id, event_type, quantity, created_at) values (?, ?, ?, ?, ?)",
  ).run(newId("use"), orgId, eventType, quantity, new Date(now).toISOString());

  return { ok: true, eventType, quantity, at: new Date(now).toISOString() };
}

/** What has been consumed in the current allowance window. */
export function usageThisPeriod(db, orgId, { now = Date.now() } = {}) {
  const since = periodStart(now);
  const rows = db
    .prepare(
      `select event_type, sum(quantity) as used
         from usage_events
        where organization_id = ? and created_at >= ?
        group by event_type`,
    )
    .all(orgId, since);

  return {
    since,
    used: Object.fromEntries(rows.map((row) => [row.event_type, row.used])),
  };
}

function countFor(db, orgId, feature, now = Date.now()) {
  if (feature === "contacts") {
    return db.prepare("select count(*) as n from contacts where organization_id = ?").get(orgId).n;
  }
  if (feature === "seats") {
    return db.prepare("select count(*) as n from memberships where organization_id = ?").get(orgId).n;
  }
  if (METERED_FEATURES.has(feature)) {
    return db
      .prepare(
        `select coalesce(sum(quantity), 0) as n from usage_events
          where organization_id = ? and event_type = ? and created_at >= ?`,
      )
      .get(orgId, feature, periodStart(now)).n;
  }
  return 0;
}
