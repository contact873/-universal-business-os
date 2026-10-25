// Accounts: users, organisations, memberships.
//
// Kept separate from tenant.mjs on purpose. That module is the boundary for tenant-owned records
// and refuses to run without an organisation; accounts exist before any organisation does, so
// mixing them would have meant weakening that guarantee.

import { id, nowIso, normalizeEmail } from "./identities.mjs";
import { randomBytes, createHash } from "node:crypto";
import { hashPassword, verifyPassword, needsRehash, MIN_PASSWORD_LENGTH } from "./passwords.mjs";
import { writeAudit } from "./audit.mjs";
import { isRole } from "./roles.mjs";
import { isPaying } from "./subscription-state.mjs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function createUser(db, { email, password, name = null, platformAdmin = false }) {
  const clean = normalizeEmail(email);
  if (!EMAIL_RE.test(clean)) {
    const error = new Error("That email address does not look right.");
    error.status = 400;
    throw error;
  }
  if (String(password ?? "").length < MIN_PASSWORD_LENGTH) {
    const error = new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    error.status = 400;
    throw error;
  }

  const existing = db.prepare("select id from users where email = ?").get(clean);
  if (existing) {
    const error = new Error("An account with that email already exists.");
    error.status = 409;
    throw error;
  }

  const userId = id("usr");
  db.prepare(
    `insert into users (id, email, password_hash, name, email_verified_at, is_platform_admin, created_at)
     values (?, ?, ?, ?, null, ?, ?)`,
  ).run(userId, clean, hashPassword(password), name, platformAdmin ? 1 : 0, nowIso());

  return { userId, email: clean };
}

export function authenticate(db, email, password) {
  const row = db.prepare("select * from users where email = ?").get(normalizeEmail(email));
  if (!row) return { ok: false, reason: "invalid_credentials" };

  if (!verifyPassword(password, row.password_hash)) {
    return { ok: false, reason: "invalid_credentials" };
  }

  // A successful login is the natural moment to upgrade a hash made with older parameters.
  if (needsRehash(row.password_hash)) {
    db.prepare("update users set password_hash = ? where id = ?").run(
      hashPassword(password),
      row.id,
    );
  }

  return { ok: true, user: row };
}

export function changePassword(db, userId, currentPassword, newPassword) {
  const row = db.prepare("select * from users where id = ?").get(userId);
  if (!row) return { ok: false, reason: "no_user" };
  if (!verifyPassword(currentPassword, row.password_hash)) {
    return { ok: false, reason: "invalid_password" };
  }
  db.prepare("update users set password_hash = ? where id = ?").run(
    hashPassword(newPassword),
    userId,
  );
  return { ok: true };
}

// An intake key identifies one workspace and grants nothing else. A website that posts enquiries
// therefore holds a value that cannot read any customer data even if it leaks.
export function generateIntakeKey() {
  return `ubos_${randomBytes(18).toString("base64url")}`;
}

export function organizationByIntakeKey(db, key) {
  const clean = String(key ?? "").trim();
  if (!clean) return null;
  return (
    db
      .prepare(
        "select id, name, slug, industry, default_country from organizations where intake_key = ?",
      )
      .get(clean) ?? null
  );
}

export function slugify(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "workspace";
}

export function createOrganization(
  db,
  { name, industry = null, timezone = "UTC", ownerUserId = null, slug = null, plan = null, defaultCountry = null },
) {
  const cleanName = String(name ?? "").trim();
  if (cleanName.length < 2) {
    const error = new Error("A workspace needs a name.");
    error.status = 400;
    throw error;
  }

  const base = slugify(slug || cleanName);
  let candidate = base;
  for (let n = 2; db.prepare("select id from organizations where slug = ?").get(candidate); n += 1) {
    candidate = `${base}-${n}`;
  }

  const orgId = id("org");
  const intakeKey = generateIntakeKey();
  db.prepare(
    `insert into organizations (id, name, slug, industry, timezone, intake_key, default_country, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(orgId, cleanName, candidate, industry, timezone, intakeKey, defaultCountry, nowIso());

  if (ownerUserId) {
    addMember(db, orgId, ownerUserId, "owner");
    writeAudit(db, {
      orgId,
      actorUserId: ownerUserId,
      action: "org.create",
      entity: "organization",
      entityId: orgId,
      meta: { name: cleanName, industry },
    });
  }

  if (plan) startTrial(db, orgId, plan);

  return { orgId, slug: candidate };
}

export function addMember(db, orgId, userId, role) {
  if (!isRole(role)) {
    const error = new Error(`Unknown role "${role}".`);
    error.status = 400;
    throw error;
  }

  db.prepare(
    `insert into memberships (organization_id, user_id, role, created_at)
     values (?, ?, ?, ?)
     on conflict (organization_id, user_id) do update set role = excluded.role`,
  ).run(orgId, userId, role, nowIso());

  return { ok: true };
}

export function removeMember(db, orgId, userId) {
  return db
    .prepare("delete from memberships where organization_id = ? and user_id = ?")
    .run(orgId, userId).changes;
}

export function roleFor(db, orgId, userId) {
  const row = db
    .prepare("select role from memberships where organization_id = ? and user_id = ?")
    .get(orgId, userId);
  return row?.role ?? null;
}

export function membershipsFor(db, userId) {
  return db
    .prepare(
      `select m.organization_id as orgId, m.role, o.name, o.slug
         from memberships m join organizations o on o.id = m.organization_id
        where m.user_id = ?
        order by o.name`,
    )
    .all(userId);
}

/**
 * The free plan: active, no period end, nothing to pay, no card.
 *
 * Status is 'active' with a null period_end, which the paying rule treats as valid indefinitely.
 * That is intentional: a free plan that "expires" is a trial wearing a costume, and it is the kind
 * of thing that produces angry email.
 */
const GENERIC_MAILBOXES = new Set([
  "info", "contact", "hello", "admin", "sales", "office", "mail", "support", "enquiries", "team", "accounts",
]);

/**
 * A name for a workspace nobody has named yet, taken from the address they signed up with. Contact
 * addresses say nothing about the business, so for those we use the domain instead of the mailbox.
 */
export function suggestWorkspaceName(email) {
  const [local = "", domain = ""] = String(email ?? "").toLowerCase().split("@");
  const basis = local && !GENERIC_MAILBOXES.has(local) ? local : (domain.split(".")[0] ?? "");
  const words = basis.split(/[._+-]+/).filter(Boolean);
  if (!words.length) return "My workspace";
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ").slice(0, 80);
}

/**
 * Gives a signed-in person the workspace they came for.
 *
 * Without this, signing up on the website and then signing in to the app is a dead end: the login
 * succeeds, the session carries no workspace, and the app sends them straight back to the sign-in page
 * with nothing to read. Half-finished signups leave exactly that account behind, so the repair belongs
 * here rather than in a one-off fix for one person.
 *
 * Called on sign-in, so it can only ever add a workspace to a person who has none.
 */
export function ensureWorkspaceForUser(db, userId, { timezone = "Asia/Karachi" } = {}) {
  const existing = membershipsFor(db, userId);
  if (existing.length) return { created: false, orgId: existing[0].orgId };

  const user = db.prepare("select id, email, name from users where id = ?").get(userId);
  if (!user) {
    const error = new Error("That account no longer exists.");
    error.status = 401;
    throw error;
  }

  const name = user.name?.trim() || suggestWorkspaceName(user.email);
  const org = createOrganization(db, { name, ownerUserId: userId, timezone });
  startFreePlan(db, org.orgId);

  writeAudit(db, {
    orgId: org.orgId,
    actorUserId: userId,
    action: "org.create_on_sign_in",
    entity: "organization",
    entityId: org.orgId,
    detail: { name, reason: "signed in with no workspace" },
  });

  return { created: true, orgId: org.orgId };
}

export function startFreePlan(db, orgId, planId = "free", { now = Date.now() } = {}) {
  const plan = db.prepare("select * from plans where id = ?").get(planId);
  if (!plan) {
    const error = new Error(`Unknown plan "${planId}".`);
    error.status = 400;
    throw error;
  }

  db.prepare(
    `insert into subscriptions (id, organization_id, provider, provider_id, status, plan_id, trial_end, period_end, created_at)
     values (?, ?, null, null, 'active', ?, null, null, ?)`,
  ).run(id("sub"), orgId, planId, new Date(now).toISOString());

  const limits = plan.limits_json ? JSON.parse(plan.limits_json) : {};
  for (const [feature, limit] of Object.entries(limits)) {
    grant(db, orgId, feature, typeof limit === "number" ? limit : null);
  }

  writeAudit(db, {
    orgId,
    actorUserId: null,
    action: "billing.free_plan_started",
    entity: "subscription",
    meta: { planId },
  });

  return { ok: true, planId, status: "active" };
}

// Billing is not wired yet, but the entitlement check is, so that paid features are gated on the
// server from the first day rather than retrofitted around a UI flag.
export function startTrial(db, orgId, planId, { days = 14, now = Date.now() } = {}) {
  const plan = db.prepare("select * from plans where id = ?").get(planId);
  if (!plan) {
    const error = new Error(`Unknown plan "${planId}".`);
    error.status = 400;
    throw error;
  }

  db.prepare(
    `insert into subscriptions (id, organization_id, provider, provider_id, status, plan_id, trial_end, period_end, created_at)
     values (?, ?, null, null, 'trialing', ?, ?, null, ?)`,
  ).run(
    id("sub"),
    orgId,
    planId,
    new Date(now + days * 86_400_000).toISOString(),
    new Date(now).toISOString(),
  );

  const limits = plan.limits_json ? JSON.parse(plan.limits_json) : {};
  for (const [feature, limit] of Object.entries(limits)) {
    grant(db, orgId, feature, typeof limit === "number" ? limit : null);
  }

  return { ok: true, trialEnd: new Date(now + days * 86_400_000).toISOString() };
}

export function grant(db, orgId, feature, limitValue = null) {
  db.prepare(
    `insert into entitlements (id, organization_id, feature, limit_value, created_at)
     values (?, ?, ?, ?, ?)
     on conflict (organization_id, feature) do update set limit_value = excluded.limit_value`,
  ).run(id("ent"), orgId, feature, limitValue, nowIso());
  return { ok: true };
}

/**
 * Brings every workspace's limits into line with the plan catalogue.
 *
 * Limits are granted once, when a plan starts, and the catalogue can change afterwards. When the free
 * plan moved from one seat to two, every workspace created before the change kept the old row: the
 * website promised two people, the dashboard showed two, and the invite button refused the second one.
 * Nothing was broken enough to notice and everything was wrong enough to matter.
 *
 * Reducing a limit never deletes anything: reaching one refuses new records, so a workspace over a
 * lowered limit keeps what it has. That is what makes running this on every start safe.
 */
export function reconcileEntitlementsToPlan(db, { now = Date.now() } = {}) {
  const live = db
    .prepare(
      `select s.organization_id as orgId, s.plan_id as planId, p.limits_json as limits
         from subscriptions s
         join plans p on p.id = s.plan_id
        where s.plan_id is not null
          and s.created_at = (select max(x.created_at) from subscriptions x where x.organization_id = s.organization_id)`,
    )
    .all();

  const changes = [];
  for (const row of live) {
    let limits = {};
    try {
      limits = row.limits ? JSON.parse(row.limits) : {};
    } catch {
      continue;
    }

    for (const [feature, value] of Object.entries(limits)) {
      const wanted = typeof value === "number" ? value : null;
      const current = entitlementFor(db, row.orgId, feature);
      if (current.limit === wanted) continue;

      grant(db, row.orgId, feature, wanted);
      changes.push({ orgId: row.orgId, planId: row.planId, feature, from: current.limit, to: wanted });
      writeAudit(db, {
        orgId: row.orgId,
        actorUserId: null,
        action: "entitlement.reconciled",
        entity: "entitlement",
        entityId: `${row.orgId}:${feature}`,
        detail: { plan: row.planId, from: current.limit, to: wanted },
      });
    }
  }
  return { workspaces: live.length, changes };
}

export function entitlementFor(db, orgId, feature) {
  const row = db
    .prepare("select limit_value from entitlements where organization_id = ? and feature = ?")
    .get(orgId, feature);
  if (!row) return { granted: false, limit: null };

  // Whether the subscription is currently worth honouring is decided in one place, so a paid plan
  // and a trial cannot drift apart on the same rules.
  const subscription = db
    .prepare("select * from subscriptions where organization_id = ? order by created_at desc limit 1")
    .get(orgId);

  return { granted: isPaying(subscription), limit: row.limit_value };
}

export function hasFeature(db, orgId, feature) {
  return entitlementFor(db, orgId, feature).granted;
}

/* invitations --------------------------------------------------------------- */

/**
 * Records an invitation and returns the row. Whether it was delivered is recorded separately by
 * recordInvitationDelivery, so a provider failure never loses the invitation itself. The token is
 * returned once and only its hash is stored, so a database leak does not hand somebody an
 * invitation they can accept.
 */
export function createInvitation(db, orgId, { email, role, actorUserId = null, days = 7 }) {
  const clean = normalizeEmail(email);
  if (!EMAIL_RE.test(clean)) {
    const error = new Error("That email address does not look right.");
    error.status = 400;
    throw error;
  }
  if (!isRole(role)) {
    const error = new Error(`Unknown role "${role}".`);
    error.status = 400;
    throw error;
  }

  const invitationId = id("inv");
  const token = randomBytes(24).toString("base64url");

  db.prepare(
    `insert into invitations (id, organization_id, email, role, token_hash, expires_at, accepted_at, sent_at, send_error, created_at)
     values (?, ?, ?, ?, ?, ?, null, null, null, ?)`,
  ).run(
    invitationId,
    orgId,
    clean,
    role,
    createHash("sha256").update(token).digest("hex"),
    new Date(Date.now() + days * 86_400_000).toISOString(),
    nowIso(),
  );

  writeAudit(db, {
    orgId,
    actorUserId,
    action: "member.invite",
    entity: "invitation",
    entityId: invitationId,
    meta: { email: clean, role },
  });

  return { invitationId, token, email: clean, role };
}

export function recordInvitationDelivery(db, invitationId, result) {
  db.prepare("update invitations set sent_at = ?, send_error = ? where id = ?").run(
    result.ok ? nowIso() : null,
    result.ok ? null : `${result.reason}${result.status ? ` (${result.status})` : ""}`,
    invitationId,
  );
  return { ok: result.ok };
}

/**
 * Finds an invitation by its token.
 *
 * Only the hash is stored, so this is the only way back from a token: hash the presented one and
 * look for that. Returns the state rather than a bare row, because every caller has to decide
 * between not-found, expired and already-used, and a page that conflates them tells the visitor
 * something untrue.
 */
export function findInvitationByToken(db, token, { now = Date.now() } = {}) {
  const presented = String(token ?? "").trim();
  if (!presented) return { ok: false, reason: "not_found" };

  const row = db
    .prepare(
      `select i.*, o.name as organization_name
         from invitations i
         join organizations o on o.id = i.organization_id
        where i.token_hash = ?`,
    )
    .get(createHash("sha256").update(presented).digest("hex"));

  if (!row) return { ok: false, reason: "not_found" };

  const expired = Date.parse(row.expires_at) < now;
  return {
    ok: true,
    invitationId: row.id,
    orgId: row.organization_id,
    organizationName: row.organization_name,
    email: row.email,
    role: row.role,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    expired,
    acceptable: !row.accepted_at && !expired,
  };
}

/** How many invitations are outstanding, which is how many future members are already spoken for. */
export function pendingInvitationCount(db, orgId, { now = Date.now() } = {}) {
  return db
    .prepare(
      "select count(*) as n from invitations where organization_id = ? and accepted_at is null and expires_at > ?",
    )
    .get(orgId, new Date(now).toISOString()).n;
}

/**
 * Cancels a pending invitation.
 *
 * Without this, an invitation that can never be delivered still occupies a seat until it expires, so
 * a workspace on a one-seat plan can be locked out of inviting anybody at all. The row is deleted
 * rather than flagged: an unusable invitation is not a record worth keeping, and the audit entry
 * preserves what happened.
 */
export function revokeInvitation(db, orgId, invitationId, { actorUserId = null, now = Date.now() } = {}) {
  const invitation = db
    .prepare("select * from invitations where id = ? and organization_id = ?")
    .get(invitationId, orgId);

  if (!invitation) return { ok: false, reason: "not_found" };
  if (invitation.accepted_at) return { ok: false, reason: "already_accepted" };

  db.prepare("delete from invitations where id = ?").run(invitationId);

  writeAudit(db, {
    orgId,
    actorUserId,
    action: "member.invitation_revoked",
    entity: "invitation",
    entityId: invitationId,
    meta: { email: invitation.email, role: invitation.role, at: new Date(now).toISOString() },
  });

  return { ok: true, email: invitation.email };
}

/**
 * Edits the workspace itself.
 *
 * The timezone matters more than it looks: bookings are stored in UTC and rendered through this
 * value, so a workspace left on UTC shows a clinic in Karachi the wrong appointment time by five
 * hours. Validation happens here rather than in the form, because a timezone that Intl cannot parse
 * would break every booking the workspace makes.
 */
export function updateOrganization(db, orgId, { name = null, industry = null, timezone = null, actorUserId = null } = {}) {
  const org = db.prepare("select * from organizations where id = ?").get(orgId);
  if (!org) return { ok: false, reason: "not_found" };

  const changes = {};

  if (name !== null) {
    const clean = String(name).trim();
    if (clean.length < 2 || clean.length > 80) return { ok: false, reason: "bad_name" };
    changes.name = clean;
  }

  if (industry !== null) {
    const clean = String(industry).trim().toLowerCase();
    if (clean.length > 40) return { ok: false, reason: "bad_industry" };
    changes.industry = clean || null;
  }

  if (timezone !== null) {
    const clean = String(timezone).trim();
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: clean });
    } catch {
      return { ok: false, reason: "bad_timezone" };
    }
    changes.timezone = clean;
  }

  if (!Object.keys(changes).length) return { ok: true, changed: false };

  const assignments = Object.keys(changes).map((key) => `${key} = ?`).join(", ");
  db.prepare(`update organizations set ${assignments} where id = ?`).run(...Object.values(changes), orgId);

  writeAudit(db, {
    orgId,
    actorUserId,
    action: "org.updated",
    entity: "organization",
    entityId: orgId,
    meta: changes,
  });

  return { ok: true, changed: true, changes };
}

export function listInvitations(db, orgId) {
  return db
    .prepare(
      "select id, email, role, expires_at, accepted_at, sent_at, send_error from invitations where organization_id = ? order by created_at desc",
    )
    .all(orgId);
}

/**
 * Accepts an invitation: the person joins the workspace with the role they were invited as.
 *
 * The invited address must match the account being used. A token is the kind of secret that gets
 * forwarded, screenshotted and pasted into a group chat, and joining somebody else's workspace
 * because you were shown a link is not a thing this should permit.
 *
 * Seats are the caller's business. How many people a workspace may hold is a plan limit, and that
 * check lives with the rest of the entitlement logic rather than here.
 */
export function acceptInvitation(db, token, userId, { now = Date.now() } = {}) {
  const hash = createHash("sha256").update(String(token)).digest("hex");
  const invitation = db.prepare("select * from invitations where token_hash = ?").get(hash);

  if (!invitation) return { ok: false, reason: "unknown" };
  if (invitation.accepted_at) return { ok: false, reason: "already_accepted" };
  if (Date.parse(invitation.expires_at) <= now) return { ok: false, reason: "expired" };
  if (!userId) return { ok: false, reason: "no_user" };

  const user = db.prepare("select id, email from users where id = ?").get(userId);
  if (!user) return { ok: false, reason: "no_user" };
  if (normalizeEmail(user.email) !== normalizeEmail(invitation.email)) {
    return { ok: false, reason: "wrong_account", invitedEmail: invitation.email };
  }

  // Conditional, so two clicks cannot both succeed and write two memberships and two audit entries
  // for one invitation.
  const claimed = db
    .prepare("update invitations set accepted_at = ? where id = ? and accepted_at is null")
    .run(new Date(now).toISOString(), invitation.id);
  if (claimed.changes === 0) return { ok: false, reason: "already_accepted" };

  addMember(db, invitation.organization_id, userId, invitation.role);

  const org = db.prepare("select name from organizations where id = ?").get(invitation.organization_id);

  writeAudit(db, {
    orgId: invitation.organization_id,
    actorUserId: userId,
    action: "member.accepted",
    entity: "invitation",
    entityId: invitation.id,
    meta: { role: invitation.role, email: invitation.email },
  });

  return {
    ok: true,
    orgId: invitation.organization_id,
    role: invitation.role,
    organizationName: org?.name ?? "the workspace",
  };
}
