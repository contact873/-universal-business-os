// The subscriber registry: who signed up, what they agreed to, and what we have offered them.
//
// This is the operator's side of the business, and the reason the free plan is worth running. A
// workspace that never converts is still a relationship, and the only way to keep it is to know who
// the person is and what they said yes to.
//
// Three rules are enforced here rather than trusted to whoever writes the next email:
//
//   1. Consent is recorded, with the moment and the source. An email address is not permission.
//   2. Unsubscribing is final. canEmail refuses, and offerItem refuses to queue anything, so a
//      broadcast cannot be sent "by accident" to someone who asked to be left alone.
//   3. Nothing overwrites a filled field with a blank one. A form that omits the phone number must
//      not erase the one we already have.

import { id as newId } from "./identities.mjs";
import { writeAudit } from "./audit.mjs";

export const SUBSCRIBER_STATUSES = ["lead", "trial", "free", "paying", "cancelled"];
export const OFFER_STATUSES = ["queued", "sent", "accepted", "declined", "ignored"];

/** Lowercase and trim, and refuse anything that cannot receive mail. */
export function normalizeEmail(email) {
  const value = String(email ?? "").trim().toLowerCase();
  if (value.length < 5 || value.length > 254) return null;
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value)) return null;
  return value;
}

/**
 * Creates or updates one subscriber, matched on the normalised address.
 *
 * Safe to call from every sign-up path: the second call links the workspace to the row created by
 * the first, rather than making a duplicate that splits the history in two.
 */
export function upsertSubscriber(db, input, { now = Date.now() } = {}) {
  const normalized = normalizeEmail(input.email);
  if (!normalized) return { ok: false, reason: "bad_email" };

  const at = new Date(now).toISOString();
  const existing = db.prepare("select * from subscribers where email_normalized = ?").get(normalized);

  const consentGranted = input.marketingConsent === true || input.marketingConsent === 1 || input.marketingConsent === "true";
  const consentAt = consentGranted ? (existing?.consent_at ?? at) : (existing?.consent_at ?? null);
  const consentSource = consentGranted ? (input.consentSource ?? input.source ?? "website") : (existing?.consent_source ?? null);

  if (existing) {
    // coalesce in the other direction: the new value wins only when it is not empty.
    db.prepare(
      `update subscribers
          set name = coalesce(nullif(?, ''), name),
              phone = coalesce(nullif(?, ''), phone),
              company = coalesce(nullif(?, ''), company),
              country = coalesce(nullif(?, ''), country),
              city = coalesce(nullif(?, ''), city),
              language = coalesce(nullif(?, ''), language),
              organization_id = coalesce(?, organization_id),
              user_id = coalesce(?, user_id),
              plan_id = coalesce(nullif(?, ''), plan_id),
              status = coalesce(nullif(?, ''), status),
              marketing_consent = case when marketing_consent = 1 or ? = 1 then 1 else 0 end,
              consent_at = ?,
              consent_source = ?,
              updated_at = ?
        where id = ?`,
    ).run(
      input.name ?? "",
      input.phone ?? "",
      input.company ?? "",
      input.country ?? "",
      input.city ?? "",
      input.language ?? "",
      input.organizationId ?? null,
      input.userId ?? null,
      input.planId ?? "",
      input.status ?? "",
      consentGranted ? 1 : 0,
      consentAt,
      consentSource,
      at,
      existing.id,
    );

    return { ok: true, subscriberId: existing.id, created: false, email: normalized };
  }

  const subscriberId = newId("sbr");
  db.prepare(
    `insert into subscribers
       (id, organization_id, user_id, email, email_normalized, name, phone, company, country, city,
        language, source, status, plan_id, marketing_consent, consent_at, consent_source,
        unsubscribed_at, tags_json, notes, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, ?, ?, ?, ?)`,
  ).run(
    subscriberId,
    input.organizationId ?? null,
    input.userId ?? null,
    String(input.email).trim(),
    normalized,
    input.name ?? null,
    input.phone ?? null,
    input.company ?? null,
    input.country ?? null,
    input.city ?? null,
    input.language ?? null,
    input.source ?? "website",
    input.status ?? "lead",
    input.planId ?? null,
    consentGranted ? 1 : 0,
    consentAt,
    consentSource,
    input.tags ? JSON.stringify(input.tags) : null,
    input.notes ?? null,
    at,
    at,
  );

  writeAudit(db, {
    orgId: input.organizationId ?? null,
    actorUserId: input.userId ?? null,
    action: "subscriber.added",
    entity: "subscriber",
    entityId: subscriberId,
    meta: { source: input.source ?? "website", status: input.status ?? "lead", consent: consentGranted },
  });

  return { ok: true, subscriberId, created: true, email: normalized };
}

/**
 * Whether this person may be emailed about anything other than their own account.
 *
 * Both conditions are required, and the answer is a reason rather than a boolean so that a caller
 * cannot quietly treat "no consent" as "probably fine".
 */
export function canEmail(subscriber) {
  if (!subscriber) return { ok: false, reason: "not_found" };
  if (subscriber.unsubscribed_at) return { ok: false, reason: "unsubscribed" };
  if (!subscriber.marketing_consent) return { ok: false, reason: "no_consent" };
  return { ok: true, email: subscriber.email };
}

/** Opting in, later. A grant is recorded with its moment and where it came from. */
export function setMarketingConsent(db, subscriberId, granted, { source = "manual", now = Date.now() } = {}) {
  const subscriber = db.prepare("select * from subscribers where id = ?").get(subscriberId);
  if (!subscriber) return { ok: false, reason: "not_found" };
  if (!granted && !subscriber.marketing_consent) return { ok: true, changed: false };

  const at = new Date(now).toISOString();
  db.prepare(
    "update subscribers set marketing_consent = ?, consent_at = ?, consent_source = ?, updated_at = ? where id = ?",
  ).run(granted ? 1 : 0, granted ? at : subscriber.consent_at, granted ? source : subscriber.consent_source, at, subscriberId);

  return { ok: true, changed: true };
}

/**
 * Opting out. Final: it clears consent, records the moment, and every send path checks it.
 *
 * There is no "unsubscribe but keep marketing" variant, deliberately.
 */
export function unsubscribe(db, emailOrId, { reason = null, now = Date.now() } = {}) {
  const normalized = normalizeEmail(emailOrId);
  const subscriber =
    db.prepare("select * from subscribers where id = ?").get(String(emailOrId)) ??
    (normalized ? db.prepare("select * from subscribers where email_normalized = ?").get(normalized) : null);

  if (!subscriber) return { ok: false, reason: "not_found" };
  if (subscriber.unsubscribed_at) return { ok: true, already: true };

  const at = new Date(now).toISOString();
  db.prepare(
    "update subscribers set marketing_consent = 0, unsubscribed_at = ?, updated_at = ?, notes = coalesce(?, notes) where id = ?",
  ).run(at, at, reason ? `unsubscribed: ${reason}` : null, subscriber.id);

  writeAudit(db, {
    orgId: subscriber.organization_id ?? null,
    actorUserId: null,
    action: "subscriber.unsubscribed",
    entity: "subscriber",
    entityId: subscriber.id,
    meta: { reason },
  });

  return { ok: true };
}

/**
 * Queues an offer of a future item. Refused outright for anyone who has opted out, which is the
 * point: the guard is at the queue, not at the send, because a queued offer becomes a sent offer.
 */
export function offerItem(db, subscriberId, { itemKey, itemLabel, channel = "email", note = null, now = Date.now() } = {}) {
  const subscriber = db.prepare("select * from subscribers where id = ?").get(subscriberId);
  const permitted = canEmail(subscriber);
  if (!permitted.ok) return { ok: false, reason: permitted.reason };
  if (!itemKey || !itemLabel) return { ok: false, reason: "missing_item" };

  const at = new Date(now).toISOString();
  const offerId = newId("ofr");

  db.prepare(
    `insert into subscriber_offers
       (id, organization_id, subscriber_id, item_key, item_label, channel, status, note, offered_at, responded_at, created_at)
     values (?, ?, ?, ?, ?, ?, 'queued', ?, ?, null, ?)`,
  ).run(offerId, subscriber.organization_id ?? null, subscriberId, itemKey, itemLabel, channel, note, at, at);

  db.prepare("update subscribers set updated_at = ? where id = ?").run(at, subscriberId);

  return { ok: true, offerId, status: "queued" };
}

export function recordOfferOutcome(db, offerId, status, { note = null, now = Date.now() } = {}) {
  if (!OFFER_STATUSES.includes(status)) return { ok: false, reason: "bad_status" };
  const at = new Date(now).toISOString();

  const changed = db
    .prepare("update subscriber_offers set status = ?, note = coalesce(?, note), responded_at = ? where id = ?")
    .run(status, note, status === "sent" ? null : at, offerId).changes;

  return changed ? { ok: true, status } : { ok: false, reason: "not_found" };
}

/** The list, filtered the way a person would actually ask for it. */
export function subscribersFor(db, { status = null, planId = null, consentedOnly = false, q = null, limit = 200 } = {}) {
  const where = [];
  const params = [];

  if (status) {
    where.push("status = ?");
    params.push(status);
  }
  if (planId) {
    where.push("plan_id = ?");
    params.push(planId);
  }
  if (consentedOnly) where.push("marketing_consent = 1 and unsubscribed_at is null");
  if (q) {
    where.push("(email_normalized like ? or lower(coalesce(name,'')) like ? or lower(coalesce(company,'')) like ?)");
    const needle = `%${String(q).trim().toLowerCase()}%`;
    params.push(needle, needle, needle);
  }

  const sql = `select * from subscribers ${where.length ? `where ${where.join(" and ")}` : ""} order by created_at desc limit ?`;
  return db.prepare(sql).all(...params, limit);
}

export function offersFor(db, subscriberId) {
  return db
    .prepare("select * from subscriber_offers where subscriber_id = ? order by offered_at desc")
    .all(subscriberId);
}

/**
 * Keeps the registry in step with the product. Called when a workspace changes plan, so the list
 * can be filtered to "free users who have been here three months" without a join to guesswork.
 */
export function setSubscriberStatus(db, { organizationId = null, email = null, status, planId = null }, { now = Date.now() } = {}) {
  if (!SUBSCRIBER_STATUSES.includes(status)) return { ok: false, reason: "bad_status" };

  const normalized = email ? normalizeEmail(email) : null;
  const subscriber = organizationId
    ? db.prepare("select * from subscribers where organization_id = ?").get(organizationId)
    : normalized
      ? db.prepare("select * from subscribers where email_normalized = ?").get(normalized)
      : null;

  if (!subscriber) return { ok: false, reason: "not_found" };

  db.prepare("update subscribers set status = ?, plan_id = coalesce(?, plan_id), updated_at = ? where id = ?").run(
    status,
    planId,
    new Date(now).toISOString(),
    subscriber.id,
  );

  return { ok: true, subscriberId: subscriber.id, status };
}

/** The numbers that tell you whether the free plan is doing its job. */
export function subscriberStats(db) {
  const row = db
    .prepare(
      `select
         count(*) as total,
         sum(case when status = 'free' then 1 else 0 end) as free,
         sum(case when status = 'paying' then 1 else 0 end) as paying,
         sum(case when marketing_consent = 1 and unsubscribed_at is null then 1 else 0 end) as mailable,
         sum(case when unsubscribed_at is not null then 1 else 0 end) as unsubscribed
       from subscribers`,
    )
    .get();

  const offers = db
    .prepare(
      `select item_key, item_label,
              count(*) as offered,
              sum(case when status = 'accepted' then 1 else 0 end) as accepted
         from subscriber_offers
        group by item_key, item_label
        order by offered desc`,
    )
    .all();

  const total = row.total ?? 0;
  return {
    total,
    free: row.free ?? 0,
    paying: row.paying ?? 0,
    mailable: row.mailable ?? 0,
    unsubscribed: row.unsubscribed ?? 0,
    conversionRate: total ? Number(((row.paying ?? 0) / total).toFixed(4)) : 0,
    offers,
  };
}

const CSV_COLUMNS = [
  "email",
  "name",
  "company",
  "phone",
  "country",
  "city",
  "language",
  "status",
  "plan_id",
  "marketing_consent",
  "consent_source",
  "consent_at",
  "unsubscribed_at",
  "source",
  "created_at",
];

/**
 * A spreadsheet the business can actually open. Fields are quoted and internal quotes doubled,
 * because a company name containing a comma is not a rare event.
 */
export function toCsv(rows, columns = CSV_COLUMNS) {
  const escape = (value) => {
    if (value === null || value === undefined) return "";
    const text = String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  const lines = [columns.join(",")];
  for (const row of rows) lines.push(columns.map((column) => escape(row[column])).join(","));
  return `${lines.join("\n")}\n`;
}
