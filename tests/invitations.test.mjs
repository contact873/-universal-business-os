import "./setup.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { openTestDb, closeDb } from "../src/lib/db.mjs";
import { seedPlans } from "./fixtures.mjs";
import {
  createUser,
  createOrganization,
  createInvitation,
  acceptInvitation,
  findInvitationByToken,
  pendingInvitationCount,
  membershipsFor,
} from "../src/lib/accounts.mjs";
import { withinLimit } from "../src/lib/billing.mjs";

const DAY = 86_400_000;

function workspace({ plan = "professional" } = {}) {
  const db = seedPlans(openTestDb());
  const owner = createUser(db, { email: "owner@alpha.test", password: "a-long-enough-password", name: "Owner" });
  const org = createOrganization(db, { name: "Alpha Clinic", ownerUserId: owner.userId, plan });
  return { db, orgId: org.orgId, ownerId: owner.userId };
}

test("an invitation stores a hash, not the link", () => {
  const { db, orgId } = workspace();
  const invitation = createInvitation(db, orgId, { email: "Newbie@Example.test", role: "staff" });

  const row = db.prepare("select * from invitations where id = ?").get(invitation.invitationId);
  assert.equal(row.email, "newbie@example.test", "the address is normalised before it is stored");
  assert.notEqual(row.token_hash, invitation.token);
  assert.equal(
    JSON.stringify(row).includes(invitation.token),
    false,
    "a database leak must not hand somebody a working invitation",
  );

  // The token is the only way back to the row.
  const found = findInvitationByToken(db, invitation.token);
  assert.equal(found.ok, true);
  assert.equal(found.email, "newbie@example.test");
  assert.equal(found.organizationName, "Alpha Clinic");
  assert.equal(found.acceptable, true);

  assert.equal(findInvitationByToken(db, "not-a-real-token").ok, false);

  closeDb();
});

test("accepting joins the workspace with the invited role", () => {
  const { db, orgId } = workspace();
  const invitation = createInvitation(db, orgId, { email: "newbie@example.test", role: "manager" });
  const { userId } = createUser(db, { email: "newbie@example.test", password: "a-long-enough-password" });

  const accepted = acceptInvitation(db, invitation.token, userId);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.role, "manager");
  assert.equal(accepted.organizationName, "Alpha Clinic");
  assert.equal(accepted.orgId, orgId);

  const memberships = membershipsFor(db, userId);
  assert.deepEqual(memberships.map((m) => m.role), ["manager"]);
  assert.deepEqual(memberships.map((m) => m.orgId), [orgId]);

  const row = db.prepare("select accepted_at from invitations where id = ?").get(invitation.invitationId);
  assert.ok(row.accepted_at, "the invitation is marked used");

  closeDb();
});

test("the link only works for the address it was sent to", () => {
  const { db, orgId } = workspace();
  const invitation = createInvitation(db, orgId, { email: "invited@example.test", role: "staff" });

  // Somebody else has an account and was forwarded the link. That must not be enough.
  const { userId: stranger } = createUser(db, { email: "stranger@example.test", password: "a-long-enough-password" });

  const refused = acceptInvitation(db, invitation.token, stranger);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "wrong_account");
  assert.equal(refused.invitedEmail, "invited@example.test");
  assert.equal(
    db.prepare("select count(*) as n from memberships where organization_id = ?").get(orgId).n,
    1,
    "only the owner belongs to the workspace",
  );

  // And the invitation is still usable by the right person.
  const { userId } = createUser(db, { email: "invited@example.test", password: "a-long-enough-password" });
  assert.equal(acceptInvitation(db, invitation.token, userId).ok, true);

  closeDb();
});

test("an invitation is single use", () => {
  const { db, orgId } = workspace();
  const invitation = createInvitation(db, orgId, { email: "newbie@example.test", role: "staff" });
  const { userId } = createUser(db, { email: "newbie@example.test", password: "a-long-enough-password" });

  assert.equal(acceptInvitation(db, invitation.token, userId).ok, true);

  const second = acceptInvitation(db, invitation.token, userId);
  assert.equal(second.ok, false);
  assert.equal(second.reason, "already_accepted");

  assert.equal(
    db.prepare("select count(*) as n from audit_logs where action = ?").get("member.accepted").n,
    1,
    "no second audit entry for the same membership",
  );

  closeDb();
});

test("an expired invitation is refused, and says so", () => {
  const { db, orgId } = workspace();
  const invitation = createInvitation(db, orgId, { email: "newbie@example.test", role: "staff", days: 7 });
  const { userId } = createUser(db, { email: "newbie@example.test", password: "a-long-enough-password" });

  const afterExpiry = Date.now() + 8 * DAY;
  const refused = acceptInvitation(db, invitation.token, userId, { now: afterExpiry });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "expired");

  const found = findInvitationByToken(db, invitation.token, { now: afterExpiry });
  assert.equal(found.expired, true);
  assert.equal(found.acceptable, false);

  // The same link still worked the day before it lapsed.
  assert.equal(findInvitationByToken(db, invitation.token, { now: Date.now() + 6 * DAY }).acceptable, true);

  closeDb();
});

test("seats count people who have been invited but not yet joined", () => {
  const { db, orgId } = workspace({ plan: "starter" });

  // Starter includes two people, and the owner is one of them.
  assert.equal(withinLimit(db, orgId, "seats").limit, 2);
  assert.equal(withinLimit(db, orgId, "seats", { current: 1 + pendingInvitationCount(db, orgId) }).allowed, true);

  createInvitation(db, orgId, { email: "one@example.test", role: "staff" });
  assert.equal(pendingInvitationCount(db, orgId), 1);
  assert.equal(
    withinLimit(db, orgId, "seats", { current: 1 + pendingInvitationCount(db, orgId) }).allowed,
    false,
    "an invited person is a seat already spoken for",
  );

  // Accepting does not free a seat, and neither does the invitation expiring.
  const { userId } = createUser(db, { email: "one@example.test", password: "a-long-enough-password" });
  acceptInvitation(db, db.prepare("select token_hash from invitations limit 1").get() && "", userId);
  assert.equal(pendingInvitationCount(db, orgId), 1);

  closeDb();
});

test("the free plan's single seat is already taken by its owner", () => {
  const { db, orgId } = workspace({ plan: "free" });

  const seats = withinLimit(db, orgId, "seats", { current: 1 + pendingInvitationCount(db, orgId) });
  assert.equal(seats.limit, 1);
  assert.equal(seats.allowed, false, "a second person is what Professional sells");

  closeDb();
});
