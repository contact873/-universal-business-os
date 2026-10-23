import "./setup.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { openTestDb, closeDb } from "../src/lib/db.mjs";
import { seedPlans } from "./fixtures.mjs";
import { createUser, createOrganization, updateOrganization } from "../src/lib/accounts.mjs";
import { createFreeAccount, resolveIndustry } from "../src/lib/onboarding.mjs";

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

test("choosing Others requires the sentence, and the sentence becomes the value", () => {
  // The reason for asking is to learn what the business does, so "others" on its own is refused:
  // otherwise the record says "others" two hundred times and tells us nothing.
  assert.equal(resolveIndustry("others", null).reason, "industry_required");
  assert.equal(resolveIndustry("others", "").reason, "industry_required");
  assert.equal(resolveIndustry("others", " ").reason, "industry_required");
  assert.equal(resolveIndustry("others", "x").reason, "industry_required");

  const stored = resolveIndustry("others", "  Dental laboratory  ");
  assert.equal(stored.ok, true);
  assert.equal(stored.industry, "Dental laboratory", "the sentence is stored, not the word others");

  assert.equal(resolveIndustry("others", "y".repeat(61)).reason, "industry_too_long");
});

test("a listed industry passes through, and an empty one is allowed at sign-up", () => {
  assert.equal(resolveIndustry("med-spa", null).industry, "med-spa");
  assert.equal(resolveIndustry("MED-SPA", null).industry, "med-spa", "the choice is normalised");
  assert.equal(resolveIndustry(null, null).industry, null);
  assert.equal(resolveIndustry("consulting", "ignored text").industry, "consulting", "the box is only for Others");
});

test("a sign-up that chooses Others stores what the person typed", async () => {
  const db = seedPlans(openTestDb());

  const refused = await createFreeAccount(
    db,
    { email: "no@example.test", password: "a-long-enough-password", company: "No Clinic", industry: "others" },
    { sendEmail: null },
  );
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "industry_required");
  assert.equal(db.prepare("select count(*) as n from organizations").get().n, 0, "nothing is created when it is refused");

  const accepted = await createFreeAccount(
    db,
    {
      email: "yes@example.test",
      password: "a-long-enough-password",
      company: "Yes Clinic",
      industry: "others",
      industryOther: "Sports physiotherapy",
    },
    { sendEmail: null },
  );
  assert.equal(accepted.ok, true);

  const org = db.prepare("select industry from organizations where id = ?").get(accepted.orgId);
  assert.equal(org.industry, "Sports physiotherapy");

  // The subscriber registry sees it too, so the list can be grouped by what people actually do.
  const subscriber = db.prepare("select status from subscribers where organization_id = ?").get(accepted.orgId);
  assert.equal(subscriber.status, "free");

  closeDb();
});
