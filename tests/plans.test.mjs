import "./setup.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { openTestDb, closeDb } from "../src/lib/db.mjs";
import { PLAN_DEFINITIONS, ensurePlans, planForDisplay } from "../src/lib/plans.mjs";

test("every plan quotes a monthly price, a setup fee and a live-in time", () => {
  for (const plan of PLAN_DEFINITIONS) {
    assert.equal(Number.isInteger(plan.priceMinor), true, `${plan.id} needs an integer monthly price`);
    assert.equal(Number.isInteger(plan.setupMinor), true, `${plan.id} needs a setup fee, even if zero`);
    assert.equal(Number.isInteger(plan.liveInDays), true, `${plan.id} needs a live-in time in days`);

    // A free plan is usable immediately, so zero days is correct for it. A paid plan that claims to
    // be live in zero days is a promise nobody can keep.
    if (plan.priceMinor === 0) assert.equal(plan.liveInDays, 0, `${plan.id} is free, so it needs no onboarding time`);
    else assert.ok(plan.liveInDays > 0 && plan.liveInDays <= 30, `${plan.id} live-in time looks implausible`);
  }
});

test("the tiers ascend in price, setup and allowance", () => {
  const byPrice = [...PLAN_DEFINITIONS].sort((a, b) => a.priceMinor - b.priceMinor);

  for (let i = 1; i < byPrice.length; i++) {
    const lower = byPrice[i - 1];
    const higher = byPrice[i];
    assert.ok(higher.priceMinor > lower.priceMinor, "monthly price must ascend");
    assert.ok(higher.setupMinor >= lower.setupMinor, "setup fee must not fall as the tier rises");
    assert.ok(higher.limits.contacts > lower.limits.contacts, "contact allowance must ascend");
    assert.ok(higher.limits.seats >= lower.limits.seats, "seat allowance must not fall");
    assert.ok(
      higher.limits["assistant-minutes"] >= lower.limits["assistant-minutes"],
      "assistant minutes must not fall as the tier rises",
    );
  }
});

test("the entry tier is a narrow wedge, not a disguised discount of the top tier", () => {
  const starter = PLAN_DEFINITIONS.find((p) => p.id === "starter");
  const business = PLAN_DEFINITIONS.find((p) => p.id === "business");

  assert.ok(starter.priceMinor < business.priceMinor / 3, "the wedge must be clearly cheaper");
  assert.equal(starter.limits["assistant-minutes"], 0, "the wedge does not include the assistant");
  assert.ok(business.limits["assistant-minutes"] > 0, "the top tier must include the assistant");
});

test("the catalogue is written to the database with its terms intact", () => {
  const db = openTestDb();
  ensurePlans(db);

  // What can be bought today. Starter is retired, so it is not offered, and free is the entry.
  const rows = planForDisplay(db);
  assert.deepEqual(rows.map((row) => row.id), ["free", "professional", "business"]);
  assert.equal(rows[0].monthly, 0);
  assert.equal(rows[0].setup, 0);
  assert.equal(rows[1].id, "professional", "the paid entry is Professional");
  assert.equal(typeof rows[1].monthly, "number");
  assert.equal(typeof rows[1].setup, "number");
  assert.ok(rows[1].liveInDays >= 1);
  assert.ok(Object.keys(rows[0].limits).length > 0, "limits must survive the JSON round trip");

  // Retired, not erased: an old invoice may name it, so it must still resolve.
  const everyPlan = planForDisplay(db, { includeRetired: true });
  assert.equal(everyPlan.length, PLAN_DEFINITIONS.length);
  assert.equal(everyPlan.some((row) => row.id === "starter" && row.retired), true);

  closeDb();
});

test("re-running the catalogue updates rather than duplicating", () => {
  const db = openTestDb();
  ensurePlans(db);
  const first = db.prepare("select count(*) as n from plans").get().n;
  ensurePlans(db);
  const second = db.prepare("select count(*) as n from plans").get().n;

  assert.equal(first, second, "ensurePlans must be idempotent");
  closeDb();
});

test("a plan without published setup terms stays null rather than becoming zero", () => {
  const db = openTestDb();
  db.prepare(
    `insert into plans (id, name, price_minor, setup_minor, live_in_days, currency, exponent, interval, limits_json)
     values ('custom', 'Custom', 50000, null, null, 'USD', 2, 'month', '{}')`,
  ).run();

  const custom = planForDisplay(db).find((p) => p.id === "custom");
  assert.equal(custom.setup, null, "unpublished must not read as free");
  assert.equal(custom.liveInDays, null);

  closeDb();
});
