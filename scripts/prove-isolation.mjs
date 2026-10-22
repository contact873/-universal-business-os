#!/usr/bin/env node
// Prove, over HTTP, that one signed in business cannot see another's records.
//
//   npm run start -- -p 3210          (in one terminal, with SESSION_SECRET set)
//   SESSION_SECRET=same-value node scripts/prove-isolation.mjs
//
// The sessions are minted with the application's own session module and written to the same
// database the server reads, so nothing is bypassed: this is the exact cookie a signed in owner
// would hold. Each workspace is then requested with its own session, and the page is searched for
// a contact name that exists only in the other workspace. That name must not appear.

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR, SESSION_COOKIE } from "../src/lib/config.mjs";
import { createSession } from "../src/lib/sessions.mjs";

const baseArg = process.argv.indexOf("--base");
const BASE = baseArg > -1 ? process.argv[baseArg + 1] : "http://127.0.0.1:3210";

const dbFile = path.join(DATA_DIR, "ubos.db");
if (!fs.existsSync(dbFile)) {
  console.error(`  No database at ${dbFile}. Run: npm run migrate && npm run seed`);
  process.exit(1);
}

const db = new Database(dbFile);

let passed = 0;
let failed = 0;
const check = (label, condition, detail = "") => {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` (${detail})` : ""}`);
  }
};

const workspaces = db
  .prepare(
    `select o.id, o.name, u.id as userId, u.email
       from organizations o
       join memberships m on m.organization_id = o.id and m.role = 'owner'
       join users u on u.id = m.user_id
      order by o.created_at`,
  )
  .all();

if (workspaces.length < 2) {
  console.error("  Need at least two seeded workspaces with an owner each. Run: npm run seed");
  process.exit(1);
}

// A name that occurs in one workspace and nowhere else, so the page content itself is the evidence.
function uniqueNames(orgId) {
  return db
    .prepare(
      `select name from contacts
        where organization_id = ? and name is not null
          and name not in (select name from contacts where organization_id <> ? and name is not null)`,
    )
    .all(orgId, orgId)
    .map((r) => r.name);
}

async function fetchWorkspace(token, pathname = "/app") {
  const response = await fetch(`${BASE}${pathname}`, {
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
    redirect: "manual",
  });
  return { status: response.status, html: await response.text() };
}

console.log(`\n  base       ${BASE}`);
console.log(`  workspaces ${workspaces.map((w) => w.name).join(" and ")}\n`);

for (const workspace of workspaces) {
  const { token } = createSession(db, { userId: workspace.userId, orgId: workspace.id });

  // Two surfaces are checked. The dashboard shows only the ten most recent enquiries, which a
  // busy workspace can fill many times over, so the contact list is the honest place to ask
  // "can this workspace see this person".
  const dashboard = await fetchWorkspace(token, "/app");
  const contactList = await fetchWorkspace(token, "/app/contacts");

  check(`${workspace.name}: the owner reaches their dashboard`, dashboard.status === 200, `status ${dashboard.status}`);
  check(`${workspace.name}: the owner reaches their contact list`, contactList.status === 200, `status ${contactList.status}`);

  const mine = uniqueNames(workspace.id);
  check(`${workspace.name}: has a contact name unique to it`, mine.length > 0, "seed data has no unique names");

  for (const name of mine) {
    check(`${workspace.name}: sees its own contact, ${name}`, contactList.html.includes(name));
  }

  for (const other of workspaces.filter((w) => w.id !== workspace.id)) {
    const theirs = uniqueNames(other.id);
    for (const name of theirs) {
      check(
        `${workspace.name}: does NOT see ${other.name}'s contact, ${name}`,
        !contactList.html.includes(name) && !dashboard.html.includes(name),
        "another workspace's contact name appeared in the page",
      );
    }

    check(
      `${workspace.name}: does not render the name of ${other.name}`,
      !contactList.html.includes(other.name) && !dashboard.html.includes(other.name),
    );
  }
}

/* a session with no workspace must not land on a dashboard ------------------ */

const orphan = db
  .prepare("select id from users where id not in (select user_id from memberships) limit 1")
  .get();

if (orphan) {
  const { token } = createSession(db, { userId: orphan.id, orgId: null });
  const page = await fetchWorkspace(token);
  check(
    "a session with no workspace is redirected rather than shown a dashboard",
    page.status >= 300 && page.status < 400,
    `status ${page.status}`,
  );
}

const victim = workspaces[0];
const minted = createSession(db, { userId: victim.userId, orgId: victim.id });
db.prepare("update sessions set revoked_at = ? where id = ?").run(
  new Date().toISOString(),
  minted.sessionId,
);
const afterRevoke = await fetchWorkspace(minted.token);
check(
  "a revoked session is refused even though its signature is still valid",
  afterRevoke.status >= 300 && afterRevoke.status < 400 || afterRevoke.status === 401,
  `status ${afterRevoke.status}`,
);

console.log(`\n  ${passed} passed, ${failed} failed\n`);
db.close();
process.exit(failed ? 1 : 0);
