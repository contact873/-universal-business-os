#!/usr/bin/env node
// The audience database: people from any channel, identified by email, phone or social handle,
// tagged into audience categories, with consent, attribution and erasure. No dependencies.
//
//   node lead-store.mjs migrate <db>
//   node lead-store.mjs add     <db> '{"name":"Ali","phone":"0300 123 4567","email":"a@b.co","audience":"med-spa","tags":["dubai"],"source":"instagram"}'
//   node lead-store.mjs audience <db> [--tag dubai] [--channel phone]
//   node lead-store.mjs stats   <db>
//   node lead-store.mjs export  <db> --channel email|phone [--tag x] [--purpose marketing|transactional]
//   node lead-store.mjs erase   <db> <email|phone|handle>
//   node lead-store.mjs --selftest

import { createHash } from "node:crypto";

/* ------------------------------------------------------------------ quiet the experimental warning */

const realEmit = process.emitWarning.bind(process);
process.emitWarning = (w, ...rest) => {
  const msg = typeof w === "string" ? w : (w && w.message) || "";
  if (/SQLite is an experimental feature/i.test(msg)) return;
  return realEmit(w, ...rest);
};

let DatabaseSync = null;
async function loaded() {
  if (!DatabaseSync) ({ DatabaseSync } = await import("node:sqlite"));
  return DatabaseSync;
}

/* ------------------------------------------------------------------ identity normalisation */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const id = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
export const nowIso = () => new Date().toISOString();
const iso = nowIso;
const sha = (s) => createHash("sha256").update(s).digest("hex");

export const normalizeEmail = (email) => String(email ?? "").trim().toLowerCase();

/** Strip a handle down to something matchable, from a bare @name or a full profile URL. */
export function normalizeHandle(kind, value) {
  let s = String(value ?? "").trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "").replace(/^www\./, "");
  const strip = {
    instagram: ["instagram.com/", "ig.me/"],
    facebook: ["facebook.com/", "fb.com/", "fb.me/", "m.me/"],
    linkedin: ["linkedin.com/in/", "linkedin.com/company/", "linkedin.com/"],
    telegram: ["t.me/", "telegram.me/"],
    x: ["x.com/", "twitter.com/"],
    whatsapp: ["wa.me/", "api.whatsapp.com/send?phone="],
  }[kind] ?? [];
  for (const p of strip) if (s.startsWith(p)) s = s.slice(p.length);
  s = s.split("?")[0].split("#")[0].replace(/\/+$/, "");
  return s.replace(/^@+/, "").trim();
}

/**
 * Normalise a phone number to international form. Returns { ok, value, reason, needsReview }.
 * Store the raw value too: this is the identity, the raw is what a human reads back.
 */
export function normalizePhone(value, { defaultCountry = null } = {}) {
  let s = String(value ?? "").trim();
  if (!s) return { ok: false, reason: "empty" };

  // keep digits and a leading plus only
  s = s.replace(/[^\d+]/g, "");
  if (s.includes("+") && !s.startsWith("+")) s = s.replace(/\+/g, "");

  let needsReview = false;
  if (s.startsWith("00")) s = `+${s.slice(2)}`;

  let subscriber = null;
  if (!s.startsWith("+")) {
    const cc = defaultCountry ? String(defaultCountry).replace(/[^\d]/g, "") : null;
    if (cc && s.startsWith(cc)) s = `+${s}`;
    else if (cc && s.startsWith("0")) { subscriber = s.slice(1); s = `+${cc}${subscriber}`; }
    else if (cc) { subscriber = s; s = `+${cc}${s}`; }
    else { s = `+${s}`; needsReview = true; }   // no country known: consistent, but flagged
  }

  // Check the subscriber part, not just the total. "12345" plus a country code is 7 digits and looks
  // plausible, but a 5 digit national number is not a phone number.
  if (subscriber !== null && (subscriber.length < 6 || subscriber.length > 12)) {
    return { ok: false, reason: "implausible_length", digits: subscriber.length };
  }

  const digits = s.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return { ok: false, reason: "implausible_length", digits: digits.length };
  return { ok: true, value: `+${digits}`, needsReview };
}

const INPUT_KINDS = {
  email: "email", phone: "phone", mobile: "phone", telephone: "phone", tel: "phone",
  whatsapp: "whatsapp", instagram: "instagram", facebook: "facebook",
  linkedin: "linkedin", telegram: "telegram", x: "x", twitter: "x",
};

/** Turn a form submission into one or more identities. A person may arrive with several. */
export function extractIdentities(submission = {}, { defaultCountry = null } = {}) {
  const out = [];
  const errors = [];
  const seen = new Set();

  for (const [field, kind] of Object.entries(INPUT_KINDS)) {
    const raw = submission[field];
    if (raw === undefined || raw === null || String(raw).trim() === "") continue;
    const label = ["mobile", "telephone", "tel"].includes(field) ? "mobile" : kind;

    let ident = null;

    if (kind === "email") {
      const v = normalizeEmail(raw);
      if (!EMAIL_RE.test(v)) { errors.push({ code: "format", field, message: "That email address does not look right." }); continue; }
      ident = { kind: "email", value_raw: String(raw).trim(), value_normalized: v, label: null, needs_review: 0 };
    } else if (kind === "phone" || kind === "whatsapp") {
      // A WhatsApp URL carrying a number is a phone number, so it matches the same person's phone
      // identity from the contact form instead of becoming an unmatchable handle.
      const stripped = String(raw).trim()
        .replace(/^https?:\/\//i, "")
        .replace(/^wa\.me\//i, "")
        .replace(/^api\.whatsapp\.com\/send\?phone=/i, "")
        .replace(/^web\.whatsapp\.com\/send\?phone=/i, "");
      const isNumeric = /^[\d\s()+-]+$/.test(stripped);

      if (kind === "whatsapp" && !isNumeric) {
        const v = normalizeHandle("whatsapp", raw);
        if (!v) { errors.push({ code: "format", field, message: "That WhatsApp handle does not look right." }); continue; }
        ident = { kind: "whatsapp", value_raw: String(raw).trim(), value_normalized: v, label: null, needs_review: 0 };
      } else {
        const p = normalizePhone(stripped, { defaultCountry });
        if (!p.ok) { errors.push({ code: "format", field, message: "That phone number does not look right." }); continue; }
        ident = { kind: "phone", value_raw: String(raw).trim(), value_normalized: p.value, label: kind === "whatsapp" ? "whatsapp" : label, needs_review: p.needsReview ? 1 : 0 };
      }
    } else {
      const v = normalizeHandle(kind, raw);
      if (!v) { errors.push({ code: "format", field, message: `That ${kind} handle does not look right.` }); continue; }
      ident = { kind, value_raw: String(raw).trim(), value_normalized: v, label: null, needs_review: 0 };
    }

    const key = `${ident.kind}|${ident.value_normalized}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ident);
  }

  return { identities: out, errors };
}

export const identityHash = (kind, valueNormalized) => sha(`${kind}:${valueNormalized}`).slice(0, 32);

const tableExists = (db, name) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);

/** The v1 hash, so an erasure made before the upgrade is still honoured afterwards. */
const legacyEmailHash = (normalized) => sha(normalized).slice(0, 32);

/* ------------------------------------------------------------------ schema */

const SCHEMA_VERSION = 2;

export function migrate(db) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT)");
  const current = Number(db.prepare("SELECT value FROM schema_meta WHERE key='version'").get()?.value ?? 0);
  const exists = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='contacts'").get();

  if (!exists) {
    createV2(db);
  } else if (current < 2) {
    const cols = db.prepare("PRAGMA table_info(contacts)").all().map((c) => c.name);
    if (cols.includes("email_normalized")) upgradeV1toV2(db);
    else createV2(db);
  } else {
    createV2(db);
  }

  db.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', ?)").run(String(SCHEMA_VERSION));
  ensureColumns(db);
  return db;
}

/**
 * CREATE TABLE IF NOT EXISTS does not evolve a table that already exists, so every column added after
 * a table was first created needs an explicit, idempotent ALTER. This is the expand step from the
 * deployment skill, applied on every boot.
 */
function ensureColumns(db) {
  const add = (table, column, ddl) => {
    if (!tableExists(db, table)) return;
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  };
  add("submissions", "channel", "channel TEXT NOT NULL DEFAULT 'website'");
  add("submissions", "payload_hash", "payload_hash TEXT");
  add("contact_identities", "needs_review", "needs_review INTEGER NOT NULL DEFAULT 0");
  add("contacts", "language", "language TEXT");
  add("contacts", "country", "country TEXT");
  add("contacts", "consent_channel", "consent_channel TEXT");
}

function createV2(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      id              TEXT PRIMARY KEY,
      name            TEXT,
      company         TEXT,
      audience        TEXT,
      language        TEXT,
      country         TEXT,
      source          TEXT,
      utm_source      TEXT,
      utm_medium      TEXT,
      utm_campaign    TEXT,
      landing_page    TEXT,
      referrer        TEXT,
      consent_at      TEXT,
      consent_version TEXT,
      consent_text    TEXT,
      consent_channel TEXT,
      first_seen_at   TEXT NOT NULL,
      last_seen_at    TEXT NOT NULL,
      submissions     INTEGER NOT NULL DEFAULT 1,
      status          TEXT NOT NULL DEFAULT 'active'
    );

    CREATE TABLE IF NOT EXISTS contact_identities (
      id               TEXT PRIMARY KEY,
      contact_id       TEXT NOT NULL REFERENCES contacts(id),
      kind             TEXT NOT NULL,
      value_raw        TEXT NOT NULL,
      value_normalized TEXT NOT NULL,
      label            TEXT,
      needs_review     INTEGER NOT NULL DEFAULT 0,
      first_seen_at    TEXT NOT NULL,
      UNIQUE (kind, value_normalized)
    );

    CREATE TABLE IF NOT EXISTS contact_tags (
      contact_id TEXT NOT NULL REFERENCES contacts(id),
      tag        TEXT NOT NULL,
      added_at   TEXT NOT NULL,
      PRIMARY KEY (contact_id, tag)
    );

    CREATE TABLE IF NOT EXISTS submissions (
      id             TEXT PRIMARY KEY,
      contact_id     TEXT NOT NULL REFERENCES contacts(id),
      form_id        TEXT NOT NULL,
      channel        TEXT NOT NULL DEFAULT 'website',
      submission_key TEXT NOT NULL UNIQUE,
      payload_hash   TEXT,
      message        TEXT,
      audience       TEXT,
      utm_source     TEXT,
      utm_medium     TEXT,
      utm_campaign   TEXT,
      utm_content    TEXT,
      utm_term       TEXT,
      landing_page   TEXT,
      referrer       TEXT,
      created_at     TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS email_log (
      id            TEXT PRIMARY KEY,
      submission_id TEXT NOT NULL REFERENCES submissions(id),
      status        TEXT NOT NULL,
      provider      TEXT,
      error         TEXT,
      attempted_at  TEXT NOT NULL,
      sent_at       TEXT
    );

    CREATE TABLE IF NOT EXISTS suppressions (
      identity_hash TEXT PRIMARY KEY,
      erased_at     TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS identity_conflicts (
      id                  TEXT PRIMARY KEY,
      identity_kind       TEXT NOT NULL,
      identity_normalized TEXT NOT NULL,
      kept_contact_id     TEXT NOT NULL,
      other_contact_id    TEXT NOT NULL,
      detected_at         TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_log (
      id          TEXT PRIMARY KEY,
      contact_id  TEXT NOT NULL,
      provider    TEXT NOT NULL,
      channel     TEXT NOT NULL,
      external_id TEXT,
      status      TEXT NOT NULL,
      error       TEXT,
      synced_at   TEXT NOT NULL,
      UNIQUE (contact_id, provider, channel)
    );

    CREATE INDEX IF NOT EXISTS idx_sync_provider ON sync_log(provider, channel, status);

    CREATE INDEX IF NOT EXISTS idx_identities_contact ON contact_identities(contact_id);
    CREATE INDEX IF NOT EXISTS idx_tags_tag           ON contact_tags(tag);
    CREATE INDEX IF NOT EXISTS idx_submissions_contact ON submissions(contact_id);
    CREATE INDEX IF NOT EXISTS idx_submissions_dedupe  ON submissions(contact_id, form_id, payload_hash, created_at);
    CREATE INDEX IF NOT EXISTS idx_email_log_status    ON email_log(status);
    CREATE INDEX IF NOT EXISTS idx_contacts_audience   ON contacts(audience);

    DROP VIEW IF EXISTS v_audience;
    CREATE VIEW v_audience AS
      SELECT c.id, c.name, c.company, c.audience, c.country, c.source,
             c.consent_at, c.first_seen_at, c.last_seen_at, c.submissions, c.status,
             (SELECT value_raw FROM contact_identities i WHERE i.contact_id = c.id AND i.kind='email' LIMIT 1) AS email,
             (SELECT value_raw FROM contact_identities i WHERE i.contact_id = c.id AND i.kind='phone' LIMIT 1) AS phone,
             (SELECT group_concat(tag, ',') FROM contact_tags t WHERE t.contact_id = c.id) AS tags
      FROM contacts c;
  `);
  return db;
}

/** v1 keyed the person on a NOT NULL UNIQUE email. Rebuild to the identity model, preserving rows. */
function upgradeV1toV2(db) {
  const legacy = db.prepare("SELECT id, email, email_normalized FROM contacts").all();
  const now = iso();

  // v1's suppressions table has email_hash, and CREATE TABLE IF NOT EXISTS would silently skip it,
  // leaving the first capture after the upgrade reading a column that does not exist. Rename it and
  // keep checking it, so an erasure made before the upgrade is still honoured.
  if (tableExists(db, "suppressions")) {
    const cols = db.prepare("PRAGMA table_info(suppressions)").all().map((c) => c.name);
    if (cols.includes("email_hash") && !cols.includes("identity_hash")) {
      db.exec("ALTER TABLE suppressions RENAME TO suppressions_legacy");
    }
  }

  db.exec("PRAGMA foreign_keys=OFF");
  db.exec("BEGIN");
  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts_v2 (
      id TEXT PRIMARY KEY, name TEXT, company TEXT, audience TEXT, language TEXT, country TEXT,
      source TEXT, utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, landing_page TEXT, referrer TEXT,
      consent_at TEXT, consent_version TEXT, consent_text TEXT, consent_channel TEXT,
      first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
      submissions INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'active'
    );
  `);
  db.exec(`INSERT INTO contacts_v2 (
      id, name, company, audience, source, utm_source, utm_medium, utm_campaign, landing_page, referrer,
      consent_at, consent_version, consent_text, first_seen_at, last_seen_at, submissions, status)
    SELECT id, name, company, audience, source, utm_source, utm_medium, utm_campaign, landing_page, referrer,
      consent_at, consent_version, consent_text, first_seen_at, last_seen_at, submissions, status FROM contacts`);
  db.exec("DROP TABLE contacts");
  db.exec("ALTER TABLE contacts_v2 RENAME TO contacts");
  db.exec("COMMIT");
  db.exec("PRAGMA foreign_keys=ON");

  createV2(db);

  const ins = db.prepare("INSERT OR IGNORE INTO contact_identities (id, contact_id, kind, value_raw, value_normalized, first_seen_at) VALUES (?,?,?,?,?,?)");
  for (const row of legacy) {
    if (row.email_normalized) ins.run(id("idn"), row.id, "email", row.email ?? row.email_normalized, row.email_normalized, now);
  }
  return { upgraded: legacy.length };
}

/** What makes one submission different from another: the content, not the clock. */
export function payloadHashOf(formId, identities, submission) {
  const parts = [
    formId,
    identities.map((i) => `${i.kind}=${i.value_normalized}`).sort().join(","),
    submission.message ?? "", submission.audience ?? "",
    submission.utm_source ?? "", submission.utm_campaign ?? "",
  ];
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 16);
}

const DEDUPE_WINDOW_MS = 120_000;

/* ------------------------------------------------------------------ capture */

export function capture(db, submission = {}, { now = iso, defaultCountry = null, dedupeWindowMs = DEDUPE_WINDOW_MS } = {}) {
  const { identities, errors } = extractIdentities(submission, { defaultCountry });
  if (!identities.length) {
    const first = errors[0];
    return {
      ok: false,
      errors: first ? [first] : [{ code: "required", field: "email", message: "Give us an email address, a phone number, or a social handle so we can reply." }],
    };
  }
  if (errors.length) return { ok: false, errors };

  const at = now();
  const formId = submission.formId ?? "form";
  const channel = submission.channel ?? submission.source ?? "website";
  const legacySuppressions = tableExists(db, "suppressions_legacy");

  // An erased person is never silently recreated, on any of their identities.
  for (const ident of identities) {
    if (db.prepare("SELECT 1 AS x FROM suppressions WHERE identity_hash = ?").get(identityHash(ident.kind, ident.value_normalized))) {
      return { ok: true, suppressed: true, created: false, replayed: false, contactId: null, submissionId: null };
    }
  }

  // Erasures made before the schema upgrade used the old email hash, and must still be honoured.
  if (legacySuppressions) {
    for (const ident of identities) {
      if (ident.kind !== "email") continue;
      if (db.prepare("SELECT 1 AS x FROM suppressions_legacy WHERE email_hash = ?").get(legacyEmailHash(ident.value_normalized))) {
        return { ok: true, suppressed: true, created: false, replayed: false, contactId: null, submissionId: null };
      }
    }
  }

  const payloadHash = payloadHashOf(formId, identities, submission);

  let key = submission.submissionKey ?? null;
  if (key) {
    const already = db.prepare("SELECT id, contact_id FROM submissions WHERE submission_key = ?").get(key);
    if (already) return { ok: true, replayed: true, created: false, contactId: already.contact_id, submissionId: already.id };
  }

  // Resolve the person by ANY matching identity, and record a conflict rather than guessing a merge.
  const hits = new Map();
  for (const ident of identities) {
    const row = db.prepare("SELECT contact_id FROM contact_identities WHERE kind = ? AND value_normalized = ?").get(ident.kind, ident.value_normalized);
    if (row) hits.set(row.contact_id, (hits.get(row.contact_id) ?? 0) + 1);
  }
  let conflict = false;
  let contactId = null;
  if (hits.size) {
    const ranked = [...hits.entries()].sort((a, b) => b[1] - a[1]);
    contactId = ranked[0][0];
    if (ranked.length > 1) {
      conflict = true;
      for (const [otherId] of ranked.slice(1)) {
        db.prepare(`INSERT INTO identity_conflicts (id, identity_kind, identity_normalized, kept_contact_id, other_contact_id, detected_at)
                    VALUES (?,?,?,?,?,?)`)
          .run(id("cf"), identities[0].kind, identities[0].value_normalized, contactId, otherId, at);
      }
    }
  }

  if (!key) {
    const since = new Date(Date.parse(at) - dedupeWindowMs).toISOString();
    const within = db.prepare(`SELECT id, contact_id FROM submissions
        WHERE contact_id = ? AND form_id = ? AND payload_hash = ? AND created_at >= ?
        ORDER BY created_at DESC LIMIT 1`).get(contactId ?? "", formId, payloadHash, since);
    if (contactId && within) return { ok: true, replayed: true, created: false, contactId: within.contact_id, submissionId: within.id };
    key = `${formId}|${payloadHash}|${at}`;
  }

  let created = false;
  if (contactId) {
    db.prepare(`UPDATE contacts SET
        last_seen_at = ?, submissions = submissions + 1,
        name = COALESCE(?, name), company = COALESCE(?, company),
        audience = COALESCE(?, audience), country = COALESCE(?, country),
        consent_at = COALESCE(consent_at, ?), consent_version = COALESCE(consent_version, ?),
        consent_text = COALESCE(consent_text, ?), consent_channel = COALESCE(consent_channel, ?)
      WHERE id = ?`)
      .run(at, submission.name ?? null, submission.company ?? null, submission.audience ?? null, submission.country ?? null,
        submission.consent ? at : null, submission.consentVersion ?? null, submission.consentText ?? null, submission.consentChannel ?? channel,
        contactId);
  } else {
    created = true;
    contactId = id("ct");
    db.prepare(`INSERT INTO contacts (
        id, name, company, audience, language, country, source,
        utm_source, utm_medium, utm_campaign, landing_page, referrer,
        consent_at, consent_version, consent_text, consent_channel, first_seen_at, last_seen_at, submissions, status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,'active')`)
      .run(contactId, submission.name ?? null, submission.company ?? null, submission.audience ?? null,
        submission.language ?? null, submission.country ?? null, channel,
        submission.utm_source ?? null, submission.utm_medium ?? null, submission.utm_campaign ?? null,
        submission.landing_page ?? null, submission.referrer ?? null,
        submission.consent ? at : null, submission.consentVersion ?? null,
        submission.consentText ?? null, submission.consent ? (submission.consentChannel ?? channel) : null,
        at, at);
  }

  // Attach identities. An existing identity on another contact is never stolen.
  const insIdent = db.prepare(`INSERT OR IGNORE INTO contact_identities
      (id, contact_id, kind, value_raw, value_normalized, label, needs_review, first_seen_at) VALUES (?,?,?,?,?,?,?,?)`);
  for (const ident of identities) {
    insIdent.run(id("idn"), contactId, ident.kind, ident.value_raw, ident.value_normalized, ident.label ?? null, ident.needs_review ?? 0, at);
  }

  // Audience categories are tags, so a person can be in several.
  const tags = new Set([...(Array.isArray(submission.tags) ? submission.tags : []), ...(submission.audience ? [submission.audience] : [])]);
  const insTag = db.prepare("INSERT OR IGNORE INTO contact_tags (contact_id, tag, added_at) VALUES (?,?,?)");
  for (const t of tags) if (t) insTag.run(contactId, String(t).trim().toLowerCase(), at);

  const submissionId = id("sub");
  db.prepare(`INSERT INTO submissions (
      id, contact_id, form_id, channel, submission_key, payload_hash, message, audience,
      utm_source, utm_medium, utm_campaign, utm_content, utm_term, landing_page, referrer, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(submissionId, contactId, formId, channel, key, payloadHash, submission.message ?? null, submission.audience ?? null,
      submission.utm_source ?? null, submission.utm_medium ?? null, submission.utm_campaign ?? null,
      submission.utm_content ?? null, submission.utm_term ?? null,
      submission.landing_page ?? null, submission.referrer ?? null, at);

  return { ok: true, created, replayed: false, suppressed: false, conflict, contactId, submissionId, identities };
}

/* ------------------------------------------------------------------ the send half */

export function queueSend(db, submissionId, { provider = null, now = iso } = {}) {
  const logId = id("em");
  db.prepare("INSERT INTO email_log (id, submission_id, status, provider, attempted_at) VALUES (?,?,'queued',?,?)").run(logId, submissionId, provider, now());
  return logId;
}
export const markSent = (db, submissionId, { now = iso } = {}) =>
  db.prepare("UPDATE email_log SET status='sent', sent_at=?, error=NULL WHERE submission_id=? AND status='queued'").run(now(), submissionId).changes;
export const markFailed = (db, submissionId, error, { now = iso } = {}) =>
  db.prepare("UPDATE email_log SET status='failed', error=?, attempted_at=? WHERE submission_id=? AND status='queued'").run(String(error).slice(0, 300), now(), submissionId).changes;

export function pendingSends(db, { limit = 50 } = {}) {
  return db.prepare(`SELECT e.id, e.submission_id, e.status, s.form_id, s.created_at,
      (SELECT value_raw FROM contact_identities i WHERE i.contact_id = s.contact_id AND i.kind='email' LIMIT 1) AS email
    FROM email_log e JOIN submissions s ON s.id = e.submission_id
    WHERE e.status IN ('queued','failed') ORDER BY s.created_at LIMIT ?`).all(limit);
}

/* ------------------------------------------------------------------ reading and segmenting */

export function listAudience(db, { tag = null, channel = null, status = "active", limit = 200 } = {}) {
  return db.prepare(`SELECT * FROM v_audience v
      WHERE v.status = ?
        AND (? IS NULL OR EXISTS (SELECT 1 FROM contact_tags t WHERE t.contact_id = v.id AND t.tag = ?))
        AND (? IS NULL OR EXISTS (SELECT 1 FROM contact_identities i WHERE i.contact_id = v.id AND i.kind = ?))
      ORDER BY v.last_seen_at DESC LIMIT ?`).all(status, tag, tag, channel, channel, limit);
}

export function stats(db) {
  const contacts = db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE status <> 'erased'").get().n;
  const identityKinds = db.prepare(`SELECT kind, COUNT(*) AS n FROM contact_identities
      WHERE contact_id IN (SELECT id FROM contacts WHERE status <> 'erased') GROUP BY kind ORDER BY n DESC`).all();
  const byTag = db.prepare(`SELECT tag, COUNT(*) AS contacts FROM contact_tags
      WHERE contact_id IN (SELECT id FROM contacts WHERE status <> 'erased') GROUP BY tag ORDER BY contacts DESC`).all();
  const byChannel = db.prepare(`SELECT COALESCE(source,'(unknown)') AS channel, COUNT(*) AS contacts
      FROM contacts WHERE status <> 'erased' GROUP BY source ORDER BY contacts DESC`).all();
  const consented = db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE status <> 'erased' AND consent_at IS NOT NULL").get().n;
  const reachableEmail = db.prepare(`SELECT COUNT(DISTINCT contact_id) AS n FROM contact_identities
      WHERE kind='email' AND contact_id IN (SELECT id FROM contacts WHERE status <> 'erased')`).get().n;
  const reachablePhone = db.prepare(`SELECT COUNT(DISTINCT contact_id) AS n FROM contact_identities
      WHERE kind IN ('phone','whatsapp') AND contact_id IN (SELECT id FROM contacts WHERE status <> 'erased')`).get().n;
  const phoneOnly = db.prepare(`SELECT COUNT(*) AS n FROM contacts c WHERE c.status <> 'erased'
      AND EXISTS (SELECT 1 FROM contact_identities i WHERE i.contact_id = c.id AND i.kind IN ('phone','whatsapp'))
      AND NOT EXISTS (SELECT 1 FROM contact_identities i WHERE i.contact_id = c.id AND i.kind='email')`).get().n;
  const conflicts = db.prepare("SELECT COUNT(*) AS n FROM identity_conflicts").get().n;
  const submissions = db.prepare("SELECT COUNT(*) AS n FROM submissions").get().n;
  return {
    contacts, submissions, duplicatesCollapsed: Math.max(0, submissions - contacts),
    consented, reachableEmail, reachablePhone, phoneOnly, conflicts, identityKinds, byTag, byChannel,
    sends: db.prepare("SELECT status, COUNT(*) AS n FROM email_log GROUP BY status").all(),
  };
}

/**
 * Export a list for contacting. Marketing exports include only consented contacts, because consent to
 * email is not consent to call, and neither is consent to be messaged.
 */
export function exportAudience(db, { channel = "email", tag = null, purpose = "marketing", limit = 100000 } = {}) {
  const where = channel === "email"
    ? "i.kind = 'email'"
    : "i.kind IN ('phone','whatsapp')";
  const consentClause = purpose === "marketing" ? "AND c.consent_at IS NOT NULL" : "";
  const tagClause = tag ? "AND EXISTS (SELECT 1 FROM contact_tags t WHERE t.contact_id = c.id AND t.tag = ?)" : "";

  const rows = db.prepare(`SELECT DISTINCT c.id, c.name, c.company, c.audience, c.country,
        i.value_raw AS value, i.value_normalized, i.label, c.consent_at, c.consent_channel, c.source
      FROM contacts c JOIN contact_identities i ON i.contact_id = c.id
      WHERE ${where} AND c.status = 'active' ${consentClause} ${tagClause}
      ORDER BY c.first_seen_at LIMIT ?`).all(...(tag ? [tag, limit] : [limit]));

  const cols = ["name", "company", "audience", "country", "value", "value_normalized", "label", "consent_at", "consent_channel", "source"];
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return { rows, csv: [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n") };
}

/* ------------------------------------------------------------------ erasure */

export function eraseContact(db, identifier, { now = iso } = {}) {
  const at = now();
  let normalized = normalizeEmail(identifier);
  let kind = "email";
  if (!EMAIL_RE.test(normalized)) {
    const p = normalizePhone(identifier);
    if (p.ok) { kind = "phone"; normalized = p.value; }
    else { kind = null; normalized = normalizeHandle("instagram", identifier); }
  }

  const found = kind
    ? db.prepare("SELECT contact_id FROM contact_identities WHERE kind = ? AND value_normalized = ?").get(kind, normalized)
    : null;
  if (!found) return { erased: false };

  const ids = db.prepare("SELECT kind, value_normalized, value_raw FROM contact_identities WHERE contact_id = ?").all(found.contact_id);
  const ins = db.prepare("INSERT OR REPLACE INTO suppressions (identity_hash, erased_at) VALUES (?,?)");
  for (const i of ids) ins.run(identityHash(i.kind, i.value_normalized), at);

  db.prepare(`UPDATE contacts SET status='erased', name=NULL, company=NULL, country=NULL,
      utm_source=NULL, utm_medium=NULL, utm_campaign=NULL, referrer=NULL WHERE id = ?`).run(found.contact_id);

  // Identity values are anonymised in place: the suppression hash is what honours the request later.
  for (const i of ids) {
    db.prepare("UPDATE contact_identities SET value_raw = ?, value_normalized = ? WHERE contact_id = ? AND kind = ? AND value_normalized = ?")
      .run(`erased+${identityHash(i.kind, i.value_normalized)}@invalid`, `erased+${identityHash(i.kind, i.value_normalized)}@invalid`, found.contact_id, i.kind, i.value_normalized);
  }
  db.prepare("UPDATE submissions SET message = NULL WHERE contact_id = ?").run(found.contact_id);
  db.prepare("DELETE FROM contact_tags WHERE contact_id = ?").run(found.contact_id);

  return { erased: true, contactId: found.contact_id, identities: ids.length };
}

/* ------------------------------------------------------------------ selftest */

async function selftest() {
  const S = await loaded();
  let pass = 0, fail = 0;
  const t = (n, c, got) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n} (got ${JSON.stringify(got)})`); } };
  console.log("\n  selftest\n");

  /* normalisation */
  t("email is lowercased and trimmed", normalizeEmail(" Ali@Example.COM ") === "ali@example.com");
  t("a Pakistani mobile in local form becomes international", normalizePhone("0300 123 4567", { defaultCountry: "+92" }).value === "+923001234567", normalizePhone("0300 123 4567", { defaultCountry: "+92" }));
  t("a number already carrying the country code is not doubled", normalizePhone("923001234567", { defaultCountry: "+92" }).value === "+923001234567");
  t("an international number passes through", normalizePhone("+971 50 123 4567").value === "+971501234567");
  t("00 becomes plus", normalizePhone("00923001234567").value === "+923001234567");
  t("dashes, dots and brackets are stripped", normalizePhone("(0300) 123-4567", { defaultCountry: "+92" }).value === "+923001234567");
  t("a too-short number is rejected", normalizePhone("12345", { defaultCountry: "+92" }).ok === false);
  t("a too-long number is rejected", normalizePhone("1".repeat(20), { defaultCountry: "+92" }).ok === false);
  t("no country code is flagged for review", normalizePhone("03001234567").needsReview === true, normalizePhone("03001234567"));
  t("an empty phone is rejected", normalizePhone("  ").ok === false);
  t("an instagram URL becomes a handle", normalizeHandle("instagram", "https://instagram.com/Glow.Clinic/?hl=en") === "glow.clinic");
  t("a bare @handle becomes a handle", normalizeHandle("instagram", "@GlowClinic") === "glowclinic");
  t("a linkedin URL becomes a handle", normalizeHandle("linkedin", "https://www.linkedin.com/in/Layla-Haddad/") === "layla-haddad");
  t("a facebook page URL becomes a handle", normalizeHandle("facebook", "facebook.com/GlowClinicQA") === "glowclinicqa");

  /* identity extraction */
  const many = extractIdentities({ email: "A@B.CO", phone: "0300 123 4567", instagram: "@glow", facebook: "facebook.com/glow" }, { defaultCountry: "+92" });
  t("extracts every identity given", many.identities.length === 4, many.identities.map((i) => i.kind));
  t("a mobile field maps to a phone identity", extractIdentities({ mobile: "03001234567" }, { defaultCountry: "+92" }).identities[0].kind === "phone");
  t("the label records that it was given as a mobile", extractIdentities({ mobile: "03001234567" }, { defaultCountry: "+92" }).identities[0].label === "mobile");
  t("a numeric WhatsApp value becomes a phone identity", extractIdentities({ whatsapp: "wa.me/923001234567" }, { defaultCountry: "+92" }).identities[0].kind === "phone", extractIdentities({ whatsapp: "wa.me/923001234567" }, { defaultCountry: "+92" }).identities);
  t("a non-numeric WhatsApp value stays a handle", extractIdentities({ whatsapp: "@glow" }).identities[0].kind === "whatsapp");
  t("a bad email is reported, not silently dropped", extractIdentities({ email: "nope" }).errors[0].field === "email");
  t("a duplicate identity in one payload is collapsed", extractIdentities({ email: "a@b.co", phone: "+923001234567", mobile: "03001234567" }, { defaultCountry: "+92" }).identities.filter((i) => i.kind === "phone").length === 1);

  /* the database */
  const db = migrate(new S(":memory:"));
  const clock = () => "2026-10-19T10:00:00.000Z";
  const opts = { now: clock, defaultCountry: "+92" };

  const a = capture(db, { name: "Layla Haddad", company: "Glow Clinic", audience: "med-spa", phone: "+974 3942 9472", email: "Layla@GlowClinic.QA", tags: ["dubai", "newsletter"], source: "instagram", consent: true, consentText: "Happy to be contacted.", consentVersion: "v2" }, opts);
  t("captures a contact from a social channel", a.ok && a.created === true, a);
  t("stores the raw phone as given", db.prepare("SELECT value_raw FROM contact_identities WHERE kind='phone'").get().value_raw === "+974 3942 9472");
  t("stores the normalised phone as the identity", db.prepare("SELECT value_normalized FROM contact_identities WHERE kind='phone'").get().value_normalized === "+97439429472");
  t("stores both identities", db.prepare("SELECT COUNT(*) AS n FROM contact_identities").get().n === 2);
  t("stores the audience tags", db.prepare("SELECT COUNT(*) AS n FROM contact_tags").get().n === 3, db.prepare("SELECT tag FROM contact_tags").all());
  t("records the consent channel", db.prepare("SELECT consent_channel FROM contacts").get().consent_channel === "instagram");

  /* a person with no email at all: the case the old schema rejected */
  const phoneOnly = capture(db, { name: "Ahmed", phone: "0321 9876543", audience: "dealer", source: "facebook" }, opts);
  t("accepts a phone-only contact", phoneOnly.ok && phoneOnly.created === true, phoneOnly);
  t("a phone-only contact is reachable by phone", stats(db).reachablePhone === 2);
  t("a phone-only contact is not reachable by email", stats(db).reachableEmail === 1, stats(db));
  t("phone-only contacts are counted separately", stats(db).phoneOnly === 1, stats(db).phoneOnly);

  /* the same person, arriving by a different channel */
  const samePerson = capture(db, { email: "layla@glowclinic.qa", phone: "00974 3942 9472", source: "website", formId: "enquiry", message: "Do you cover Qatar?" }, opts);
  t("the same person from another channel is one contact", samePerson.created === false && samePerson.contactId === a.contactId, samePerson);
  t("the visit is a second submission on the same person", db.prepare("SELECT submissions AS n FROM contacts WHERE id=?").get(a.contactId).n === 2);
  t("a 00-prefixed number matches the same identity", db.prepare("SELECT COUNT(*) AS n FROM contact_identities WHERE kind='phone'").get().n === 2);
  t("the first touch is preserved", db.prepare("SELECT source FROM contacts WHERE id=?").get(a.contactId).source === "instagram");

  /* matching by phone alone when the email differs */
  const byPhone = capture(db, { phone: "+97439429472", name: "L. Haddad", formId: "order" }, opts);
  t("matching works by phone alone", byPhone.contactId === a.contactId, byPhone);
  t("a newly provided name updates the record", db.prepare("SELECT name FROM contacts WHERE id=?").get(a.contactId).name === "L. Haddad");
  capture(db, { phone: "+97439429472", formId: "order", message: "Blank check" }, opts);
  t("an omitted field does not blank what is already there", db.prepare("SELECT name FROM contacts WHERE id=?").get(a.contactId).name === "L. Haddad");

  /* a cross-channel conflict is recorded, never merged */
  const other = capture(db, { email: "shared@x.co", name: "First Person" }, opts);
  const clash = capture(db, { email: "shared@x.co", phone: "+923219876543" }, opts);
  t("a conflict between two contacts is flagged", clash.conflict === true, clash);
  t("the conflict is recorded for a human", db.prepare("SELECT COUNT(*) AS n FROM identity_conflicts").get().n === 1);
  t("nothing is auto-merged", db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE status='active'").get().n === 3, db.prepare("SELECT id,name FROM contacts").all());

  /* idempotency */
  const dbl1 = capture(db, { email: "dbl@x.co", formId: "enquiry", message: "Hello" }, { now: () => "2026-10-19T11:00:00.000Z", defaultCountry: "+92" });
  const dbl2 = capture(db, { email: "dbl@x.co", formId: "enquiry", message: "Hello" }, { now: () => "2026-10-19T11:00:20.000Z", defaultCountry: "+92" });
  t("an exact double click collapses", dbl2.replayed === true, dbl2);
  const genuine = capture(db, { email: "dbl@x.co", formId: "enquiry", message: "Actually, one more question" }, { now: () => "2026-10-19T11:00:40.000Z", defaultCountry: "+92" });
  t("a genuine second enquiry is kept", genuine.replayed === false, genuine);

  /* email jobs */
  const send = capture(db, { email: "buyer@x.co", formId: "order" }, opts);
  queueSend(db, send.submissionId);
  t("a send is queued, not sent", pendingSends(db).some((p) => p.submission_id === send.submissionId));
  markSent(db, send.submissionId);
  t("a sent job leaves the queue", !pendingSends(db).some((p) => p.submission_id === send.submissionId));
  const failSub = capture(db, { email: "fail@x.co", formId: "order" }, opts);
  queueSend(db, failSub.submissionId);
  markFailed(db, failSub.submissionId, "SMTP 451");
  t("a failed send is retryable and the lead survives", pendingSends(db).some((p) => p.submission_id === failSub.submissionId) && !!db.prepare("SELECT id FROM contacts WHERE id=?").get(failSub.contactId));

  /* segmentation and export */
  const aud = listAudience(db, { tag: "dubai" });
  t("filters the audience by tag", aud.length === 1 && /dubai/.test(aud[0].tags), aud);
  const byPhone2 = listAudience(db, { channel: "phone" });
  t("filters the audience by reachable channel", byPhone2.length >= 2, byPhone2.length);
  t("the audience view joins the identities", !!aud[0].email && !!aud[0].phone, aud[0]);

  const marketing = exportAudience(db, { channel: "email", purpose: "marketing" });
  t("a marketing export includes only consented contacts", marketing.rows.every((r) => r.consent_at), marketing.rows.map((r) => r.value));
  t("the marketing export carries the email", marketing.rows.some((r) => r.value === "Layla@GlowClinic.QA"));
  const transactional = exportAudience(db, { channel: "email", purpose: "transactional" });
  t("a transactional export includes everyone", transactional.rows.length > marketing.rows.length, [marketing.rows.length, transactional.rows.length]);
  const callListMarketing = exportAudience(db, { channel: "phone" });
  t("a marketing call list includes only consented contacts", callListMarketing.rows.length === 1, callListMarketing.rows.map((r) => r.value));
  const callList = exportAudience(db, { channel: "phone", purpose: "transactional" });
  t("a transactional call list includes everyone reachable by phone", callList.rows.length === 2 && callList.csv.includes("+97439429472"), callList.rows.map((r) => r.value));
  t("the export is CSV with a header", callList.csv.startsWith("name,company,audience"));

  /* stats */
  const s = stats(db);
  const activeContacts = db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE status <> 'erased'").get().n;
  t("stats counts people, not rows", s.contacts === activeContacts && s.submissions > s.contacts, s);
  t("stats reports identity kinds", s.identityKinds.some((k) => k.kind === "email") && s.identityKinds.some((k) => k.kind === "phone"), s.identityKinds);
  t("stats reports audience tags", s.byTag.some((b) => b.tag === "dubai"), s.byTag);
  t("stats reports the channel mix", s.byChannel.length >= 2, s.byChannel);
  t("stats reports the consent count", s.consented >= 1);
  t("stats reports duplicate rows avoided", s.duplicatesCollapsed >= 0);

  /* erasure across every identity */
  const before = stats(db).contacts;
  const er = eraseContact(db, "layla@glowclinic.qa");
  t("erasure finds the person by email", er.erased === true, er);
  t("erasure suppresses every identity they had", er.identities === 2, er);
  t("erasure anonymises the identities", (() => {
    const rows = db.prepare("SELECT value_raw FROM contact_identities WHERE contact_id=?").all(a.contactId);
    return rows.every((r) => /^erased\+/.test(r.value_raw));
  })());
  t("erasure clears the name and company", (() => {
    const r = db.prepare("SELECT name, company FROM contacts WHERE id=?").get(a.contactId);
    return r.name === null && r.company === null;
  })());
  t("erasure removes the tags", db.prepare("SELECT COUNT(*) AS n FROM contact_tags WHERE contact_id=?").get(a.contactId).n === 0);
  t("erasure clears the message text", db.prepare("SELECT COUNT(*) AS n FROM submissions WHERE contact_id=? AND message IS NOT NULL").get(a.contactId).n === 0);
  t("erased contacts are excluded from stats", stats(db).contacts === before - 1, [before, stats(db).contacts]);

  const back = capture(db, { phone: "+97439429472", name: "Layla Again" }, opts);
  t("an erased person is not recreated by any identity", back.suppressed === true, back);
  const back2 = capture(db, { email: "layla@glowclinic.qa", name: "Layla Again" }, opts);
  t("...including by their other identity", back2.suppressed === true, back2);
  t("no erased personal data returns", !db.prepare("SELECT id FROM contacts WHERE name='Layla Again'").get());

  t("erasing an unknown person is a no-op", eraseContact(db, "nobody@nowhere.co").erased === false);
  db.close();

  /* the v1 to v2 upgrade, on a real file */
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const file = join(mkdtempSync(join(tmpdir(), "aud-")), "audience.db");

  const v1 = new S(file);
  v1.exec(`
    CREATE TABLE contacts (
      id TEXT PRIMARY KEY, email TEXT NOT NULL, email_normalized TEXT NOT NULL UNIQUE,
      name TEXT, phone TEXT, company TEXT, audience TEXT, source TEXT, utm_source TEXT, utm_medium TEXT,
      utm_campaign TEXT, landing_page TEXT, referrer TEXT, consent_at TEXT, consent_version TEXT,
      consent_text TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
      submissions INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'active');
    CREATE TABLE submissions (id TEXT PRIMARY KEY, contact_id TEXT NOT NULL, form_id TEXT NOT NULL,
      submission_key TEXT NOT NULL UNIQUE, payload_hash TEXT, message TEXT, audience TEXT,
      utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_content TEXT, utm_term TEXT,
      landing_page TEXT, referrer TEXT, created_at TEXT NOT NULL);
    CREATE TABLE email_log (id TEXT PRIMARY KEY, submission_id TEXT NOT NULL, status TEXT NOT NULL,
      provider TEXT, error TEXT, attempted_at TEXT NOT NULL, sent_at TEXT);
    CREATE TABLE suppressions (email_hash TEXT PRIMARY KEY, erased_at TEXT NOT NULL);
  `);
  v1.prepare("INSERT INTO contacts (id,email,email_normalized,name,first_seen_at,last_seen_at) VALUES ('ct_old','Old@Example.com','old@example.com','Old Row','2026-01-01','2026-01-01')").run();
  // A person erased before the upgrade, recorded with the old hash.
  v1.prepare("INSERT INTO suppressions (email_hash, erased_at) VALUES (?, '2026-01-02')").run(createHash("sha256").update("gone@example.com").digest("hex").slice(0, 32));
  v1.close();

  const upgraded = migrate(new S(file));
  t("a v1 database upgrades in place", upgraded.prepare("SELECT COUNT(*) AS n FROM contacts").get().n === 1);
  t("the old email becomes an identity", upgraded.prepare("SELECT value_normalized FROM contact_identities WHERE kind='email'").get().value_normalized === "old@example.com");
  t("the row keeps its name", upgraded.prepare("SELECT name FROM contacts WHERE id='ct_old'").get().name === "Old Row");
  t("the schema records its version", upgraded.prepare("SELECT value FROM schema_meta WHERE key='version'").get().value === "2");
  t("migrating again changes nothing", (() => { migrate(upgraded); return upgraded.prepare("SELECT COUNT(*) AS n FROM contact_identities").get().n === 1; })());
  t("the old email-based suppression table is preserved, not silently skipped", !!upgraded.prepare("SELECT name FROM sqlite_master WHERE name='suppressions_legacy'").get());
  const stillGone = capture(upgraded, { email: "gone@example.com", name: "Should Not Return" }, { defaultCountry: "+92" });
  t("an erasure made before the upgrade is still honoured", stillGone.suppressed === true, stillGone);
  t("a suppressed pre-upgrade person is not recreated", !upgraded.prepare("SELECT id FROM contacts WHERE name='Should Not Return'").get());

  /* the case the old schema made impossible */
  const nowPhoneOnly = capture(upgraded, { phone: "0300 555 1234", name: "New Phone Only" }, { defaultCountry: "+92" });
  t("a phone-only contact can be added after upgrading", nowPhoneOnly.ok && nowPhoneOnly.created, nowPhoneOnly);
  t("the upgraded submissions table gained its channel column", upgraded.prepare("PRAGMA table_info(submissions)").all().some((c) => c.name === "channel"));
  t("the upgraded schema is complete", upgraded.prepare("PRAGMA table_info(contacts)").all().some((c) => c.name === "consent_channel") && upgraded.prepare("PRAGMA table_info(contact_identities)").all().some((c) => c.name === "needs_review"));
  upgraded.close();

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  return fail === 0 ? 0 : 1;
}

/* ------------------------------------------------------------------ cli */

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) { flags[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true; }
  }
  return flags;
}

async function main(argv) {
  if (argv[0] === "--selftest") return selftest();
  const S = await loaded();
  const [cmd, path, arg] = argv;
  if (!cmd || !["migrate", "add", "audience", "stats", "export", "erase"].includes(cmd) || !path) {
    console.error(`usage:
  node lead-store.mjs migrate  <db>
  node lead-store.mjs add      <db> '<json submission>'
  node lead-store.mjs audience <db> [--tag dubai] [--channel phone]
  node lead-store.mjs stats    <db>
  node lead-store.mjs export   <db> --channel email|phone [--tag x] [--purpose marketing|transactional]
  node lead-store.mjs erase    <db> <email|phone|handle>
  node lead-store.mjs --selftest`);
    return 2;
  }

  const db = migrate(new S(path));
  const flags = parseArgs(argv.slice(2));

  if (cmd === "migrate") { console.log(`  schema v${db.prepare("SELECT value FROM schema_meta WHERE key='version'").get().value} ready in ${path}`); return 0; }

  if (cmd === "add") {
    const payload = JSON.parse(arg ?? "{}");
    const result = capture(db, { formId: "cli", ...payload }, { defaultCountry: flags.country ?? null });
    if (!result.ok) { console.error(`  rejected: ${result.errors[0].message}`); return 1; }
    if (result.suppressed) { console.log("  suppressed: this person asked to be erased"); return 0; }
    if (result.replayed) { console.log(`  duplicate submission ignored (${result.submissionId})`); return 0; }
    if (result.conflict) console.log("  NOTE: these identities match two contacts. Recorded for review, not merged.");
    queueSend(db, result.submissionId);
    console.log(`  ${result.created ? "new contact" : "existing contact"} ${result.contactId} with ${result.identities.length} identity(ies), submission ${result.submissionId}, email queued`);
    return 0;
  }

  if (cmd === "audience") {
    const rows = listAudience(db, { tag: flags.tag ?? null, channel: flags.channel ?? null });
    if (!rows.length) { console.log("  (nobody matches)"); return 0; }
    for (const r of rows) {
      console.log(`  ${String(r.name ?? "(no name)").padEnd(18)} ${String(r.email ?? "-").padEnd(26)} ${String(r.phone ?? "-").padEnd(16)} ${String(r.audience ?? "").padEnd(9)} ${r.tags ?? ""}`);
    }
    console.log(`\n  ${rows.length} contact(s)`);
    return 0;
  }

  if (cmd === "stats") {
    const s = stats(db);
    console.log(`\n  ${s.contacts} contacts from ${s.submissions} submissions (${s.duplicatesCollapsed} duplicate row(s) avoided)`);
    console.log(`  consented ${s.consented}   reachable by email ${s.reachableEmail}   by phone ${s.reachablePhone}   phone-only ${s.phoneOnly}`);
    if (s.conflicts) console.log(`  identity conflicts awaiting review: ${s.conflicts}`);
    for (const k of s.identityKinds) console.log(`    identity  ${String(k.kind).padEnd(11)} ${k.n}`);
    for (const t of s.byTag) console.log(`    audience  ${String(t.tag).padEnd(11)} ${t.contacts}`);
    for (const c of s.byChannel) console.log(`    channel   ${String(c.channel).padEnd(11)} ${c.contacts}`);
    for (const e of s.sends) console.log(`    email     ${String(e.status).padEnd(11)} ${e.n}`);
    console.log("");
    return 0;
  }

  if (cmd === "export") {
    const out = exportAudience(db, { channel: flags.channel ?? "email", tag: flags.tag ?? null, purpose: flags.purpose ?? "marketing" });
    if (!out.rows.length) { console.error(`  nothing to export. A marketing export needs consent; try --purpose transactional`); return 1; }
    console.log(out.csv);
    console.error(`  ${out.rows.length} contact(s), purpose=${flags.purpose ?? "marketing"}`);
    return 0;
  }

  if (cmd === "erase") {
    const r = eraseContact(db, arg);
    console.log(r.erased ? `  erased ${r.identities} identity(ies) and suppressed them` : "  no such person");
    return 0;
  }
  return 2;
}

const isMain = process.argv[1] && process.argv[1].endsWith("lead-store.mjs");
if (isMain) main(process.argv.slice(2)).then((c) => process.exit(c)).catch((e) => { console.error(`  error: ${e.message}`); process.exit(1); });
