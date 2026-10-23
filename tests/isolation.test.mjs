import "./setup.mjs";

import { PLAN_DEFINITIONS } from "../src/lib/plans.mjs";
const limitOf = (plan, feature) => PLAN_DEFINITIONS.find((p) => p.id === plan).limits[feature];

import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./fixtures.mjs";
import { closeDb } from "../src/lib/db.mjs";
import { listAudit, writeAudit } from "../src/lib/audit.mjs";
import { can, canEditLead, assertCan, ROLES } from "../src/lib/roles.mjs";
import { membershipsFor, entitlementFor, startTrial, createOrganization } from "../src/lib/accounts.mjs";

// This file is the isolated claim the product rests on. If any assertion here fails, the platform
// cannot hold paying customers, whatever else happens to work.

test("two businesses may hold the same customer without colliding", () => {
  const { store, alpha, beta, captured } = fixture();

  assert.equal(captured.alpha.ok, true);
  assert.equal(captured.beta.ok, true);
  assert.notEqual(
    captured.alpha.contactId,
    captured.beta.contactId,
    "the same phone number in two workspaces must be two contacts, not one",
  );

  // The deviation from the single-tenant skill, asserted rather than assumed.
  assert.equal(store.listContacts(alpha).length, 1);
  assert.equal(store.listContacts(beta).length, 1);

  closeDb();
});

test("a read across the tenant boundary returns nothing", () => {
  const { store, alpha, beta, captured } = fixture();

  assert.equal(store.getContact(alpha, captured.beta.contactId), null);
  assert.equal(store.getContact(beta, captured.alpha.contactId), null);
  assert.equal(store.getLead(alpha, captured.beta.leadId), null);
  assert.equal(store.getLead(beta, captured.alpha.leadId), null);

  closeDb();
});

test("a write across the tenant boundary changes nothing", () => {
  const { db, store, alpha, beta, captured } = fixture();

  assert.equal(store.updateContact(alpha, captured.beta.contactId, { name: "Hijacked" }), 0);
  assert.equal(store.addTag(alpha, captured.beta.contactId, "stolen"), 0);
  assert.equal(store.updateLeadStage(alpha, captured.beta.leadId, "won"), 0);
  assert.equal(store.deleteContact(alpha, captured.beta.contactId), 0);
  assert.equal(store.removeTag(alpha, captured.beta.contactId, "consulting"), 0);
  assert.equal(store.addActivity(alpha, captured.beta.leadId, { body: "intruded" }), 0);

  // Not merely ineffective: the rows must be exactly as they were.
  const theirs = db.prepare("select name from contacts where id = ?").get(captured.beta.contactId);
  assert.equal(theirs.name, "Jane Okafor", "Beta's record must be untouched");

  assert.equal(store.getLead(beta, captured.beta.leadId).stage, "new", "the stage must not move");
  assert.equal(store.getContact(beta, captured.beta.contactId).tags.join(), "consulting");
  assert.equal(store.getLead(beta, captured.beta.leadId).activities.length, 0);

  closeDb();
});

test("listings and counts describe one workspace only", () => {
  const { store, alpha, beta } = fixture();

  const alphaContacts = store.listContacts(alpha);
  const betaContacts = store.listContacts(beta);

  assert.equal(alphaContacts.length, 1);
  assert.equal(betaContacts.length, 1);
  assert.notEqual(alphaContacts[0].id, betaContacts[0].id);

  const alphaStats = store.stats(alpha);
  assert.equal(alphaStats.contacts, 1);
  assert.equal(alphaStats.leads, 1);
  assert.equal(alphaStats.recent.length, 1);
  assert.equal(alphaStats.recent[0].contact_name, "Jane Okafor");

  closeDb();
});

test("a lead cannot be assigned to somebody in another workspace", () => {
  const { store, alpha, bob, captured } = fixture();

  assert.throws(
    () => store.assignLead(alpha, captured.alpha.leadId, bob),
    /not a member of this workspace/,
    "handing a lead to an outsider would create a row they cannot see, or one they should not",
  );

  closeDb();
});

test("the tenant store refuses to run without an organisation", () => {
  const { store } = fixture();

  for (const bad of [null, undefined, "", "   "]) {
    assert.throws(() => store.listContacts(bad), /needs an organization id/);
    assert.throws(() => store.stats(bad), /needs an organization id/);
    assert.throws(() => store.listLeads(bad), /needs an organization id/);
    assert.throws(() => store.capture(bad, { email: "a@b.co" }), /needs an organization id/);
  }

  closeDb();
});

test("the audit trail is scoped to its workspace", () => {
  const { db, store, alpha, beta, alice } = fixture();

  const contact = store.listContacts(alpha)[0];
  store.updateContact(alpha, contact.id, { name: "Jane O." }, { actorUserId: alice });

  const alphaAudit = listAudit(db, alpha);
  const betaAudit = listAudit(db, beta);

  const actions = alphaAudit.map((r) => r.action);
  assert.ok(actions.includes("lead.capture"), "capturing a lead must be recorded");
  assert.ok(actions.includes("contact.update"), "a contact edit must be recorded");

  const betaIds = new Set(betaAudit.map((r) => r.id));
  assert.equal(
    alphaAudit.filter((r) => betaIds.has(r.id)).length,
    0,
    "one workspace's audit rows must not appear in another's",
  );

  closeDb();
});

test("a credential passed into audit meta is redacted", () => {
  const { db, store, alpha } = fixture();

  writeAudit(db, {
    orgId: alpha,
    action: "test.redaction",
    meta: { password: "hunter2", sessionToken: "abc", nested: { apiKey: "k" }, safe: "kept" },
  });

  const row = listAudit(db, alpha).find((r) => r.action === "test.redaction");
  const meta = JSON.parse(row.meta_json);

  assert.equal(meta.password, "[redacted]");
  assert.equal(meta.sessionToken, "[redacted]");
  assert.equal(meta.nested.apiKey, "[redacted]");
  assert.equal(meta.safe, "kept", "redaction must not be indiscriminate");

  closeDb();
});

test("roles gate actions, and only an owner may delete the workspace", () => {
  for (const role of ROLES) {
    assert.equal(can(role, "org:read"), true, `${role} should at least be able to read`);
  }

  assert.equal(can("viewer", "contact:write"), false);
  assert.equal(can("staff", "contact:write"), true);
  assert.equal(can("staff", "member:invite"), false);
  assert.equal(can("manager", "member:invite"), false);
  assert.equal(can("admin", "member:invite"), true);
  assert.equal(can("admin", "org:delete"), false);
  assert.equal(can("owner", "org:delete"), true);

  assert.equal(can("owner", "not:an:action"), false, "an unknown action is denied, not allowed");
  assert.equal(can("nonsense", "org:read"), false, "an unknown role is denied");

  assert.throws(() => assertCan("viewer", "contact:write"), /cannot perform/);
});

test("a staff member may only work the leads assigned to them", () => {
  const ours = { owner_user_id: "carol" };
  const theirs = { owner_user_id: "alice" };

  assert.equal(canEditLead("staff", ours, "carol"), true);
  assert.equal(canEditLead("staff", theirs, "carol"), false);
  assert.equal(canEditLead("manager", theirs, "carol"), true, "a manager works any lead");
  assert.equal(canEditLead("viewer", ours, "carol"), false, "a viewer writes nothing");
  assert.equal(canEditLead("staff", null, "carol"), false, "a missing lead is not a pass");
});

test("an unassigned lead cannot be moved by staff, but can by a manager", () => {
  const { store, alpha, carol, captured } = fixture();

  assert.throws(
    () =>
      store.updateLeadStage(alpha, captured.alpha.leadId, "contacted", {
        role: "staff",
        actorUserId: carol,
      }),
    /not assigned to you/,
  );

  assert.equal(
    store.updateLeadStage(alpha, captured.alpha.leadId, "contacted", {
      role: "manager",
      actorUserId: carol,
    }),
    1,
  );

  closeDb();
});

test("an unknown stage is refused rather than stored", () => {
  const { store, alpha, captured } = fixture();
  assert.throws(() => store.updateLeadStage(alpha, captured.alpha.leadId, "banana"), /Unknown stage/);
  closeDb();
});

test("membership is per workspace", () => {
  const { db, alpha, beta, alice, bob } = fixture();

  assert.deepEqual(membershipsFor(db, alice).map((m) => m.orgId), [alpha]);
  assert.deepEqual(membershipsFor(db, bob).map((m) => m.orgId), [beta]);

  closeDb();
});

test("entitlements follow the subscription, and an expired trial stops granting", () => {
  const { db, alpha, alice } = fixture();

  assert.equal(entitlementFor(db, alpha, "contacts").granted, true);
  assert.equal(entitlementFor(db, alpha, "contacts").limit, limitOf("starter", "contacts"));
  assert.equal(entitlementFor(db, alpha, "not-a-feature").granted, false);

  // A workspace with no subscription has no entitlement at all, which is not the same as a
  // zero limit: nothing was granted.
  const gamma = createOrganization(db, { name: "Gamma Clinic", ownerUserId: alice });
  assert.equal(entitlementFor(db, gamma.orgId, "contacts").granted, false);

  // Now give it one, already expired.
  startTrial(db, gamma.orgId, "starter", { days: 14, now: Date.now() - 90 * 86_400_000 });
  assert.equal(
    entitlementFor(db, gamma.orgId, "contacts").granted,
    false,
    "an expired trial must not keep granting paid features",
  );

  // And a live one.
  startTrial(db, gamma.orgId, "starter", { days: 14 });
  assert.equal(entitlementFor(db, gamma.orgId, "contacts").granted, true);

  closeDb();
});

test("an unknown plan is refused rather than silently granting nothing", () => {
  const { db, alpha } = fixture();
  assert.throws(() => startTrial(db, alpha, "enterprise-magic"), /Unknown plan/);
  closeDb();
});
