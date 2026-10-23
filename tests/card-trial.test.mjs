import "./setup.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { openTestDb, closeDb } from "../src/lib/db.mjs";
import { seedPlans } from "./fixtures.mjs";
import { createUser, createOrganization, entitlementFor } from "../src/lib/accounts.mjs";
import {
  beginCardTrial,
  attachPaymentMethod,
  trialState,
  applyEvent,
  syncEntitlements,
  isPaying,
  withinLimit,
  TRIAL_DAYS,
} from "../src/lib/billing.mjs";
import { listAudit } from "../src/lib/audit.mjs";

function workspace() {
  const db = seedPlans(openTestDb());
  const owner = createUser(db, { email: "owner@alpha.test", password: "a-long-enough-password" });
  const org = createOrganization(db, { name: "Alpha Clinic", ownerUserId: owner.userId });
  return { db, orgId: org.orgId, owner };
}

const DAY = 86_400_000;

test("registering without a card grants nothing", () => {
  const { db, orgId } = workspace();
  const started = beginCardTrial(db, orgId, "professional");

  assert.equal(started.status, "incomplete");
  assert.equal(entitlementFor(db, orgId, "contacts").granted, false, "no card means no access");
  // Nothing was ever granted, so the limit check says not_entitled rather than not_paying: the
  // workspace is registered but has no entitlements to be lapsed.
  assert.equal(withinLimit(db, orgId, "contacts", { current: 0 }).reason, "not_entitled");

  const state = trialState(db, orgId);
  assert.equal(state.paying, false);
  assert.equal(state.cardOnFile, false);
  assert.equal(state.trialDays, TRIAL_DAYS);

  closeDb();
});

test("attaching a card starts the seven day trial and opens the workspace", () => {
  const { db, orgId } = workspace();
  beginCardTrial(db, orgId, "professional");

  const attached = attachPaymentMethod(db, orgId, { customerId: "cus_123", brand: "visa", last4: "4242" });
  assert.equal(attached.ok, true);
  assert.equal(attached.status, "trialing");

  const days = (Date.parse(attached.trialEnd) - Date.now()) / DAY;
  assert.ok(days > 6.9 && days <= 7.1, `trial should be about seven days, was ${days.toFixed(2)}`);

  assert.equal(entitlementFor(db, orgId, "contacts").granted, true);
  assert.equal(withinLimit(db, orgId, "contacts", { current: 0 }).allowed, true);

  const state = trialState(db, orgId);
  assert.equal(state.cardOnFile, true);
  assert.equal(state.endsInDays, 7);

  closeDb();
});

test("only the brand and the last four are stored, never anything that could be a card number", () => {
  const { db, orgId } = workspace();
  beginCardTrial(db, orgId, "professional");
  attachPaymentMethod(db, orgId, { customerId: "cus_123", brand: "mastercard", last4: "4444" });

  const row = db.prepare("select * from subscriptions where organization_id = ?").get(orgId);
  assert.equal(row.payment_method_last4, "4444");
  assert.equal(row.payment_method_brand, "mastercard");
  assert.equal(row.provider_customer_id, "cus_123");

  // Every text column on the row, checked for a run of 12 or more digits: a PAN would show up here.
  for (const [column, value] of Object.entries(row)) {
    if (typeof value !== "string") continue;
    assert.equal(/\d{12,}/.test(value), false, `${column} looks like it holds a card number`);
  }

  closeDb();
});

test("a card cannot be attached without a customer reference", () => {
  const { db, orgId } = workspace();
  beginCardTrial(db, orgId, "professional");

  const result = attachPaymentMethod(db, orgId, { customerId: "" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no_customer");
  assert.equal(entitlementFor(db, orgId, "contacts").granted, false, "a failed attach must not grant access");

  closeDb();
});

test("attaching twice updates one subscription rather than creating a second", () => {
  const { db, orgId } = workspace();
  beginCardTrial(db, orgId, "professional");
  attachPaymentMethod(db, orgId, { customerId: "cus_123", brand: "visa", last4: "4242" });
  attachPaymentMethod(db, orgId, { customerId: "cus_123", brand: "visa", last4: "1111" });

  assert.equal(db.prepare("select count(*) as n from subscriptions where organization_id = ?").get(orgId).n, 1);
  assert.equal(
    db.prepare("select payment_method_last4 from subscriptions where organization_id = ?").get(orgId).payment_method_last4,
    "1111",
    "the newest card wins",
  );

  closeDb();
});

test("when the seven days run out, access stops until the charge succeeds", () => {
  const { db, orgId } = workspace();
  beginCardTrial(db, orgId, "professional");
  attachPaymentMethod(db, orgId, { customerId: "cus_123", brand: "visa", last4: "4242" });

  // Eight days later, nothing has been charged yet.
  const later = Date.now() + 8 * DAY;
  const subscription = db.prepare("select * from subscriptions where organization_id = ?").get(orgId);
  assert.equal(isPaying(subscription, later), false, "an expired trial is not a paying customer");

  syncEntitlements(db, orgId, "professional", {
    now: later,
    status: "trialing",
    trialEnd: subscription.trial_end,
  });
  assert.equal(entitlementFor(db, orgId, "contacts").granted, false);

  closeDb();
});

test("the first successful charge converts the trial into a paid period", () => {
  const { db, orgId } = workspace();
  beginCardTrial(db, orgId, "professional");
  attachPaymentMethod(db, orgId, { customerId: "cus_123", brand: "visa", last4: "4242" });

  // The provider's subscription id, so the webhook can find the row.
  db.prepare("update subscriptions set provider_id = ? where organization_id = ?").run("sub_abc", orgId);

  const periodEnd = new Date(Date.now() + 30 * DAY).toISOString();
  const applied = applyEvent(db, {
    provider: "sandbox",
    eventId: "evt_first_charge",
    type: "payment.succeeded",
    data: { providerSubscriptionId: "sub_abc", periodEnd, planId: "professional" },
  });

  assert.equal(applied.applied, true);
  assert.equal(applied.status, "active");

  const row = db.prepare("select * from subscriptions where organization_id = ?").get(orgId);
  assert.equal(row.status, "active");
  assert.equal(isPaying(row), true);
  assert.equal(entitlementFor(db, orgId, "contacts").granted, true);

  closeDb();
});

test("the trial is recorded in the audit trail at both steps", () => {
  const { db, orgId } = workspace();
  beginCardTrial(db, orgId, "professional");
  attachPaymentMethod(db, orgId, { customerId: "cus_123", brand: "visa", last4: "4242" });

  const actions = listAudit(db, orgId).map((r) => r.action);
  assert.ok(actions.includes("billing.trial_awaiting_card"));
  assert.ok(actions.includes("billing.card_attached"));

  closeDb();
});

test("an unknown plan is refused before a subscription exists", () => {
  const { db, orgId } = workspace();
  assert.throws(() => beginCardTrial(db, orgId, "plan-that-does-not-exist"), /Unknown plan/);
  assert.equal(db.prepare("select count(*) as n from subscriptions where organization_id = ?").get(orgId).n, 0);
  closeDb();
});
