import "./setup.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { openTestDb, closeDb } from "../src/lib/db.mjs";
import { seedPlans } from "./fixtures.mjs";
import { createUser, createOrganization, updateOrganization } from "../src/lib/accounts.mjs";

function workspace() {
  const db = seedPlans(openTestDb());
  const owner = createUser(db, { email: "owner@alpha.test", password: "a-long-enough-password" });
  const org = createOrganization(db, { name: "Alpha Clinic", ownerUserId: owner.userId, plan: "free" });
  return { db, orgId: org.orgId, ownerId: owner.userId };
}

const read = (db, orgId) => db.prepare("select name, industry, timezone from organizations where id = ?").get(orgId);

test("the workspace name, industry and timezone can be changed", () => {
  const { db, orgId } = workspace();
  assert.equal(read(db, orgId).timezone, "UTC", "new workspaces start on UTC");

  const result = updateOrganization(db, orgId, { name: "Relco Digital", industry: "consulting", timezone: "Asia/Karachi" });
  assert.equal(result.ok, true);

  const after = read(db, orgId);
  assert.equal(after.name, "Relco Digital");
  assert.equal(after.industry, "consulting");
  assert.equal(after.timezone, "Asia/Karachi");

  closeDb();
});

test("a timezone the system cannot parse is refused, rather than stored", () => {
  const { db, orgId } = workspace();

  // A timezone that Intl rejects would break every booking the workspace makes, so it never lands.
  const refused = updateOrganization(db, orgId, { timezone: "Asia/Karachi-ish" });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "bad_timezone");
  assert.equal(read(db, orgId).timezone, "UTC");

  assert.equal(updateOrganization(db, orgId, { timezone: "" }).reason, "bad_timezone");

  closeDb();
});

test("a workspace name that is too short or too long is refused", () => {
  const { db, orgId } = workspace();

  assert.equal(updateOrganization(db, orgId, { name: "A" }).reason, "bad_name");
  assert.equal(updateOrganization(db, orgId, { name: "   " }).reason, "bad_name");
  assert.equal(updateOrganization(db, orgId, { name: "x".repeat(81) }).reason, "bad_name");
  assert.equal(read(db, orgId).name, "Alpha Clinic");

  closeDb();
});

test("a change is recorded, and an empty change writes nothing", () => {
  const { db, orgId } = workspace();

  assert.equal(updateOrganization(db, orgId, {}).changed, false);
  assert.equal(db.prepare("select count(*) as n from audit_logs where action = ?").get("org.updated").n, 0);

  updateOrganization(db, orgId, { industry: "retail" });
  const entries = db.prepare("select meta_json from audit_logs where action = ?").all("org.updated");
  assert.equal(entries.length, 1);
  assert.match(String(entries[0].meta_json), /retail/);

  closeDb();
});
