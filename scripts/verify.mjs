#!/usr/bin/env node
// End to end verification against a running server.
//
//   npm run start -- -p 3210        (in one terminal)
//   node scripts/verify.mjs         (in another)
//   node scripts/verify.mjs --base http://127.0.0.1:3210
//
// What this proves: the public surface behaves, the guards are in the right order, and the
// database actually changed when it should have. What it does not cover is the signed-in
// workspace screens, because those are reached through server actions rather than a URL; the
// isolation of signed-in users is proven by tests/isolation.test.mjs against the same code those
// actions call. Both are run by `npm run verify:all` so neither can be quietly skipped.

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../src/lib/config.mjs";

const baseArg = process.argv.indexOf("--base");
const BASE = baseArg > -1 ? process.argv[baseArg + 1] : "http://127.0.0.1:3210";

const dbFile = path.join(DATA_DIR, "ubos.db");
if (!fs.existsSync(dbFile)) {
  console.error(`  No database at ${dbFile}. Run: npm run migrate && npm run seed`);
  process.exit(1);
}
const db = new Database(dbFile, { readonly: true });

let passed = 0;
let failed = 0;

function check(label, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` (${detail})` : ""}`);
  }
}

function noteWebhookSkip() {
  console.log("  skip  billing webhook checks: set BILLING_WEBHOOK_SECRET on the server and here");
}

async function post(payload, contentType = "application/json") {
  const response = await fetch(`${BASE}/api/enquiries`, {
    method: "POST",
    headers: { "content-type": contentType },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
    redirect: "manual",
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

const org = db
  .prepare(
    "select id, name, intake_key, default_country from organizations where intake_key is not null order by created_at limit 1",
  )
  .get();

if (!org) {
  console.error("  No workspace with an intake key. Run: npm run seed");
  process.exit(1);
}

const countContacts = () =>
  db.prepare("select count(*) as n from contacts where organization_id = ?").get(org.id).n;

console.log(`\n  base   ${BASE}`);
console.log(`  tenant ${org.name} (${org.id})\n`);

/* reachability ------------------------------------------------------------- */

try {
  const health = await fetch(`${BASE}/api/health`);
  const body = await health.json();
  check("health endpoint answers", health.status === 200);
  check("health reports the database reachable", body.database === "reachable");
} catch (error) {
  console.error(`\n  Cannot reach ${BASE}. Start the server first.\n`);
  process.exit(1);
}

/* the working path --------------------------------------------------------- */

// The check at the end of this file deliberately exhausts the rate limit window, which means a
// second run started within the same minute would be refused before it tested anything. Waiting
// here is what makes the script repeatable rather than a one-shot.
async function waitForRateWindow() {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const probe = await fetch(`${BASE}/api/enquiries`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (probe.status !== 429) return;
    if (attempt === 0) console.log("  note  waiting for the previous run's rate limit window to clear");
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

await waitForRateWindow();

const stamp = Date.now();
// A unique mobile number per run. Reusing one made this script pass only against a fresh
// database: the second run matched the contact the first run created and then failed its own
// "a contact was created" assertion, which says nothing about the application.
const runDigits = String(stamp).slice(-7);
const mobile = `050${runDigits}`;
const expectedPhone = `${org.default_country ?? "+971"}${mobile.slice(1)}`;

const payload = {
  intakeKey: org.intake_key,
  name: "Verify Script",
  mobile,
  message: `verification run ${stamp}`,
  source: "verify",
  tags: ["verification"],
};

const before = countContacts();
const first = await post(payload);

check("a valid enquiry is accepted", first.status === 200, `status ${first.status}`);
check("and stored", first.body?.data?.stored === true);
check("and is not marked as a replay", first.body?.data?.replayed === false);
check("the contact was actually created", countContacts() === before + 1, `${before} then ${countContacts()}`);

const identity = db
  .prepare(
    "select value_normalized from contact_identities where organization_id = ? and kind = 'phone' order by first_seen_at desc limit 1",
  )
  .get(org.id);
check(
  "the phone number was normalised for matching",
  identity?.value_normalized === expectedPhone,
  `${identity?.value_normalized} (expected ${expectedPhone})`,
);

/* idempotency -------------------------------------------------------------- */

const second = await post(payload);
check("the identical submission is collapsed as a replay", second.body?.data?.replayed === true);
check("and did not create a second contact", countContacts() === before + 1);

const third = await post({ ...payload, message: `a genuinely different enquiry ${stamp}` });
check("a different message in the same minute is kept", third.body?.data?.replayed === false);
check("and did create the expected extra contact", countContacts() === before + 1, "same phone, so same contact");

/* refusal paths ------------------------------------------------------------ */

const unknown = await post({ ...payload, intakeKey: "ubos_not_a_real_key" });
check("an unknown intake key is refused", unknown.status === 404, `status ${unknown.status}`);

const noIdentity = await post({ intakeKey: org.intake_key, message: "no way to reply" });
check("an enquiry with no identity is refused", noIdentity.status === 400, `status ${noIdentity.status}`);

const missing = await post({ message: "no key at all" });
check("a missing intake key is refused", missing.status === 400, `status ${missing.status}`);

const wrongType = await post("intakeKey=x", "text/plain");
check(
  "a non-JSON body is refused before it is parsed",
  wrongType.status === 415 || wrongType.status === 400,
  `status ${wrongType.status}`,
);

const tooBig = await post({
  intakeKey: org.intake_key,
  email: "big@example.com",
  message: "z".repeat(40000),
});
check("an oversized body is refused", tooBig.status >= 400, `status ${tooBig.status}`);

const unknownField = await post({ ...payload, role: "owner" });
check("an unknown field is refused rather than ignored", unknownField.status === 400, `status ${unknownField.status}`);

/* honeypot ---------------------------------------------------------------- */

const beforeTrap = countContacts();
const trapped = await post({ ...payload, message: "bot", website: "http://spam.example" });
check("a filled honeypot is answered as though it worked", trapped.body?.data?.stored === true);
check("but nothing is written", countContacts() === beforeTrap);

/* authentication ---------------------------------------------------------- */

const appPage = await fetch(`${BASE}/app`, { redirect: "manual" });
check("the workspace is not reachable without a session", appPage.status >= 300 && appPage.status < 400, `status ${appPage.status}`);
check("and it redirects to the sign in page", String(appPage.headers.get("location") ?? "").includes("/login"), appPage.headers.get("location") ?? "no location");

const adminPage = await fetch(`${BASE}/admin`, { redirect: "manual" });
check("platform administration is not reachable without a session", adminPage.status >= 300 && adminPage.status < 400, `status ${adminPage.status}`);

const bookingsPage = await fetch(`${BASE}/app/bookings`, { redirect: "manual" });
check("the diary is not reachable without a session", bookingsPage.status >= 300 && bookingsPage.status < 400, `status ${bookingsPage.status}`);

/* billing webhooks --------------------------------------------------------- */

// This is the path that decides whether somebody is paying, so it is exercised over HTTP rather
// than only in unit tests. The server must be started with BILLING_WEBHOOK_SECRET set.
const WEBHOOK_SECRET = process.env.BILLING_WEBHOOK_SECRET ?? "";

if (!WEBHOOK_SECRET) {
  noteWebhookSkip();
} else {
  const { createHmac } = await import("node:crypto");

  const signed = (payload) => {
    const body = JSON.stringify(payload);
    return {
      body,
      headers: {
        "content-type": "application/json",
        "x-billing-signature": `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`,
      },
    };
  };

  const hook = async (payload, { goodSignature = true } = {}) => {
    const prepared = signed(payload);
    const response = await fetch(`${BASE}/api/webhooks/billing`, {
      method: "POST",
      headers: goodSignature
        ? prepared.headers
        : { "content-type": "application/json", "x-billing-signature": "sha256=deadbeef" },
      body: prepared.body,
    });
    let parsed = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    return { status: response.status, body: parsed };
  };

  const unsigned = await fetch(`${BASE}/api/webhooks/billing`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "subscription.updated", eventId: "evt_unsigned" }),
  });
  check("an unsigned webhook is refused", unsigned.status === 401, `status ${unsigned.status}`);

  const tampered = await hook({ type: "subscription.updated", eventId: "evt_tampered" }, { goodSignature: false });
  check("a webhook with a wrong signature is refused", tampered.status === 401, `status ${tampered.status}`);

  // A pending subscription, exactly as a checkout leaves behind, so the webhook has something real
  // to attach to.
  const writeable = new Database(dbFile);
  const reference = `verify_${Date.now().toString(36)}`;
  writeable
    .prepare(
      `insert into subscriptions (id, organization_id, provider, provider_id, status, plan_id, trial_end, period_end, created_at)
       values (?, ?, null, ?, 'incomplete', 'starter', null, null, ?)`,
    )
    .run(`sub_verify_${Date.now().toString(36)}`, org.id, reference, new Date().toISOString());

  const eventId = `evt_verify_${Date.now().toString(36)}`;
  const activation = {
    eventId,
    type: "subscription.updated",
    data: {
      providerSubscriptionId: reference,
      status: "active",
      planId: "starter",
      periodEnd: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    },
  };

  const applied = await hook(activation);
  check("a correctly signed webhook is accepted", applied.status === 200, `status ${applied.status}`);
  check("and the subscription is activated", applied.body?.applied === true, JSON.stringify(applied.body));

  const status = writeable
    .prepare("select status, plan_id from subscriptions where provider_id = ?")
    .get(reference);
  const entitlements = writeable
    .prepare("select count(*) as n from entitlements where organization_id = ?")
    .get(org.id).n;
  check("the subscription is now active on the plan that was bought", status?.status === "active" && status?.plan_id === "starter", JSON.stringify(status));
  check("and the plan's entitlements were granted", entitlements > 0, `${entitlements} entitlement row(s)`);

  const replayed = await hook(activation);
  check("the same event delivered twice applies once", replayed.body?.applied === false && replayed.body?.reason === "duplicate", JSON.stringify(replayed.body));

  const unknown = await hook({
    eventId: `evt_ghost_${Date.now().toString(36)}`,
    type: "subscription.updated",
    data: { providerSubscriptionId: "sub_that_does_not_exist", status: "active", planId: "professional" },
  });
  check("an event about an unknown subscription changes nothing", unknown.body?.applied === false && unknown.body?.reason === "unknown_subscription", JSON.stringify(unknown.body));

  const checkout = await fetch(`${BASE}/api/billing/checkout`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ planId: "starter" }),
  });
  check("checkout refuses an anonymous caller", checkout.status === 401, `status ${checkout.status}`);

  writeable.close();
}

/* rate limiting, run last because it deliberately exhausts the allowance ----- */

// The identical payload on purpose: the rate limiter counts requests, not writes, so this
// exhausts the allowance without leaving thirty junk leads behind in the demo workspace.
let sawRateLimit = false;
let rateLimitStatus = 0;
for (let i = 0; i < 40; i += 1) {
  const response = await post(payload);
  if (response.status === 429) {
    sawRateLimit = true;
    rateLimitStatus = 429;
    break;
  }
}
check("a flood from one address is rate limited", sawRateLimit, `last status ${rateLimitStatus || "never limited"}`);

/* report ------------------------------------------------------------------ */

console.log(`\n  ${passed} passed, ${failed} failed\n`);
db.close();
process.exit(failed ? 1 : 0);
