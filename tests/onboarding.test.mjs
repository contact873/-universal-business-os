import "./setup.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { openTestDb, closeDb } from "../src/lib/db.mjs";
import { seedPlans } from "./fixtures.mjs";
import { createTrialAccount } from "../src/lib/onboarding.mjs";
import {
  createUser,
  entitlementFor,
  ensureWorkspaceForUser,
  membershipsFor,
  suggestWorkspaceName,
} from "../src/lib/accounts.mjs";

const db = () => seedPlans(openTestDb());

const GOOD = {
  email: "founder@example.test",
  password: "a-long-enough-password",
  company: "Alpha Clinic",
  industry: "med-spa",
  country: "+971",
  name: "Founder",
};

test("a sign-up creates the account, the workspace, the owner role and a trial", async () => {
  const handle = db();
  const result = await createTrialAccount(handle, GOOD, { sendEmail: null });

  assert.equal(result.ok, true);
  assert.ok(result.userId && result.orgId);
  assert.equal(result.slug, "alpha-clinic");

  const user = handle.prepare("select * from users where id = ?").get(result.userId);
  assert.equal(user.email, "founder@example.test");
  assert.equal(user.is_platform_admin, 0, "a sign-up must never create a platform administrator");

  assert.deepEqual(membershipsFor(handle, result.userId).map((m) => m.role), ["owner"]);

  const subscription = handle
    .prepare("select status, plan_id from subscriptions where organization_id = ?")
    .get(result.orgId);
  assert.equal(subscription.status, "trialing");
  assert.equal(subscription.plan_id, "starter");

  // The trial grants what the plan allows, so the workspace is usable immediately.
  assert.equal(entitlementFor(handle, result.orgId, "contacts").granted, true);

  closeDb();
});

test("an asynchronous sender is awaited, so 'emailed' is not read from a promise", async () => {
  const handle = db();
  const sent = [];

  const result = await createTrialAccount(handle, GOOD, {
    sendEmail: async (message) => {
      sent.push(message);
      return { ok: true, id: "msg_1" };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(sent.length, 1);
  assert.equal(result.delivery.ok, true, "a resolved sender must be reported as delivered, not undefined");
  assert.equal(result.delivery.id, "msg_1");

  closeDb();
});

test("a mail failure does not undo the sign-up", async () => {
  const handle = db();
  const sent = [];

  const result = await createTrialAccount(handle, GOOD, {
    sendEmail: (message) => {
      sent.push(message);
      return { ok: false, reason: "not_configured" };
    },
  });

  assert.equal(result.ok, true, "a mail failure must not lose the customer");
  assert.equal(sent[0].to, "founder@example.test");
  assert.match(sent[0].subject, /Alpha Clinic/);
  assert.equal(result.delivery.ok, false);
  assert.equal(result.delivery.reason, "not_configured");
  assert.ok(handle.prepare("select id from users where email = ?").get("founder@example.test"));

  closeDb();
});

test("a sender that throws is caught rather than failing the request", async () => {
  const handle = db();
  const result = await createTrialAccount(handle, GOOD, {
    sendEmail: async () => {
      throw new Error("provider exploded");
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.delivery.reason, "sender_threw");
  assert.match(result.delivery.detail, /provider exploded/);

  closeDb();
});

test("a second sign-up with the same email is refused without creating a second workspace", async () => {
  const handle = db();
  await createTrialAccount(handle, GOOD, { sendEmail: null });

  const again = await createTrialAccount(handle, GOOD, { sendEmail: null });
  assert.equal(again.ok, false);
  assert.equal(again.reason, "email_taken");

  assert.equal(handle.prepare("select count(*) as n from organizations").get().n, 1);
  assert.equal(handle.prepare("select count(*) as n from users").get().n, 1);

  closeDb();
});

test("the email is normalised, so a capitalised address cannot create a duplicate account", async () => {
  const handle = db();
  const first = await createTrialAccount(handle, { ...GOOD, email: "Founder@Example.Test" }, { sendEmail: null });
  const second = await createTrialAccount(handle, { ...GOOD, email: "founder@example.test", company: "Other" }, { sendEmail: null });

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.reason, "email_taken");
  assert.equal(handle.prepare("select email from users").get().email, "founder@example.test");

  closeDb();
});

test("a weak password is refused with the rule, not with a generic message", async () => {
  const handle = db();
  const result = await createTrialAccount(handle, { ...GOOD, password: "short" }, { sendEmail: null });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "bad_input");
  assert.match(result.message, /at least 10 characters/);
  assert.equal(handle.prepare("select count(*) as n from users").get().n, 0);

  closeDb();
});

test("a business name is required before anything is written", async () => {
  const handle = db();
  const result = await createTrialAccount(handle, { ...GOOD, company: "  " }, { sendEmail: null });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "bad_company");
  assert.equal(handle.prepare("select count(*) as n from users").get().n, 0);

  closeDb();
});

test("two businesses with the same name get different slugs", async () => {
  const handle = db();
  const one = await createTrialAccount(handle, GOOD, { sendEmail: null });
  const two = await createTrialAccount(handle, { ...GOOD, email: "second@example.test" }, { sendEmail: null });

  assert.equal(one.slug, "alpha-clinic");
  assert.equal(two.slug, "alpha-clinic-2", "a duplicate name must not collide on the slug");

  closeDb();
});

test("with no sender configured, the account is still created and the delivery says so", async () => {
  const handle = db();
  const result = await createTrialAccount(handle, GOOD, {});

  assert.equal(result.ok, true);
  assert.equal(result.delivery.reason, "not_attempted");

  closeDb();
});

test("a person who signs in with no workspace is given one, not sent away", () => {
  const db = seedPlans(openTestDb());
  const user = createUser(db, { email: "contact@raschident.com", password: "a-long-enough-password" });

  assert.equal(membershipsFor(db, user.userId).length, 0, "starts with nothing, as a half-finished signup leaves it");

  const first = ensureWorkspaceForUser(db, user.userId);
  assert.equal(first.created, true);

  const memberships = membershipsFor(db, user.userId);
  assert.equal(memberships.length, 1);
  assert.equal(memberships[0].role, "owner", "they own the workspace they were given");
  assert.equal(entitlementFor(db, first.orgId, "contacts").limit, 100, "and it is on the free plan");

  const org = db.prepare("select name, timezone from organizations where id = ?").get(first.orgId);
  assert.equal(org.name, "Raschident", "a contact address suggests the business, not the mailbox");
  assert.equal(org.timezone, "Asia/Karachi");

  const second = ensureWorkspaceForUser(db, user.userId);
  assert.equal(second.created, false, "signing in again does not build a second workspace");
  assert.equal(membershipsFor(db, user.userId).length, 1);

  closeDb();
});

test("a workspace name is guessed from the address, and never left empty", () => {
  assert.equal(suggestWorkspaceName("contact@raschident.com"), "Raschident");
  assert.equal(suggestWorkspaceName("misbah.aff62@gmail.com"), "Misbah Aff62");
  assert.equal(suggestWorkspaceName("hello@dental-labs.pk"), "Dental Labs");
  assert.equal(suggestWorkspaceName(""), "My workspace");
  assert.equal(suggestWorkspaceName("info@"), "My workspace");
});
