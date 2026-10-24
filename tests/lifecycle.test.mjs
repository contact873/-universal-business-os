import "./setup.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { openTestDb, closeDb } from "../src/lib/db.mjs";
import { seedPlans } from "./fixtures.mjs";
import { createUser, createOrganization, entitlementFor, startFreePlan } from "../src/lib/accounts.mjs";
import { runLifecycle, summarise, GRACE_DAYS } from "../src/lib/lifecycle.mjs";
import { outstandingInvoiceFor } from "../src/lib/payments.mjs";
import { upsertSubscriber } from "../src/lib/subscribers.mjs";

const DAY = 86_400_000;
const NOW = Date.parse("2026-06-01T09:00:00Z");

function workspace() {
  const db = seedPlans(openTestDb());
  const owner = createUser(db, { email: "owner@alpha.test", password: "a-long-enough-password" });
  const org = createOrganization(db, { name: "Alpha Clinic", ownerUserId: owner.userId, plan: null });
  return { db, orgId: org.orgId, ownerId: owner.userId };
}

function subscribe(db, orgId, fields) {
  // The organisation may already carry a placeholder subscription, and the lifecycle only looks at the
  // newest one per workspace. Clear it so the scenario under test is the live one.
  db.prepare("delete from subscriptions where organization_id = ?").run(orgId);
  db.prepare(
    `insert into subscriptions
       (id, organization_id, provider, provider_id, status, plan_id, trial_end, period_end, created_at, card_on_file_at, provider_customer_id)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "sub_" + Math.random().toString(36).slice(2, 10),
    orgId,
    fields.provider ?? null,
    fields.providerId ?? null,
    fields.status,
    fields.planId,
    fields.trialEnd ?? null,
    fields.periodEnd ?? null,
    new Date(NOW - 40 * DAY).toISOString(),
    fields.cardOnFile ?? null,
    fields.customer ?? null,
  );
}

test("a trial with a card waits for the provider, and is not resolved twice", () => {
  const { db, orgId } = workspace();
  subscribe(db, orgId, {
    status: "trialing",
    planId: "professional",
    trialEnd: new Date(NOW - DAY).toISOString(),
    cardOnFile: new Date(NOW - 8 * DAY).toISOString(),
    customer: "cus_123",
  });

  const first = runLifecycle(db, { now: NOW });
  assert.equal(first.actions.some((row) => row.action === "awaiting_charge"), true);
  assert.equal(
    db.prepare("select status from subscriptions where organization_id = ?").get(orgId).status,
    "past_due",
    "access continues while the provider decides",
  );

  const second = runLifecycle(db, { now: NOW });
  assert.equal(second.actions.length, 0, "nothing happens on a second run");
  // After the first run the status is past_due, so the trial branch is no longer where it lands. What
  // matters is that the charge was asked for once, which the action record proves.
  assert.equal(
    db.prepare("select count(*) as n from lifecycle_actions where kind = 'trial_ended_charge_due'").get().n,
    1,
    "the charge is requested once, not once per run",
  );

  closeDb();
});

test("a trial without a card falls back to free, keeping the workspace and its data", () => {
  const { db, orgId } = workspace();
  subscribe(db, orgId, { status: "trialing", planId: "professional", trialEnd: new Date(NOW - DAY).toISOString() });

  runLifecycle(db, { now: NOW });

  const live = db
    .prepare("select * from subscriptions where organization_id = ? order by created_at desc limit 1")
    .get(orgId);
  assert.equal(live.plan_id, "free");
  assert.equal(live.status, "active");
  assert.equal(live.period_end, null, "free never expires");
  assert.equal(entitlementFor(db, orgId, "contacts").limit, 100);

  closeDb();
});

test("a bank transfer renewal issues exactly one invoice", () => {
  const { db, orgId } = workspace();
  subscribe(db, orgId, {
    status: "active",
    planId: "professional",
    periodEnd: new Date(NOW - DAY).toISOString(),
    provider: "bank_transfer",
  });

  const first = runLifecycle(db, { now: NOW });
  assert.equal(first.actions.some((row) => row.action === "invoice_issued"), true);
  assert.ok(outstandingInvoiceFor(db, orgId));

  const second = runLifecycle(db, { now: NOW });
  assert.equal(second.actions.length, 0);
  assert.equal(
    db.prepare("select count(*) as n from invoices where organization_id = ?").get(orgId).n,
    1,
    "one period, one invoice, however many times the job runs",
  );

  closeDb();
});

test("past due beyond the grace period drops to free; inside it, nothing happens", () => {
  const { db, orgId } = workspace();
  subscribe(db, orgId, { status: "past_due", planId: "professional", periodEnd: new Date(NOW - DAY).toISOString() });

  const inside = runLifecycle(db, { now: NOW });
  assert.equal(inside.actions.length, 0);
  assert.equal(inside.skipped.some((row) => row.reason === "inside the grace period"), true);

  const later = runLifecycle(db, { now: NOW + (GRACE_DAYS + 1) * DAY });
  assert.equal(later.actions.some((row) => row.action === "downgraded"), true);

  const live = db
    .prepare("select * from subscriptions where organization_id = ? order by created_at desc limit 1")
    .get(orgId);
  assert.equal(live.plan_id, "free");

  closeDb();
});

test("a card renewal is never charged here, only marked as due", () => {
  const { db, orgId } = workspace();
  subscribe(db, orgId, {
    status: "active",
    planId: "professional",
    periodEnd: new Date(NOW - DAY).toISOString(),
    provider: "card",
    customer: "cus_999",
  });

  const result = runLifecycle(db, { now: NOW });
  assert.equal(result.actions.some((row) => row.action === "awaiting_renewal_charge"), true);
  assert.equal(
    db.prepare("select count(*) as n from invoices where organization_id = ?").get(orgId).n,
    0,
    "no invoice is invented for a card subscription",
  );

  closeDb();
});

test("a consented subscriber on free for a month becomes a win-back candidate, once", () => {
  const { db, orgId } = workspace();
  startFreePlan(db, orgId);
  const { subscriberId } = upsertSubscriber(db, {
    email: "quiet@clinic.test",
    company: "Quiet Clinic",
    organizationId: orgId,
    status: "free",
    marketingConsent: true,
  });
  db.prepare("update subscribers set updated_at = ? where id = ?").run(
    new Date(NOW - 40 * DAY).toISOString(),
    subscriberId,
  );

  const result = runLifecycle(db, { now: NOW });
  assert.equal(result.actions.some((row) => row.action === "win_back_offered"), true);
  assert.equal(db.prepare("select count(*) as n from subscriber_offers").get().n, 1);

  const second = runLifecycle(db, { now: NOW });
  assert.equal(second.actions.filter((row) => row.action === "win_back_offered").length, 0);

  closeDb();
});

test("every lifecycle action is audited", () => {
  const { db, orgId } = workspace();
  subscribe(db, orgId, { status: "trialing", planId: "professional", trialEnd: new Date(NOW - DAY).toISOString() });

  runLifecycle(db, { now: NOW });

  const rows = db.prepare("select action from audit_logs where organization_id = ?").all(orgId);
  assert.equal(rows.some((row) => row.action === "lifecycle.downgraded_to_free"), true);

  closeDb();
});

test("the summary is readable at a glance", () => {
  assert.equal(summarise({ actions: [], skipped: [] }), "nothing to do");
  assert.equal(
    summarise({ actions: [{ action: "downgraded" }, { action: "downgraded" }], skipped: [] }),
    "downgraded 2",
  );
});
