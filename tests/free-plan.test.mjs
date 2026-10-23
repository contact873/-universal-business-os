import "./setup.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { openTestDb, closeDb } from "../src/lib/db.mjs";
import { seedPlans } from "./fixtures.mjs";
import { entitlementFor, membershipsFor, startFreePlan } from "../src/lib/accounts.mjs";
import { createFreeAccount, startSignupAccount } from "../src/lib/onboarding.mjs";
import { isPaying, withinLimit, syncEntitlements } from "../src/lib/billing.mjs";
import { PLAN_DEFINITIONS } from "../src/lib/plans.mjs";

const FREE = {
  email: "free@example.test",
  password: "a-long-enough-password",
  company: "Free Clinic",
  industry: "med-spa",
};

const freeLimits = PLAN_DEFINITIONS.find((p) => p.id === "free").limits;

test("the free plan exists in the catalogue, costs nothing, and never expires", () => {
  const plan = PLAN_DEFINITIONS.find((p) => p.id === "free");
  assert.ok(plan, "a free plan must exist");
  assert.equal(plan.priceMinor, 0);
  assert.equal(plan.setupMinor, 0);
  assert.equal(plan.interval, "month");
  assert.ok(plan.limits.contacts > 0, "a free plan with no contacts is a banner, not a product");
  assert.equal(plan.limits["assistant-minutes"], 0, "the assistant is what PRO is for");
});

test("signing up on the free plan creates a usable workspace with no card", async () => {
  const db = seedPlans(openTestDb());
  const result = await createFreeAccount(db, FREE, { sendEmail: null });

  assert.equal(result.ok, true);
  assert.equal(result.plan, "free");
  assert.equal(result.needsCard, false, "free means no card, which means no chargeback risk");

  const subscription = db.prepare("select * from subscriptions where organization_id = ?").get(result.orgId);
  assert.equal(subscription.plan_id, "free");
  assert.equal(subscription.status, "active");
  assert.equal(subscription.period_end, null, "no period end: it does not expire");
  assert.equal(subscription.payment_method_last4, null, "no card stored");

  assert.equal(isPaying(subscription), true, "active with no period end is valid indefinitely");
  assert.equal(entitlementFor(db, result.orgId, "contacts").granted, true);
  assert.deepEqual(membershipsFor(db, result.userId).map((m) => m.role), ["owner"]);

  closeDb();
});

test("a free workspace is refused work beyond its contact allowance", async () => {
  const db = seedPlans(openTestDb());
  const { orgId } = await createFreeAccount(db, FREE, { sendEmail: null });

  const limit = freeLimits.contacts;
  assert.equal(entitlementFor(db, orgId, "contacts").limit, limit);

  assert.equal(withinLimit(db, orgId, "contacts", { current: limit - 1 }).allowed, true);
  assert.equal(withinLimit(db, orgId, "contacts", { current: limit }).allowed, false);
  assert.equal(withinLimit(db, orgId, "contacts", { current: limit }).reason, "limit_reached");

  // The assistant is not part of free at all.
  assert.equal(withinLimit(db, orgId, "assistant-minutes", { current: 0 }).allowed, false);

  closeDb();
});

test("a free workspace is limited to one seat", async () => {
  const db = seedPlans(openTestDb());
  const { orgId } = await createFreeAccount(db, FREE, { sendEmail: null });

  assert.equal(withinLimit(db, orgId, "seats", { current: 0 }).allowed, true);
  assert.equal(withinLimit(db, orgId, "seats", { current: 1 }).allowed, false);

  closeDb();
});

test("upgrading replaces the free plan rather than stacking a second subscription", () => {
  const db = seedPlans(openTestDb());
  const orgId = "org_synthetic";
  db.prepare(
    "insert into organizations (id, name, slug, industry, timezone, intake_key, created_at) values (?, ?, ?, ?, ?, ?, ?)",
  ).run(orgId, "Upgrade Clinic", "upgrade-clinic", "med-spa", "UTC", "ubos_test", new Date().toISOString());

  startFreePlan(db, orgId);

  // The upgrade path the provider will drive: activate Professional and let the sync move the
  // entitlements from 100 contacts to 5,000, and from one seat to ten.
  db.prepare(
    "update subscriptions set status = 'active', plan_id = 'professional', period_end = ? where organization_id = ?",
  ).run(new Date(Date.now() + 30 * 86_400_000).toISOString(), orgId);

  syncEntitlements(db, orgId, "professional", {
    status: "active",
    periodEnd: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  });

  assert.equal(entitlementFor(db, orgId, "contacts").limit, 5000);
  assert.equal(withinLimit(db, orgId, "assistant-minutes", { current: 0 }).allowed, true);

  const subscriptions = db.prepare("select count(*) as n from subscriptions where organization_id = ?").get(orgId).n;
  assert.equal(subscriptions, 1, "one subscription, moved forward; not a second one beside it");

  closeDb();
});

test("a duplicated free sign-up does not create a second workspace", async () => {
  const db = seedPlans(openTestDb());
  const first = await createFreeAccount(db, FREE, { sendEmail: null });
  const second = await createFreeAccount(db, FREE, { sendEmail: null });

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.reason, "email_taken");
  assert.equal(db.prepare("select count(*) as n from organizations").get().n, 1);

  closeDb();
});

test("both doors to sign-up give the same workspace", async () => {
  const db = seedPlans(openTestDb());
  const person = (email, company) => ({ email, password: "a-long-enough-password", company });

  // The marketing site's form and the application's own /signup page. They drifted once: the page
  // hardcoded the paid Starter plan and never wrote to the subscriber registry, so where somebody
  // signed up decided both their plan and whether they appeared in the customer list.
  const viaSite = await startSignupAccount(db, person("site@example.test", "Site Clinic"), { sendEmail: null, mode: "free" });
  const viaApp = await startSignupAccount(db, person("app@example.test", "App Clinic"), { sendEmail: null, mode: "free" });

  for (const result of [viaSite, viaApp]) {
    assert.equal(result.ok, true);
    assert.equal(result.plan, "free", "a sign-up must land on the free plan, not a paid tier");
    assert.ok(result.subscriberId, "every sign-up must appear in the subscriber registry");
    assert.equal(result.needsCard, false);
  }

  const plans = db.prepare("select distinct plan_id from subscriptions").all().map((row) => row.plan_id);
  assert.deepEqual(plans, ["free"], `no sign-up may quietly create a paid plan, found ${plans.join(", ")}`);
  assert.equal(db.prepare("select count(*) as n from subscribers").get().n, 2);

  closeDb();
});
