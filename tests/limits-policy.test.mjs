import "./setup.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { openTestDb, closeDb } from "../src/lib/db.mjs";
import { seedPlans } from "./fixtures.mjs";
import { createFreeAccount } from "../src/lib/onboarding.mjs";
import { withinLimit, recordUsage, usageThisPeriod, periodStart } from "../src/lib/billing.mjs";

const DAY = 86_400_000;

async function freeWorkspace() {
  const db = seedPlans(openTestDb());
  const { orgId } = await createFreeAccount(
    db,
    { email: "limits@example.test", password: "a-long-enough-password", company: "Limits Clinic" },
    { sendEmail: null },
  );
  return { db, orgId };
}

test("the free plan does not expire, so nothing is lost by not using it", async () => {
  const { db, orgId } = await freeWorkspace();
  const subscription = db.prepare("select * from subscriptions where organization_id = ?").get(orgId);

  assert.equal(subscription.period_end, null);
  assert.equal(subscription.trial_end, null);
  assert.equal(subscription.status, "active");

  // A year from now the workspace is still entitled. Time is not the limit.
  assert.equal(withinLimit(db, orgId, "contacts", { now: Date.now() + 365 * DAY }).allowed, true);

  closeDb();
});

test("an SMS allowance is metered, and the last one is the limit", async () => {
  const { db, orgId } = await freeWorkspace();
  const limit = withinLimit(db, orgId, "sms-messages").limit;
  assert.equal(limit, 100, "the free plan states 100 SMS a month");

  recordUsage(db, orgId, "sms-messages", limit - 1);
  assert.equal(withinLimit(db, orgId, "sms-messages").current, limit - 1);
  assert.equal(withinLimit(db, orgId, "sms-messages").allowed, true);

  recordUsage(db, orgId, "sms-messages");
  const spent = withinLimit(db, orgId, "sms-messages");
  assert.equal(spent.allowed, false);
  assert.equal(spent.reason, "limit_reached");
  assert.equal(spent.resets, true, "the interface must know this one resets, or it offers a reset that never comes");

  closeDb();
});

test("last month's usage does not eat this month's allowance", async () => {
  const { db, orgId } = await freeWorkspace();
  const now = Date.parse("2026-03-15T10:00:00.000Z");

  recordUsage(db, orgId, "sms-messages", 100, { now: Date.parse("2026-02-10T10:00:00.000Z") });
  recordUsage(db, orgId, "sms-messages", 100, { now: Date.parse("2026-02-28T23:59:00.000Z") });

  const march = withinLimit(db, orgId, "sms-messages", { now });
  assert.equal(march.current, 0, "February does not carry into March");
  assert.equal(march.allowed, true);

  recordUsage(db, orgId, "sms-messages", 100, { now });
  assert.equal(withinLimit(db, orgId, "sms-messages", { now }).allowed, false, "March has now spent its own hundred");

  closeDb();
});

test("the allowance window starts on the first of the month, in UTC", () => {
  assert.equal(periodStart(Date.parse("2026-03-15T10:00:00.000Z")), "2026-03-01T00:00:00.000Z");
  assert.equal(periodStart(Date.parse("2026-03-01T00:00:00.000Z")), "2026-03-01T00:00:00.000Z");
  assert.equal(
    periodStart(Date.parse("2026-03-01T00:00:00.000Z") - 1),
    "2026-02-01T00:00:00.000Z",
    "a millisecond before the first belongs to the previous month",
  );
});

test("usage is summed, not counted, so one call of four minutes costs four", async () => {
  const { db, orgId } = await freeWorkspace();

  db.prepare("delete from entitlements where organization_id = ? and feature = 'assistant-minutes'").run(orgId);
  db.prepare("insert into entitlements (id, organization_id, feature, limit_value, created_at) values (?, ?, 'assistant-minutes', 10, ?)").run(
    "ent_test",
    orgId,
    new Date().toISOString(),
  );

  recordUsage(db, orgId, "assistant-minutes", 4);
  recordUsage(db, orgId, "assistant-minutes", 6);

  const result = withinLimit(db, orgId, "assistant-minutes");
  assert.equal(result.current, 10);
  assert.equal(result.allowed, false);

  const summary = usageThisPeriod(db, orgId);
  assert.equal(summary.used["assistant-minutes"], 10);

  closeDb();
});

test("usage must be a positive whole number, so a negative entry cannot refill an allowance", async () => {
  const { db, orgId } = await freeWorkspace();

  assert.throws(() => recordUsage(db, orgId, "sms-messages", -50), /positive whole number/);
  assert.throws(() => recordUsage(db, orgId, "sms-messages", 0), /positive whole number/);
  assert.throws(() => recordUsage(db, orgId, "sms-messages", 1.5), /positive whole number/);

  assert.equal(withinLimit(db, orgId, "sms-messages").current, 0);

  closeDb();
});

test("a full address book still blocks the next contact in a new month", async () => {
  const { db, orgId } = await freeWorkspace();
  const limit = withinLimit(db, orgId, "contacts").limit;

  for (let i = 0; i < limit; i += 1) {
    db.prepare(
      "insert into contacts (id, organization_id, name, source, first_seen_at, last_seen_at) values (?, ?, ?, 'test', ?, ?)",
    ).run(`con_${i}`, orgId, `Contact ${i}`, new Date().toISOString(), new Date().toISOString());
  }

  const nextMonth = Date.now() + 40 * DAY;
  const atCeiling = withinLimit(db, orgId, "contacts", { now: nextMonth });
  assert.equal(atCeiling.allowed, false, "a standing count is not a monthly allowance");
  assert.equal(atCeiling.resets, false);
  assert.equal(atCeiling.current, limit);

  // And the existing data is still there. Limits never delete a customer's records.
  assert.equal(db.prepare("select count(*) as n from contacts where organization_id = ?").get(orgId).n, limit);

  closeDb();
});
