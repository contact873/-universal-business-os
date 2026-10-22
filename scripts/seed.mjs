#!/usr/bin/env node
// Seeds plans, a platform admin, and two separate demo workspaces.
//
// Two, deliberately. One workspace cannot demonstrate isolation: the entire claim of the product
// is that business A cannot see business B, and the only way to see that working is to have a B.

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { id, nowIso, normalizeEmail } from "../src/lib/identities.mjs";
import { apply } from "../src/lib/migrate-core.mjs";
import { DATA_DIR, DATABASE_URL, IS_PRODUCTION, PLATFORM_ADMIN_EMAILS } from "../src/lib/config.mjs";
import { createUser, createOrganization, addMember } from "../src/lib/accounts.mjs";
import { createTenantStore } from "../src/lib/tenant.mjs";

const flag = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

if (IS_PRODUCTION && !flag("force")) {
  console.error("  Refusing to seed demo data in production. Pass --force if you really mean it.");
  process.exit(1);
}

const PASSWORD = flag("password") || "demo-password-1234";

const file = DATABASE_URL.startsWith("file:")
  ? DATABASE_URL.slice("file:".length)
  : path.join(DATA_DIR, "ubos.db");
fs.mkdirSync(path.dirname(file), { recursive: true });

const db = new Database(file);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
apply(db, "sqlite", { log: (line) => console.log(line) });

/* plans -------------------------------------------------------------------- */

const PLANS = [
  { id: "starter", name: "Starter", price: 1900, limits: { contacts: 250, seats: 2 } },
  { id: "professional", name: "Professional", price: 4900, limits: { contacts: 2500, seats: 10 } },
  { id: "business", name: "Business AI", price: 9900, limits: { contacts: 25000, seats: 50 } },
];

for (const plan of PLANS) {
  db.prepare(
    `insert into plans (id, name, price_minor, currency, exponent, interval, limits_json)
     values (?, ?, ?, 'USD', 2, 'month', ?)
     on conflict (id) do update set name = excluded.name, price_minor = excluded.price_minor`,
  ).run(plan.id, plan.name, plan.price, JSON.stringify(plan.limits));
}
console.log(`  ${PLANS.length} plans`);

/* users -------------------------------------------------------------------- */

function upsertUser(email, name, platformAdmin = false) {
  const clean = normalizeEmail(email);
  const existing = db.prepare("select id from users where email = ?").get(clean);
  if (existing) return existing.id;
  return createUser(db, { email: clean, password: PASSWORD, name, platformAdmin }).userId;
}

const adminEmail = PLATFORM_ADMIN_EMAILS[0] || "admin@example.test";
const adminId = upsertUser(adminEmail, "Platform Admin", true);

/* two workspaces ----------------------------------------------------------- */

const store = createTenantStore(db);

const WORKSPACES = [
  {
    owner: "owner@demo.test",
    name: "Demo Aesthetics Clinic",
    industry: "med-spa",
    timezone: "Asia/Dubai",
    country: "+971",
    tags: ["clinic-london"],
    people: [
      { name: "Jane Okafor", mobile: "+971501234567", email: "jane.okafor@example.com", message: "Interested in the full front desk. Can we talk this week?" },
      { name: "Ahmed Raza", mobile: "0300 123 4567", message: "Missed two calls this evening. What does it cost?", source: "missed-call" },
      { name: "Layla Haddad", email: "layla@example.com", instagram: "layla.haddad" },
    ],
  },
  {
    owner: "owner2@demo.test",
    name: "Second Business",
    industry: "consulting",
    timezone: "Asia/Karachi",
    country: "+92",
    tags: ["consulting"],
    people: [
      // The same phone number as Jane, in a different workspace. This is the row that would have
      // been impossible before identity uniqueness became per organisation.
      { name: "Jane Okafor", mobile: "+971501234567" },
      { name: "Bilal Khan", email: "bilal@example.com", linkedin: "bilal-khan" },
    ],
  },
];

const summary = [];

for (const spec of WORKSPACES) {
  const ownerId = upsertUser(spec.owner, `${spec.name} Owner`);

  let org = db.prepare("select id from organizations where name = ?").get(spec.name);
  if (!org) {
    const created = createOrganization(db, {
      name: spec.name,
      industry: spec.industry,
      timezone: spec.timezone,
      ownerUserId: ownerId,
      plan: "professional",
      defaultCountry: spec.country,
    });
    org = { id: created.orgId };
  }
  addMember(db, org.id, ownerId, "owner");
  addMember(db, org.id, adminId, "admin");

  for (const person of spec.people) {
    const { message, source, ...identities } = person;
    store.capture(org.id, { ...identities, message }, {
      source: source || "website",
      tags: spec.tags,
      defaultCountry: spec.timezone === "Asia/Karachi" ? "+92" : "+971",
    });
  }

  const stats = store.stats(org.id);
  summary.push({ name: spec.name, owner: spec.owner, orgId: org.id, ...stats });
}

/* report ------------------------------------------------------------------- */

console.log("");
for (const row of summary) {
  console.log(`  ${row.name}`);
  console.log(`    owner    ${row.owner}`);
  console.log(`    org id   ${row.orgId}`);
  console.log(`    contacts ${row.contacts}   leads ${row.leads}`);
  console.log(`    stages   ${row.byStage.map((s) => `${s.stage}=${s.n}`).join(" ")}`);
}

console.log("");
console.log(`  password for every seeded account: ${PASSWORD}`);
console.log(`  platform admin: ${adminEmail}`);
console.log(`  database: ${file}`);
console.log("");
console.log("  Sign in as both owners and confirm each sees only its own rows.");
console.log("");

db.close();
