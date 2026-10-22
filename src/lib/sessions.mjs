// Sessions.
//
// The cookie value is a signed token, so a tampered cookie is rejected without touching the
// database (guard.mjs verifyToken, already covered by its own 58 assertions). A row is also
// written to `sessions` keyed by the token's hash, because a signature alone cannot be revoked:
// logout, a stolen laptop, or a password change all need to invalidate a token that is still
// cryptographically valid.

import { createHash } from "node:crypto";
import { signToken, verifyToken, cookieValue } from "./guard.mjs";
import { SESSION_COOKIE, SESSION_SECRET, SESSION_TTL_MS } from "./config.mjs";
import { id, nowIso } from "./identities.mjs";

const tokenHash = (token) => createHash("sha256").update(String(token)).digest("hex");

export function createSession(db, { userId, orgId = null, ttlMs = SESSION_TTL_MS, now = Date.now() }) {
  const sessionId = id("ses");
  const token = signToken({ sub: userId, sid: sessionId, org: orgId }, SESSION_SECRET, {
    ttlMs,
    now,
  });

  db.prepare(
    `insert into sessions (id, user_id, org_id, token_hash, expires_at, revoked_at, created_at)
     values (?, ?, ?, ?, ?, null, ?)`,
  ).run(sessionId, userId, orgId, tokenHash(token), new Date(now + ttlMs).toISOString(), nowIso());

  return { sessionId, token, expiresAt: new Date(now + ttlMs).toISOString() };
}

// Returns { ok: false, reason } rather than throwing, so a route can turn it into a 401 without
// a try block, and so no caller is tempted to treat an exception as "probably fine".
export function verifySession(db, token, { now = Date.now() } = {}) {
  if (!token) return { ok: false, reason: "missing" };

  const signed = verifyToken(token, SESSION_SECRET, { now });
  if (!signed.ok) return { ok: false, reason: signed.reason };

  const row = db
    .prepare("select * from sessions where token_hash = ?")
    .get(tokenHash(token));

  if (!row) return { ok: false, reason: "unknown" };
  if (row.revoked_at) return { ok: false, reason: "revoked" };
  if (Date.parse(row.expires_at) <= now) return { ok: false, reason: "expired" };

  const user = db.prepare("select * from users where id = ?").get(row.user_id);
  if (!user) return { ok: false, reason: "no_user" };

  const membership = row.org_id
    ? db
        .prepare("select role from memberships where organization_id = ? and user_id = ?")
        .get(row.org_id, user.id)
    : null;

  // A session pointing at an organisation the user has since been removed from must not keep
  // working just because the cookie is still valid.
  if (row.org_id && !membership) return { ok: false, reason: "no_membership" };

  return {
    ok: true,
    session: row,
    user,
    orgId: row.org_id,
    role: membership?.role ?? null,
  };
}

export function sessionFromRequest(request, db) {
  return verifySession(db, cookieValue(request, SESSION_COOKIE));
}

export function revokeSession(db, token, { now = Date.now() } = {}) {
  const result = db
    .prepare("update sessions set revoked_at = ? where token_hash = ? and revoked_at is null")
    .run(new Date(now).toISOString(), tokenHash(token));
  return result.changes;
}

// Used on password change: one token should not survive it.
export function revokeAllSessionsForUser(db, userId, { now = Date.now() } = {}) {
  const result = db
    .prepare("update sessions set revoked_at = ? where user_id = ? and revoked_at is null")
    .run(new Date(now).toISOString(), userId);
  return result.changes;
}

export function switchOrg(db, sessionId, orgId) {
  const session = db.prepare("select user_id from sessions where id = ?").get(sessionId);
  if (!session) return { ok: false, reason: "unknown" };

  const member = db
    .prepare("select role from memberships where organization_id = ? and user_id = ?")
    .get(orgId, session.user_id);
  if (!member) return { ok: false, reason: "not_a_member" };

  db.prepare("update sessions set org_id = ? where id = ?").run(orgId, sessionId);
  return { ok: true, role: member.role };
}
