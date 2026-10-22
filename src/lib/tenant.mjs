// The tenant boundary, in one place.
//
// sql-analysis/SKILL.md line 45 is the rule this file exists to keep: a tenant column "means
// every query needs the filter, or you will report one client's numbers as another's". So there
// is exactly one module that touches tenant-owned tables, every function takes an organisation
// id as its first argument, and every statement carries the filter. Nothing here will run
// without one.
//
// The write methods return the number of changed rows. That is not decoration: callers and tests
// use it to prove that a cross-organisation update matched nothing rather than trusting a
// missing exception. RLS in supabase/policies/rls.sql enforces the same boundary in the database
// for the Postgres target, so a future feature that forgets the filter fails closed there too.

import { getDb } from "./db.mjs";
import { id as newId, nowIso, extractIdentities, payloadHashOf } from "./identities.mjs";
import { writeAudit } from "./audit.mjs";
import { assertCan, assertCanEditLead } from "./roles.mjs";

export const LEAD_STAGES = ["new", "contacted", "qualified", "proposal", "won", "lost"];
export const IDENTITY_KINDS = [
  "email",
  "phone",
  "whatsapp",
  "instagram",
  "facebook",
  "linkedin",
  "telegram",
  "x",
];

// A double click and a genuine second enquiry can be seconds apart. The window is short on
// purpose: idempotency hashes the payload, never the clock, so two different messages in the
// same minute are both kept.
const DEDUPE_WINDOW_MS = 120_000;

function requireOrg(orgId) {
  if (typeof orgId !== "string" || !orgId.trim()) {
    throw new Error("A tenant store call needs an organization id. Refusing to run unscoped.");
  }
  return orgId;
}

function text(value, field, max = 500) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (s.length > max) throw new Error(`${field} is longer than ${max} characters.`);
  return s;
}

export function createTenantStore(db = getDb()) {
  const inTx = (fn) => db.transaction(fn)();

  // Contacts -----------------------------------------------------------------

  function listContacts(orgId, { limit = 100, tag = null } = {}) {
    requireOrg(orgId);
    if (tag) {
      return db
        .prepare(
          `select c.* from contacts c
             join contact_tags t on t.contact_id = c.id
            where c.organization_id = ? and t.tag = ?
            order by c.last_seen_at desc limit ?`,
        )
        .all(orgId, tag, limit);
    }
    return db
      .prepare(
        "select * from contacts where organization_id = ? order by last_seen_at desc limit ?",
      )
      .all(orgId, limit);
  }

  function getContact(orgId, contactId) {
    requireOrg(orgId);
    const contact = db
      .prepare("select * from contacts where id = ? and organization_id = ?")
      .get(contactId, orgId);
    if (!contact) return null;

    return {
      ...contact,
      identities: db
        .prepare(
          "select id, kind, value_raw, value_normalized, label, needs_review from contact_identities where contact_id = ? and organization_id = ? order by first_seen_at",
        )
        .all(contactId, orgId),
      tags: db
        .prepare("select tag from contact_tags where contact_id = ? order by tag")
        .all(contactId)
        .map((r) => r.tag),
      leads: db
        .prepare(
          "select * from leads where contact_id = ? and organization_id = ? order by created_at desc",
        )
        .all(contactId, orgId),
    };
  }

  function addTag(orgId, contactId, tag) {
    requireOrg(orgId);
    const owns = db
      .prepare("select id from contacts where id = ? and organization_id = ?")
      .get(contactId, orgId);
    if (!owns) return 0;

    const clean = text(tag, "tag", 60);
    if (!clean) return 0;

    const result = db
      .prepare(
        "insert or ignore into contact_tags (contact_id, tag, added_at) values (?, ?, ?)",
      )
      .run(contactId, clean.toLowerCase(), nowIso());
    return result.changes;
  }

  function removeTag(orgId, contactId, tag) {
    requireOrg(orgId);
    return db
      .prepare(
        `delete from contact_tags
          where tag = ? and contact_id in (select id from contacts where id = ? and organization_id = ?)`,
      )
      .run(String(tag).toLowerCase(), contactId, orgId).changes;
  }

  function updateContact(orgId, contactId, patch, { actorUserId = null } = {}) {
    requireOrg(orgId);
    const name = text(patch.name, "name", 120);

    const result = db
      .prepare("update contacts set name = coalesce(?, name) where id = ? and organization_id = ?")
      .run(name, contactId, orgId);

    if (result.changes) {
      writeAudit(db, {
        orgId,
        actorUserId,
        action: "contact.update",
        entity: "contact",
        entityId: contactId,
        meta: { fields: Object.keys(patch) },
      });
    }
    return result.changes;
  }

  function deleteContact(orgId, contactId, { actorUserId = null, role = null } = {}) {
    requireOrg(orgId);
    if (role) assertCan(role, "contact:delete");

    // Identities, tags and leads cascade, so this removes the person entirely rather than
    // leaving orphan rows behind.
    const result = db
      .prepare("delete from contacts where id = ? and organization_id = ?")
      .run(contactId, orgId);

    if (result.changes) {
      writeAudit(db, {
        orgId,
        actorUserId,
        action: "contact.delete",
        entity: "contact",
        entityId: contactId,
      });
    }
    return result.changes;
  }

  // The enquiry path ---------------------------------------------------------
  //
  // store before send: a submission is written to the database first, and any email is queued
  // afterwards. If the mail provider is down, the lead is still there.

  function capture(orgId, submission = {}, options = {}) {
    requireOrg(orgId);
    const {
      source = "website",
      tags = [],
      formId = "enquiry",
      actorUserId = null,
      defaultCountry = null,
      now = Date.now(),
    } = options;

    const { identities, errors } = extractIdentities(submission, { defaultCountry });
    if (!identities.length) {
      return { ok: false, errors, identities, contactId: null, leadId: null };
    }

    const payloadHash = payloadHashOf(formId, identities, submission);
    const since = new Date(now - DEDUPE_WINDOW_MS).toISOString();
    const at = new Date(now).toISOString();

    return inTx(() => {
      const replayed = db
        .prepare(
          `select id, contact_id from leads
            where organization_id = ? and form_id = ? and payload_hash = ? and created_at >= ?
            limit 1`,
        )
        .get(orgId, formId, payloadHash, since);

      if (replayed) {
        return {
          ok: true,
          replayed: true,
          created: false,
          contactId: replayed.contact_id,
          leadId: replayed.id,
          identities,
          errors,
        };
      }

      // One identity, one contact, within this organisation. Looked up by the normalised
      // values so a phone number written two different ways still matches.
      const clause = identities.map(() => "(kind = ? and value_normalized = ?)").join(" or ");
      const params = identities.flatMap((i) => [i.kind, i.value_normalized]);

      const existing = db
        .prepare(
          `select contact_id from contact_identities
            where organization_id = ? and (${clause}) limit 1`,
        )
        .get(orgId, ...params);

      let contactId = existing?.contact_id ?? null;
      let createdContact = false;

      if (contactId) {
        db.prepare(
          "update contacts set last_seen_at = ?, submission_count = submission_count + 1 where id = ? and organization_id = ?",
        ).run(at, contactId, orgId);
      } else {
        contactId = newId("ct");
        // The first touch is written once and never overwritten, so the channel that actually
        // brought this person in survives every later enquiry.
        db.prepare(
          `insert into contacts (id, organization_id, name, source, first_seen_at, last_seen_at, submission_count)
           values (?, ?, ?, ?, ?, ?, 1)`,
        ).run(contactId, orgId, text(submission.name, "name", 120), text(source, "source", 60), at, at);
        createdContact = true;
      }

      for (const ident of identities) {
        db.prepare(
          `insert or ignore into contact_identities
             (id, organization_id, contact_id, kind, value_raw, value_normalized, label, needs_review, first_seen_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          newId("idn"),
          orgId,
          contactId,
          ident.kind,
          ident.value_raw,
          ident.value_normalized,
          ident.label,
          ident.needs_review,
          at,
        );
      }

      for (const tag of tags) {
        addTag(orgId, contactId, tag);
      }

      const leadId = newId("lea");
      db.prepare(
        `insert into leads
           (id, organization_id, contact_id, stage, source, form_id, message, value_minor, currency,
            owner_user_id, payload_hash, created_at, updated_at)
         values (?, ?, ?, 'new', ?, ?, ?, ?, ?, null, ?, ?, ?)`,
      ).run(
        leadId,
        orgId,
        contactId,
        text(source, "source", 60),
        formId,
        text(submission.message, "message", 4000),
        Number.isInteger(submission.valueMinor) ? submission.valueMinor : null,
        text(submission.currency, "currency", 3),
        payloadHash,
        at,
        at,
      );

      writeAudit(db, {
        orgId,
        actorUserId,
        action: "lead.capture",
        entity: "lead",
        entityId: leadId,
        meta: { formId, source, identityKinds: identities.map((i) => i.kind) },
      });

      return {
        ok: true,
        replayed: false,
        created: createdContact,
        contactId,
        leadId,
        identities,
        errors,
      };
    });
  }

  // Leads --------------------------------------------------------------------

  function listLeads(orgId, { stage = null, ownerUserId = null, limit = 100 } = {}) {
    requireOrg(orgId);
    if (stage) {
      return db
        .prepare(
          "select * from leads where organization_id = ? and stage = ? order by created_at desc limit ?",
        )
        .all(orgId, stage, limit);
    }
    if (ownerUserId) {
      return db
        .prepare(
          "select * from leads where organization_id = ? and owner_user_id = ? order by created_at desc limit ?",
        )
        .all(orgId, ownerUserId, limit);
    }
    return db
      .prepare("select * from leads where organization_id = ? order by created_at desc limit ?")
      .all(orgId, limit);
  }

  function getLead(orgId, leadId) {
    requireOrg(orgId);
    const lead = db
      .prepare("select * from leads where id = ? and organization_id = ?")
      .get(leadId, orgId);
    if (!lead) return null;

    return {
      ...lead,
      activities: db
        .prepare(
          "select * from lead_activities where lead_id = ? and organization_id = ? order by created_at asc",
        )
        .all(leadId, orgId),
    };
  }

  function addActivity(orgId, leadId, { kind = "note", body = null, actorUserId = null }) {
    requireOrg(orgId);
    const owns = db
      .prepare("select id from leads where id = ? and organization_id = ?")
      .get(leadId, orgId);
    if (!owns) return 0;

    db.prepare(
      `insert into lead_activities (id, organization_id, lead_id, actor_user_id, kind, body, created_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
    ).run(newId("act"), orgId, leadId, actorUserId, kind, text(body, "body", 4000), nowIso());

    return 1;
  }

  function updateLeadStage(orgId, leadId, stage, { role = null, actorUserId = null } = {}) {
    requireOrg(orgId);
    if (!LEAD_STAGES.includes(stage)) {
      throw new Error(`Unknown stage "${stage}". One of: ${LEAD_STAGES.join(", ")}.`);
    }

    const lead = db
      .prepare("select * from leads where id = ? and organization_id = ?")
      .get(leadId, orgId);
    if (!lead) return 0;

    if (role) assertCanEditLead(role, lead, actorUserId);

    const result = db
      .prepare(
        "update leads set stage = ?, updated_at = ? where id = ? and organization_id = ?",
      )
      .run(stage, nowIso(), leadId, orgId);

    if (result.changes) {
      db.prepare(
        `insert into lead_activities (id, organization_id, lead_id, actor_user_id, kind, body, created_at)
         values (?, ?, ?, ?, 'stage', ?, ?)`,
      ).run(newId("act"), orgId, leadId, actorUserId, `${lead.stage} to ${stage}`, nowIso());

      writeAudit(db, {
        orgId,
        actorUserId,
        action: "lead.stage",
        entity: "lead",
        entityId: leadId,
        meta: { from: lead.stage, to: stage },
      });
    }
    return result.changes;
  }

  function assignLead(orgId, leadId, ownerUserId, { role = null, actorUserId = null } = {}) {
    requireOrg(orgId);
    if (role) assertCan(role, "lead:assign");

    // The new owner must be a member of this organisation, so a lead cannot be handed to
    // somebody who would then be unable to see it, or worse, to somebody in another tenant.
    const member = db
      .prepare("select user_id from memberships where organization_id = ? and user_id = ?")
      .get(orgId, ownerUserId);
    if (!member) {
      const error = new Error("That person is not a member of this workspace.");
      error.code = "FORBIDDEN";
      error.status = 400;
      throw error;
    }

    const result = db
      .prepare(
        "update leads set owner_user_id = ?, updated_at = ? where id = ? and organization_id = ?",
      )
      .run(ownerUserId, nowIso(), leadId, orgId);

    if (result.changes) {
      writeAudit(db, {
        orgId,
        actorUserId,
        action: "lead.assign",
        entity: "lead",
        entityId: leadId,
        meta: { ownerUserId },
      });
    }
    return result.changes;
  }

  // Dashboard ----------------------------------------------------------------

  function stats(orgId) {
    requireOrg(orgId);

    const one = (sql, ...params) => db.prepare(sql).get(orgId, ...params);

    const contacts = one("select count(*) as n from contacts where organization_id = ?").n;
    const leads = one("select count(*) as n from leads where organization_id = ?").n;

    const byStage = db
      .prepare("select stage, count(*) as n from leads where organization_id = ? group by stage")
      .all(orgId);

    const lastSeven = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const newThisWeek = one(
      "select count(*) as n from leads where organization_id = ? and created_at >= ?",
      lastSeven,
    ).n;

    const recent = db
      .prepare(
        `select l.id, l.stage, l.source, l.created_at, c.name as contact_name
           from leads l join contacts c on c.id = l.contact_id
          where l.organization_id = ?
          order by l.created_at desc limit 10`,
      )
      .all(orgId);

    return { contacts, leads, byStage, newThisWeek, recent };
  }

  return {
    listContacts,
    getContact,
    updateContact,
    deleteContact,
    addTag,
    removeTag,
    capture,
    listLeads,
    getLead,
    addActivity,
    updateLeadStage,
    assignLead,
    stats,
  };
}
