import "./setup.mjs";

import { PLAN_DEFINITIONS } from "../src/lib/plans.mjs";
const limitOf = (plan, feature) => PLAN_DEFINITIONS.find((p) => p.id === plan).limits[feature];

import test from "node:test";
import assert from "node:assert/strict";
import { openTestDb, closeDb } from "../src/lib/db.mjs";
import { seedPlans } from "./fixtures.mjs";
import { createUser, createOrganization, startTrial, grant, entitlementFor } from "../src/lib/accounts.mjs";
import {
  applyEvent,
  startCheckout,
  syncEntitlements,
  isPaying,
  verifyStripeSignature,
  verifyHmacSignature,
  normaliseStripeEvent,
  payloadHashOf,
  withinLimit,
} from "../src/lib/billing.mjs";
import { listAudit } from "../src/lib/audit.mjs";

const HMAC_SECRET = "sandbox-secret-for-tests";
const future = (days) => new Date(Date.now() + days * 86_400_000).toISOString();
const past = (days) => new Date(Date.now() - days * 86_400_000).toISOString();

// A workspace with a plan, and a pending subscription carrying a provider reference, which is what
// a checkout leaves behind before the provider says anything.
function setup({ plan = "starter" } = {}) {
  const db = seedPlans(openTestDb());
  const owner = createUser(db, { email: "owner@alpha.test", password: "a-long-enough-password" });
  const other = createUser(db, { email: "other@beta.test", password: "a-long-enough-password" });
  const alpha = createOrganization(db, { name: "Alpha Clinic", ownerUserId: owner.userId });
  const beta = createOrganization(db, { name: "Beta Consulting", ownerUserId: other.userId });

  startTrial(db, beta.orgId, plan);

  const pending = startCheckout(db, alpha.orgId, plan);
  return { db, alpha: alpha.orgId, beta: beta.orgId, owner, reference: pending.providerReference, plan };
}

function activate(db, reference, { plan = "starter", periodEnd = future(30), eventId = "evt_1" } = {}) {
  return applyEvent(db, {
    provider: "sandbox",
    eventId,
    type: "subscription.updated",
    data: { providerSubscriptionId: reference, status: "active", planId: plan, periodEnd },
    raw: JSON.stringify({ eventId, plan }),
  });
}

/* signatures --------------------------------------------------------------- */

test("no secret means no trust", () => {
  assert.deepEqual(verifyStripeSignature("{}", "t=1,v1=abc", "").reason, "no_secret");
  assert.deepEqual(verifyHmacSignature("{}", "sha256=abc", "").reason, "no_secret");
  assert.deepEqual(verifyStripeSignature("{}", "", "secret").reason, "missing_header");
});

test("a signature is checked over the exact bytes, in both provider shapes", async () => {
  const { createHmac } = await import("node:crypto");
  const body = JSON.stringify({ hello: "world" });
  const now = 1_800_000_000_000;

  const good = `t=${Math.floor(now / 1000)},v1=${createHmac("sha256", "whsec").update(`${Math.floor(now / 1000)}.${body}`).digest("hex")}`;
  assert.equal(verifyStripeSignature(body, good, "whsec", { now }).ok, true);
  assert.equal(verifyStripeSignature(body, good, "wrong-secret", { now }).reason, "bad_signature");
  assert.equal(verifyStripeSignature(`${body} `, good, "whsec", { now }).reason, "bad_signature");

  const hmac = `sha256=${createHmac("sha256", HMAC_SECRET).update(body).digest("hex")}`;
  assert.equal(verifyHmacSignature(body, hmac, HMAC_SECRET).ok, true);
  assert.equal(verifyHmacSignature(body, "sha256=deadbeef", HMAC_SECRET).reason, "bad_signature");
});

test("an old signature is refused, so a captured request cannot be replayed tomorrow", async () => {
  const { createHmac } = await import("node:crypto");
  const body = "{}";
  const stale = Math.floor(Date.now() / 1000) - 3600;
  const header = `t=${stale},v1=${createHmac("sha256", "whsec").update(`${stale}.${body}`).digest("hex")}`;
  assert.equal(verifyStripeSignature(body, header, "whsec").reason, "stale_timestamp");
});

test("an unknown provider event type is ignored rather than guessed at", () => {
  assert.equal(normaliseStripeEvent({ id: "evt", type: "customer.updated", data: {} }).type, "ignored");
  assert.equal(normaliseStripeEvent({ id: "evt", type: "invoice.paid", data: { object: { currency: "usd" } } }).type, "payment.succeeded");
});

/* applying events ---------------------------------------------------------- */

test("a paid subscription grants the plan's entitlements", () => {
  const { db, alpha, reference } = setup();

  const result = activate(db, reference);
  assert.equal(result.applied, true);
  assert.equal(result.status, "active");

  const subscription = db.prepare("select * from subscriptions where provider_id = ?").get(reference);
  assert.equal(subscription.status, "active");
  assert.equal(subscription.plan_id, "starter");

  assert.equal(entitlementFor(db, alpha, "contacts").granted, true);
  assert.equal(entitlementFor(db, alpha, "contacts").limit, limitOf("starter", "contacts"));
  assert.equal(entitlementFor(db, alpha, "seats").limit, 2);

  closeDb();
});

test("a retried event applies once", () => {
  const { db, alpha, reference } = setup();

  const first = activate(db, reference, { eventId: "evt_same" });
  assert.equal(first.applied, true);

  // Providers retry. The second attempt must be a no-op, which is what the unique index on
  // (provider, event_id) guarantees even when two retries arrive at the same moment.
  const second = activate(db, reference, { eventId: "evt_same" });
  assert.equal(second.applied, false);
  assert.equal(second.reason, "duplicate");

  assert.equal(db.prepare("select count(*) as n from webhook_events").get().n, 1);
  assert.equal(entitlementFor(db, alpha, "contacts").limit, limitOf("starter", "contacts"));

  closeDb();
});

test("two different events carrying identical content are both applied", () => {
  const { db, reference } = setup();
  const raw = JSON.stringify({ same: "body" });

  const one = applyEvent(db, { provider: "sandbox", eventId: "evt_a", type: "subscription.updated", data: { providerSubscriptionId: reference, status: "active", planId: "starter", periodEnd: future(30) }, raw });
  const two = applyEvent(db, { provider: "sandbox", eventId: "evt_b", type: "subscription.updated", data: { providerSubscriptionId: reference, status: "active", planId: "starter", periodEnd: future(30) }, raw });

  assert.equal(one.applied, true);
  assert.equal(two.applied, true, "deduplication is by event id, not by payload");

  const rows = db.prepare("select payload_hash from webhook_events order by event_id").all();
  assert.equal(rows[0].payload_hash, payloadHashOf(raw), "the payload hash is recorded for investigation");

  closeDb();
});

test("an event for a subscription we do not know changes nothing", () => {
  const { db, alpha, reference } = setup();

  const result = applyEvent(db, { provider: "sandbox", eventId: "evt_ghost", type: "subscription.updated", data: { providerSubscriptionId: "sub_from_nowhere", status: "active", planId: "professional", periodEnd: future(30) } });

  assert.equal(result.applied, false);
  assert.equal(result.reason, "unknown_subscription");
  assert.equal(db.prepare("select count(*) as n from entitlements where organization_id = ?").get(alpha).n, 0);

  // And a webhook cannot conjure a subscription into existence, which is the point.
  assert.equal(db.prepare("select count(*) as n from subscriptions").get().n, 2, "alpha pending plus beta trial");
  assert.equal(db.prepare("select status from subscriptions where provider_id = ?").get(reference).status, "incomplete");

  closeDb();
});

test("an unrecognised event type is recorded and ignored", () => {
  const { db } = setup();
  const result = applyEvent(db, { provider: "sandbox", eventId: "evt_unknown", type: "ignored", data: {} });
  assert.equal(result.applied, false);
  assert.equal(result.reason, "ignored_type");
  assert.equal(db.prepare("select count(*) as n from webhook_events where event_id = 'evt_unknown'").get().n, 1);
  closeDb();
});

test("a failed payment keeps access to the end of the paid period", () => {
  const { db, alpha, reference } = setup();
  activate(db, reference, { periodEnd: future(10) });

  const failed = applyEvent(db, { provider: "sandbox", eventId: "evt_fail", type: "payment.failed", data: { providerSubscriptionId: reference, periodEnd: future(10) } });
  assert.equal(failed.applied, true);
  assert.equal(failed.status, "past_due");

  // Losing a clinic because a card expired on a Friday is not a business anyone wants.
  assert.equal(entitlementFor(db, alpha, "contacts").granted, true);
  assert.equal(isPaying({ status: "past_due", period_end: future(10) }), true);

  // But once the period they already paid for has run out, it stops.
  assert.equal(isPaying({ status: "past_due", period_end: past(1) }), false);
  syncEntitlements(db, alpha, "starter", { status: "past_due", periodEnd: past(1) });
  assert.equal(entitlementFor(db, alpha, "contacts").granted, false);

  closeDb();
});

test("cancelling at period end keeps the service until then, cancelling now does not", () => {
  const { db, reference } = setup();
  activate(db, reference, { periodEnd: future(20) });

  applyEvent(db, { provider: "sandbox", eventId: "evt_cancel_end", type: "subscription.canceled", data: { providerSubscriptionId: reference, atPeriodEnd: true, periodEnd: future(20) } });
  const kept = db.prepare("select * from subscriptions where provider_id = ?").get(reference);
  assert.equal(kept.status, "canceled");
  assert.equal(isPaying(kept), true, "they paid for this period");

  applyEvent(db, { provider: "sandbox", eventId: "evt_cancel_now", type: "subscription.canceled", data: { providerSubscriptionId: reference, atPeriodEnd: false } });
  const stopped = db.prepare("select * from subscriptions where provider_id = ?").get(reference);
  assert.equal(isPaying(stopped), false);

  closeDb();
});

test("an upgrade adds entitlements and a downgrade takes them away", () => {
  const { db, alpha, reference } = setup();
  activate(db, reference, { plan: "starter" });
  assert.equal(entitlementFor(db, alpha, "contacts").limit, limitOf("starter", "contacts"));

  applyEvent(db, { provider: "sandbox", eventId: "evt_up", type: "subscription.updated", data: { providerSubscriptionId: reference, status: "active", planId: "professional", periodEnd: future(30) } });
  assert.equal(entitlementFor(db, alpha, "contacts").limit, limitOf("professional", "contacts"));
  assert.equal(entitlementFor(db, alpha, "seats").limit, 10);

  // A downgrade that only adds entitlements is not a downgrade.
  applyEvent(db, { provider: "sandbox", eventId: "evt_down", type: "subscription.updated", data: { providerSubscriptionId: reference, status: "active", planId: "starter", periodEnd: future(30) } });
  assert.equal(entitlementFor(db, alpha, "contacts").limit, limitOf("starter", "contacts"));
  assert.equal(entitlementFor(db, alpha, "seats").limit, 2);

  closeDb();
});

test("an entitlement that is not in the plan is revoked, not left behind", () => {
  const { db, alpha } = setup();
  startTrial(db, alpha, "starter");
  grant(db, alpha, "ai-voice-minutes", 500);
  assert.equal(entitlementFor(db, alpha, "ai-voice-minutes").granted, true);

  const result = syncEntitlements(db, alpha, "starter", { status: "active", periodEnd: future(30) });
  assert.equal(result.revoked, 1);
  assert.equal(entitlementFor(db, alpha, "ai-voice-minutes").granted, false);

  closeDb();
});

test("billing events for one workspace never touch another", () => {
  const { db, alpha, beta, reference } = setup();
  activate(db, reference, { plan: "starter" });

  assert.equal(entitlementFor(db, alpha, "contacts").limit, limitOf("starter", "contacts"));
  assert.equal(entitlementFor(db, beta, "contacts").limit, limitOf("starter", "contacts"), "beta is on its own trial");

  // Cancelling alpha must leave beta working.
  applyEvent(db, { provider: "sandbox", eventId: "evt_alpha_cancel", type: "subscription.canceled", data: { providerSubscriptionId: reference, atPeriodEnd: false } });
  assert.equal(entitlementFor(db, alpha, "contacts").granted, false);
  assert.equal(entitlementFor(db, beta, "contacts").granted, true);

  closeDb();
});

test("a plan that does not exist grants nothing rather than everything", () => {
  const { db, alpha } = setup();
  const result = syncEntitlements(db, alpha, "plan-that-does-not-exist", { status: "active", periodEnd: future(30) });
  assert.equal(result.reason, "unknown_plan");
  assert.equal(entitlementFor(db, alpha, "contacts").granted, false);
  closeDb();
});

test("an abandoned checkout grants nothing", () => {
  const { db, alpha } = setup();
  assert.equal(entitlementFor(db, alpha, "contacts").granted, false, "incomplete is not a customer");
  assert.equal(isPaying({ status: "incomplete", trial_end: future(1), period_end: future(30) }), false);
  closeDb();
});

test("each applied billing event is recorded in the audit trail", () => {
  const { db, alpha, reference } = setup();
  activate(db, reference);
  const actions = listAudit(db, alpha).map((r) => r.action);
  assert.ok(actions.includes("billing.subscription.updated"));
  closeDb();
});

/* enforcement -------------------------------------------------------------- */

test("a plan limit is enforced on the server, not by hiding a button", () => {
  const { db, alpha, reference } = setup();
  activate(db, reference, { plan: "starter" });

  assert.equal(withinLimit(db, alpha, "contacts", { current: 249 }).allowed, true);
  assert.equal(withinLimit(db, alpha, "contacts", { current: limitOf("starter", "contacts") }).allowed, false);
  assert.equal(withinLimit(db, alpha, "contacts", { current: limitOf("starter", "contacts") }).reason, "limit_reached");

  closeDb();
});

test("a feature nobody granted is refused rather than treated as unlimited", () => {
  const { db, alpha, reference } = setup();
  activate(db, reference, { plan: "starter" });
  const result = withinLimit(db, alpha, "ai-voice-minutes", { current: 0 });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "not_entitled");
  closeDb();
});

test("the two halves of the system agree when a subscription lapses", () => {
  const { db, beta } = setup();

  // A trial that was granted and has now expired: the entitlement row survives, the subscription
  // does not pay. Both checks must say no, or a lapsed workspace keeps a paying feature.
  db.prepare("delete from subscriptions where organization_id = ?").run(beta);

  assert.equal(entitlementFor(db, beta, "contacts").granted, false);
  assert.equal(withinLimit(db, beta, "contacts", { current: 0 }).allowed, false);
  assert.equal(withinLimit(db, beta, "contacts", { current: 0 }).reason, "not_paying");

  closeDb();
});

test("an expired trial stops granting and stops allowing", () => {
  const { db, beta } = setup();

  // Replace the live trial with one that ended ninety days ago. Without clearing the existing row
  // the newest subscription by created_at would still be the live one, and the test would pass for
  // the wrong reason.
  db.prepare("delete from subscriptions where organization_id = ?").run(beta);
  startTrial(db, beta, "starter", { days: 14, now: Date.now() - 90 * 86_400_000 });

  assert.equal(entitlementFor(db, beta, "contacts").granted, false);
  assert.equal(withinLimit(db, beta, "contacts", { current: 0 }).reason, "not_paying");

  closeDb();
});
