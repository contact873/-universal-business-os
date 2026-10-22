#!/usr/bin/env node
// Creates the first platform administrator on a fresh deployment.
//
// Deliberately not part of `npm run seed`, because seeding also creates two demo workspaces with a
// published password. On a real deployment you want an account you control and nothing else.
//
//   node scripts/create-admin.mjs --email=you@example.com --password='...' --name='Your Name'
//
// Refuses to run against a database that already has users unless --force is passed, so it cannot
// quietly add an administrator to a live system.

import { getDb } from "../src/lib/db.mjs";
import { createUser, createOrganization } from "../src/lib/accounts.mjs";
import { writeAudit } from "../src/lib/audit.mjs";
import { IS_PRODUCTION } from "../src/lib/config.mjs";
import { ensurePlans } from "../src/lib/plans.mjs";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [key, ...rest] = a.replace(/^--/, "").split("=");
      return [key, rest.join("=") || true];
    }),
);

const email = String(args.email ?? "").trim();
const password = String(args.password ?? "");
const name = String(args.name ?? "").trim() || null;

if (!email || !password) {
  console.error(`
  Usage:
    node scripts/create-admin.mjs --email=you@example.com --password='at least 10 characters'

  Optional:
    --name='Your Name'    shown in the interface
    --force               add an administrator even though users already exist
`);
  process.exit(2);
}

if (password.length < 10) {
  console.error("  The password must be at least 10 characters.");
  process.exit(2);
}

// The schema is applied by Fly's release command before this script can be reached over ssh, so
// there is nothing to migrate here. If it is missing anyway, getDb() says so in plain words rather
// than failing halfway through creating a user.
const db = getDb();

// A workspace has to start on a plan, so the catalogue must exist even though this script never
// creates demo data. Idempotent, so running it twice is harmless.
ensurePlans(db);

const existingUsers = db.prepare("select count(*) as n from users").get().n;
if (existingUsers > 0 && !args.force) {
  console.error(`  This database already has ${existingUsers} user(s).`);
  console.error("  Refusing to add an administrator. Pass --force if that is really what you want.");
  process.exit(1);
}

const emailTaken = db.prepare("select id from users where email = ?").get(email.toLowerCase());
if (emailTaken) {
  console.error(`  ${email} already exists.`);
  process.exit(1);
}

const { userId } = createUser(db, { email, password, name, platformAdmin: true });

// A workspace, so the administrator lands somewhere useful rather than an empty state. The name
// is theirs to change; this is only a starting point.
const company = String(args.company ?? "").trim() || "My workspace";
const { orgId, slug } = createOrganization(db, {
  name: company,
  ownerUserId: userId,
  industry: String(args.industry ?? "").trim() || null,
  plan: "professional",
});

writeAudit(db, {
  orgId,
  actorUserId: userId,
  action: "platform.admin_created",
  entity: "user",
  entityId: userId,
  meta: { email: email.toLowerCase(), via: "create-admin script" },
});

console.log(`
  Administrator created
    email      ${email.toLowerCase()}
    user id    ${userId}
    workspace  ${company} (${slug})
    org id     ${orgId}
    plan       Professional, on trial

  Sign in at ${IS_PRODUCTION ? "your APP_URL" : "http://127.0.0.1:3000"}/login

  The password is only stored as a scrypt hash. If you lose it, there is no reset flow yet:
  create another administrator with --force, or delete the row and start again.
`);

db.close();
