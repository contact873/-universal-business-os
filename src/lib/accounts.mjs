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

export function listInvitations(db, orgId) {
  return db
    .prepare(
      "select id, email, role, expires_at, accepted_at, sent_at, send_error from invitations where organization_id = ? order by created_at desc",
    )
    .all(orgId);
}

export function acceptInvitation(db, token, userId, { now = Date.now() } = {}) {
  const hash = createHash("sha256").update(String(token)).digest("hex");
  const invitation = db.prepare("select * from invitations where token_hash = ?").get(hash);

  if (!invitation) return { ok: false, reason: "unknown" };
  if (invitation.accepted_at) return { ok: false, reason: "already_accepted" };
  if (Date.parse(invitation.expires_at) <= now) return { ok: false, reason: "expired" };

  addMember(db, invitation.organization_id, userId, invitation.role);
  db.prepare("update invitations set accepted_at = ? where id = ?").run(nowIso(), invitation.id);

  writeAudit(db, {
    orgId: invitation.organization_id,
    actorUserId: userId,
    action: "member.accepted",
    entity: "invitation",
    entityId: invitation.id,
    meta: { role: invitation.role },
  });

  return { ok: true, orgId: invitation.organization_id, role: invitation.role };
}
