import "./setup.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { openTestDb, closeDb } from "../src/lib/db.mjs";
import { seedPlans } from "./fixtures.mjs";
import {
  createUser,
  createOrganization,
  createInvitation,
  recordInvitationDelivery,
  listInvitations,
  acceptInvitation,
  addMember,
} from "../src/lib/accounts.mjs";
import { sendEmail, invitationEmail, emailConfigured } from "../src/lib/email.mjs";

function workspace() {
  const db = seedPlans(openTestDb());
  const owner = createUser(db, { email: "owner@alpha.test", password: "a-long-enough-password" });
  const invitee = createUser(db, { email: "new@alpha.test", password: "a-long-enough-password" });
  const org = createOrganization(db, { name: "Alpha Clinic", ownerUserId: owner.userId });
  addMember(db, org.orgId, owner.userId, "owner");
  return { db, orgId: org.orgId, owner, invitee };
}

/* sending ------------------------------------------------------------------ */

test("with no provider configured, sending fails honestly instead of pretending", async () => {
  let called = false;
  const result = await sendEmail(
    { to: "a@b.co", subject: "Hello", html: "<p>Hi</p>" },
    { key: "", fetchImpl: async () => { called = true; return { ok: true, json: async () => ({ id: "x" }) }; } },
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "not_configured");
  assert.equal(called, false, "nothing should be attempted without a key");
  assert.equal(emailConfigured(""), false);
  assert.equal(emailConfigured("re_key"), true);
});

test("a provider that accepts the message returns its id", async () => {
  const result = await sendEmail(
    { to: "a@b.co", subject: "Hello", html: "<p>Hi</p>" },
    { key: "re_test", fetchImpl: async (url, options) => {
      assert.equal(url, "https://api.resend.com/emails");
      assert.equal(options.method, "POST");
      const body = JSON.parse(options.body);
      assert.deepEqual(body.to, ["a@b.co"]);
      assert.equal(options.headers.authorization, "Bearer re_test");
      return { ok: true, status: 200, json: async () => ({ id: "msg_123" }) };
    } },
  );

  assert.equal(result.ok, true);
  assert.equal(result.id, "msg_123");
});

test("a provider that rejects the message reports the status and a clipped detail", async () => {
  const result = await sendEmail(
    { to: "a@b.co", subject: "Hello", html: "<p>Hi</p>" },
    { key: "re_test", fetchImpl: async () => ({ ok: false, status: 422, text: async () => "x".repeat(900) }) },
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "provider_error");
  assert.equal(result.status, 422);
  assert.ok(result.detail.length <= 300, "the detail is clipped before it reaches an interface");
});

test("a network failure is caught rather than thrown at the caller", async () => {
  const result = await sendEmail(
    { to: "a@b.co", subject: "Hello", html: "<p>Hi</p>" },
    { key: "re_test", fetchImpl: async () => { throw new Error("socket hang up"); } },
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "network_error");
  assert.match(result.detail, /socket hang up/);
});

test("an incomplete message is refused before the network is touched", async () => {
  let called = false;
  const result = await sendEmail({ to: "", subject: "x", html: "y" }, { key: "re_test", fetchImpl: async () => { called = true; } });
  assert.equal(result.reason, "incomplete");
  assert.equal(called, false);
});

test("the invitation email escapes what it is given", () => {
  const { subject, html } = invitationEmail({
    workspaceName: 'Clinic <script>alert(1)</script>',
    inviterEmail: "owner@alpha.test",
    role: "staff",
  });

  assert.equal(html.includes("<script>"), false, "an angle bracket from a workspace name must not survive");
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(subject.includes("Clinic"));
});

/* storing before sending --------------------------------------------------- */

test("an invitation is stored even when sending fails, and the failure is recorded", async () => {
  const { db, orgId, owner } = workspace();

  const invitation = createInvitation(db, orgId, { email: "new@alpha.test", role: "staff", actorUserId: owner.userId });
  assert.ok(invitation.token, "the token is returned once");

  const stored = db.prepare("select * from invitations where id = ?").get(invitation.invitationId);
  assert.ok(stored, "the row exists before any send is attempted");
  assert.equal(stored.sent_at, null);
  assert.notEqual(stored.token_hash, invitation.token, "the raw token is never stored");
  assert.equal(stored.token_hash.length, 64, "only a sha256 hash is kept");

  const failed = await sendEmail({ to: "new@alpha.test", subject: "x", html: "y" }, { key: "" });
  recordInvitationDelivery(db, invitation.invitationId, failed);

  const afterFailure = listInvitations(db, orgId)[0];
  assert.equal(afterFailure.sent_at, null);
  assert.equal(afterFailure.send_error, "not_configured");

  // Now a real send, which succeeds.
  const sent = await sendEmail(
    { to: "new@alpha.test", subject: "x", html: "y" },
    { key: "re_test", fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ id: "msg_1" }) }) },
  );
  recordInvitationDelivery(db, invitation.invitationId, sent);

  const afterSuccess = listInvitations(db, orgId)[0];
  assert.ok(afterSuccess.sent_at, "a delivered invitation says so");
  assert.equal(afterSuccess.send_error, null, "and the earlier error is cleared");

  closeDb();
});

test("the email body survives a workspace name with an ampersand", () => {
  const { html } = invitationEmail({ workspaceName: "Smith & Jones", inviterEmail: "a@b.co", role: "admin" });
  assert.ok(html.includes("Smith &amp; Jones"));
});

/* accepting ---------------------------------------------------------------- */

test("accepting an invitation joins the right workspace with the invited role", () => {
  const { db, orgId, owner, invitee } = workspace();
  const invitation = createInvitation(db, orgId, { email: "new@alpha.test", role: "manager", actorUserId: owner.userId });

  const result = acceptInvitation(db, invitation.token, invitee.userId);
  assert.equal(result.ok, true);
  assert.equal(result.orgId, orgId);
  assert.equal(result.role, "manager");

  const membership = db.prepare("select role from memberships where organization_id = ? and user_id = ?").get(orgId, invitee.userId);
  assert.equal(membership.role, "manager");

  closeDb();
});

test("a bogus, reused or expired invitation is refused", () => {
  const { db, orgId, owner, invitee } = workspace();
  const invitation = createInvitation(db, orgId, { email: "new@alpha.test", role: "staff", actorUserId: owner.userId });

  assert.equal(acceptInvitation(db, "not-a-real-token", invitee.userId).reason, "unknown");
  assert.equal(acceptInvitation(db, invitation.token, invitee.userId).ok, true);
  assert.equal(acceptInvitation(db, invitation.token, invitee.userId).reason, "already_accepted");

  const stale = createInvitation(db, orgId, { email: "late@alpha.test", role: "staff", actorUserId: owner.userId });
  const third = createUser(db, { email: "third@alpha.test", password: "a-long-enough-password" });
  assert.equal(
    acceptInvitation(db, stale.token, third.userId, { now: Date.now() + 30 * 86_400_000 }).reason,
    "expired",
    "an invitation is not open forever",
  );

  closeDb();
});

test("an invitation to a bad address or an unknown role is refused at the point of creation", () => {
  const { db, orgId } = workspace();
  assert.throws(() => createInvitation(db, orgId, { email: "not-an-email", role: "staff" }), /does not look right/);
  assert.throws(() => createInvitation(db, orgId, { email: "a@b.co", role: "wizard" }), /Unknown role/);
  closeDb();
});
