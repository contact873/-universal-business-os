import "./setup.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { openTestDb, closeDb } from "../src/lib/db.mjs";
import { createUser, createOrganization, addMember, removeMember } from "../src/lib/accounts.mjs";
import {
  createSession,
  verifySession,
  revokeSession,
  revokeAllSessionsForUser,
  switchOrg,
} from "../src/lib/sessions.mjs";

function fixture() {
  const db = openTestDb();
  const owner = createUser(db, { email: "owner@example.test", password: "a-long-enough-password" });
  const staff = createUser(db, { email: "staff@example.test", password: "a-long-enough-password" });
  const outsider = createUser(db, { email: "out@example.test", password: "a-long-enough-password" });

  const org = createOrganization(db, { name: "Clinic One", ownerUserId: owner.userId });
  addMember(db, org.orgId, staff.userId, "staff");

  return { db, owner, staff, outsider, org };
}

test("a fresh session verifies and carries the user and workspace", () => {
  const { db, owner, org } = fixture();

  const { token } = createSession(db, { userId: owner.userId, orgId: org.orgId });
  const result = verifySession(db, token);

  assert.equal(result.ok, true);
  assert.equal(result.user.id, owner.userId);
  assert.equal(result.orgId, org.orgId);
  assert.equal(result.role, "owner");

  closeDb();
});

test("a tampered token is rejected without touching the database", () => {
  const { db, owner } = fixture();
  const { token } = createSession(db, { userId: owner.userId });

  const [body, mac] = token.split(".");
  const flipped = Buffer.from(mac.slice(0, -2) + (mac.endsWith("AA") ? "BB" : "AA")).toString(
    "base64url",
  );

  assert.equal(verifySession(db, `${body}.${flipped}`).ok, false);
  assert.equal(verifySession(db, token.slice(0, -3)).ok, false);
  assert.equal(verifySession(db, "not-a-token").ok, false);
  assert.equal(verifySession(db, "").ok, false);
  assert.equal(verifySession(db, null).ok, false);

  closeDb();
});

test("an expired session fails, with the reason recorded", () => {
  const { db, owner } = fixture();

  const past = Date.now() - 60_000;
  const { token } = createSession(db, { userId: owner.userId, ttlMs: 1000, now: past });
  const result = verifySession(db, token);

  assert.equal(result.ok, false);
  assert.equal(result.reason, "expired");

  closeDb();
});

test("logout genuinely revokes, even though the signature is still valid", () => {
  const { db, owner } = fixture();
  const { token } = createSession(db, { userId: owner.userId });

  assert.equal(verifySession(db, token).ok, true, "the token works before logout");
  assert.equal(revokeSession(db, token), 1);

  const after = verifySession(db, token);
  assert.equal(after.ok, false);
  assert.equal(after.reason, "revoked", "a signed token must not outlive a logout");

  closeDb();
});

test("a password change ends every other session", () => {
  const { db, owner } = fixture();
  const laptop = createSession(db, { userId: owner.userId });
  const phone = createSession(db, { userId: owner.userId });

  assert.equal(revokeAllSessionsForUser(db, owner.userId), 2);
  assert.equal(verifySession(db, laptop.token).ok, false);
  assert.equal(verifySession(db, phone.token).ok, false);

  closeDb();
});

test("a session pointing at a workspace the user was removed from stops working", () => {
  const { db, staff, org } = fixture();
  const { token } = createSession(db, { userId: staff.userId, orgId: org.orgId });

  assert.equal(verifySession(db, token).ok, true);

  removeMember(db, org.orgId, staff.userId);

  const after = verifySession(db, token);
  assert.equal(after.ok, false);
  assert.equal(after.reason, "no_membership");

  closeDb();
});

test("switching workspace is allowed for a member and refused for everyone else", () => {
  const { db, owner, outsider, staff, org } = fixture();
  const { sessionId } = createSession(db, { userId: owner.userId });

  // A member of this workspace may switch into it.
  assert.equal(switchOrg(db, sessionId, org.orgId).ok, true);

  const otherOrg = createOrganization(db, { name: "Clinic Two", ownerUserId: outsider.userId });
  const { sessionId: outsiderSession } = createSession(db, {
    userId: outsider.userId,
    orgId: otherOrg.orgId,
  });

  // Somebody who belongs to a different workspace may not.
  const cross = switchOrg(db, outsiderSession, org.orgId);
  assert.equal(cross.ok, false);
  assert.equal(cross.reason, "not_a_member");

  // Any member may switch into it, not only the owner.
  const { sessionId: staffSession } = createSession(db, { userId: staff.userId });
  assert.equal(switchOrg(db, staffSession, org.orgId).ok, true);

  // Somebody with no membership at all may not.
  const ghost = createUser(db, { email: "ghost@example.test", password: "a-long-enough-password" });
  addMember(db, otherOrg.orgId, ghost.userId, "viewer");
  const { sessionId: ghostSession } = createSession(db, {
    userId: ghost.userId,
    orgId: otherOrg.orgId,
  });
  assert.equal(switchOrg(db, ghostSession, org.orgId).reason, "not_a_member");

  // And an unknown session is refused rather than treated as anonymous.
  assert.equal(switchOrg(db, "ses_does_not_exist", org.orgId).reason, "unknown");

  closeDb();
});
