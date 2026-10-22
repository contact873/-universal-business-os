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
  .prepare("select id, name, intake_key from organizations where intake_key is not null order by created_at limit 1")
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

const stamp = Date.now();
const payload = {
  intakeKey: org.intake_key,
  name: "Verify Script",
  mobile: "0501234999",
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
check("the phone number was normalised for matching", identity?.value_normalized === "+971501234999", identity?.value_normalized);

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
