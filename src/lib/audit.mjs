// Audit trail.
//
// responsible-ai and the blueprint both require that a disputed or consequential action can be
// reconstructed afterwards. Every mutation in src/lib/tenant.mjs writes one row here.
//
// What is deliberately NOT written: passwords, session tokens, API keys, raw identity values.
// A redaction pass runs over the meta object so that a future caller who passes a whole request
// body by accident does not store a credential in an audit table that many people can read.

import { id, nowIso } from "./identities.mjs";

const REDACT = /pass|secret|token|key|authorization|cookie/i;

export function redact(value, depth = 0) {
  if (depth > 4) return "[deep]";
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = REDACT.test(k) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

export function writeAudit(db, entry) {
  const auditId = id("aud");
  db.prepare(
    `insert into audit_logs
       (id, organization_id, actor_user_id, action, entity, entity_id, meta_json, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    auditId,
    entry.orgId ?? null,
    entry.actorUserId ?? null,
    String(entry.action),
    entry.entity ?? null,
    entry.entityId ?? null,
    entry.meta ? JSON.stringify(redact(entry.meta)) : null,
    nowIso(),
  );
  return auditId;
}

export function listAudit(db, orgId, { limit = 100 } = {}) {
  return db
    .prepare(
      `select a.id, a.action, a.entity, a.entity_id, a.meta_json, a.created_at,
              u.email as actor_email
         from audit_logs a
         left join users u on u.id = a.actor_user_id
        where a.organization_id = ?
        order by a.created_at desc
        limit ?`,
    )
    .all(orgId, limit);
}
