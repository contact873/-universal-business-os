import "./setup.mjs";

import { PLAN_DEFINITIONS } from "../src/lib/plans.mjs";
const limitOf = (plan, feature) => PLAN_DEFINITIONS.find((p) => p.id === plan).limits[feature];

import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./fixtures.mjs";
import { closeDb } from "../src/lib/db.mjs";
import { listAudit } from "../src/lib/audit.mjs";
import { entitlementFor } from "../src/lib/accounts.mjs";

const DUBAI = "+971";

test("an enquiry creates a contact and a lead in one step", () => {
  const { db, store, alpha, alice } = fixture({ withLeads: false });

  const result = store.capture(
    alpha,
    { name: "Nadia", mobile: "0501234567", email: "nadia@example.com", message: "Please call me" },
    { source: "instagram", tags: ["clinic", "cold"], defaultCountry: DUBAI, actorUserId: alice },
  );

  assert.equal(result.ok, true);
  assert.equal(result.replayed, false);
  assert.equal(result.created, true);
  assert.ok(result.contactId && result.leadId);
  assert.equal(result.errors.length, 0);

  const contact = store.getContact(alpha, result.contactId);
  assert.equal(contact.name, "Nadia");
  assert.equal(contact.source, "instagram", "the first touch is recorded on the contact");
  assert.equal(contact.submission_count, 1);
  assert.deepEqual(contact.tags.sort(), ["clinic", "cold"]);
  assert.equal(contact.identities.length, 2, "a phone and an email are two identities");

  const lead = store.getLead(alpha, result.leadId);
  assert.equal(lead.stage, "new");
  assert.equal(lead.message, "Please call me");
  assert.equal(lead.form_id, "enquiry");

  // Both identities are stored as typed and as normalised, so the next enquiry matches.
  const kinds = contact.identities.map((i) => `${i.kind}:${i.value_normalized}`).sort();
  assert.deepEqual(kinds, ["email:nadia@example.com", "phone:+971501234567"]);

  const rawPhone = contact.identities.find((i) => i.kind === "phone");
  assert.equal(rawPhone.value_raw, "0501234567", "what they typed is kept, not overwritten");

  closeDb();
});

test("one person written two ways is one contact, not two", () => {
  const { db, store, alpha } = fixture({ withLeads: false });

  const first = store.capture(
    alpha,
    { name: "Ahmed", mobile: "+971501234567", message: "first" },
    { defaultCountry: DUBAI },
  );
  const second = store.capture(
    alpha,
    { name: "Ahmed R", mobile: "0501234567", message: "a genuinely different enquiry" },
    { defaultCountry: DUBAI },
  );

  assert.equal(second.ok, true);
  assert.equal(second.contactId, first.contactId, "the same number written two ways is one person");
  assert.equal(second.created, false);
  assert.notEqual(second.leadId, first.leadId, "but the second enquiry is its own lead");

  assert.equal(store.listContacts(alpha).length, 1);
  assert.equal(store.listLeads(alpha).length, 2, "both enquiries must survive");

  const contact = store.getContact(alpha, first.contactId);
  assert.equal(contact.submission_count, 2);

  closeDb();
});

test("the first touch survives every later enquiry", () => {
  const { db, store, alpha } = fixture({ withLeads: false });

  const first = store.capture(alpha, { email: "same@example.com", message: "one" }, {
    source: "instagram",
  });
  store.capture(alpha, { email: "same@example.com", message: "two" }, { source: "google-ads" });
  store.capture(alpha, { email: "same@example.com", message: "three" }, { source: "referral" });

  const contact = store.getContact(alpha, first.contactId);
  assert.equal(contact.source, "instagram", "the channel that actually brought them in is kept");

  closeDb();
});

test("a double click is collapsed, a second genuine enquiry is not", () => {
  const { db, store, alpha } = fixture({ withLeads: false });

  const payload = { email: "double@example.com", message: "identical" };

  const one = store.capture(alpha, payload, { formId: "contact" });
  const two = store.capture(alpha, payload, { formId: "contact" });

  assert.equal(one.ok, true);
  assert.equal(two.replayed, true, "the same payload twice is one submission");
  assert.equal(two.leadId, one.leadId);
  assert.equal(store.listLeads(alpha).length, 1);

  // The clock is not part of the key: a different message in the same minute is kept.
  const three = store.capture(alpha, { email: "double@example.com", message: "different" }, {
    formId: "contact",
  });
  assert.equal(three.replayed, false);
  assert.equal(store.listLeads(alpha).length, 2, "a real second enquiry must not be swallowed");

  // And the same payload against a different form is a different event.
  const four = store.capture(alpha, payload, { formId: "quote" });
  assert.equal(four.replayed, false);
  assert.equal(store.listLeads(alpha).length, 3);

  closeDb();
});

test("a broken email does not cost you the phone number", () => {
  const { db, store, alpha } = fixture({ withLeads: false });

  const result = store.capture(
    alpha,
    { mobile: "0501234567", email: "not-an-email" },
    { defaultCountry: DUBAI },
  );

  assert.equal(result.ok, true, "the enquiry is still saved");
  assert.equal(result.errors.length, 1, "and the bad field is reported");
  assert.equal(result.errors[0].field, "email");
  assert.equal(result.identities.length, 1);
  assert.equal(result.identities[0].kind, "phone");

  closeDb();
});

test("a submission with nothing to identify the person creates nothing", () => {
  const { db, store, alpha } = fixture({ withLeads: false });

  const result = store.capture(alpha, { message: "hello?" });

  assert.equal(result.ok, false);
  assert.equal(result.contactId, null);
  assert.equal(result.leadId, null);
  assert.equal(store.listContacts(alpha).length, 0);
  assert.equal(store.listLeads(alpha).length, 0);

  closeDb();
});

test("a handle is normalised, so the same instagram account matches", () => {
  const { db, store, alpha } = fixture({ withLeads: false });

  const one = store.capture(alpha, { instagram: "@layla.haddad", message: "hi" });
  const two = store.capture(alpha, { instagram: "https://instagram.com/layla.haddad", message: "again" });

  assert.equal(two.contactId, one.contactId);

  closeDb();
});

test("tags filter the contact list", () => {
  const { db, store, alpha } = fixture({ withLeads: false });

  const one = store.capture(alpha, { email: "tagged@example.com" }, { tags: ["dubai"] });
  store.capture(alpha, { email: "other@example.com" }, { tags: ["karachi"] });

  assert.equal(store.listContacts(alpha, { tag: "dubai" }).length, 1);
  assert.equal(store.listContacts(alpha, { tag: "karachi" }).length, 1);
  assert.equal(store.listContacts(alpha, { tag: "nowhere" }).length, 0);

  assert.equal(store.removeTag(alpha, one.contactId, "dubai"), 1);
  assert.equal(store.listContacts(alpha, { tag: "dubai" }).length, 0);

  closeDb();
});

test("moving a lead writes an activity and an audit row", () => {
  const { db, store, alpha, alice, captured } = fixture();

  assert.equal(store.updateLeadStage(alpha, captured.alpha.leadId, "qualified", { actorUserId: alice }), 1);

  const lead = store.getLead(alpha, captured.alpha.leadId);
  assert.equal(lead.stage, "qualified");
  assert.equal(lead.activities.length, 1);
  assert.equal(lead.activities[0].kind, "stage");
  assert.match(lead.activities[0].body, /new to qualified/);

  const audit = listAudit(db, alpha).filter((r) => r.action === "lead.stage");
  assert.equal(audit.length, 1);

  closeDb();
});

test("assigning a lead to a member works and is recorded", () => {
  const { db, store, alpha, carol, captured } = fixture();

  assert.equal(
    store.assignLead(alpha, captured.alpha.leadId, carol, { role: "manager", actorUserId: carol }),
    1,
  );
  assert.equal(store.getLead(alpha, captured.alpha.leadId).owner_user_id, carol);

  // Now that Carol owns it, she may work it as staff.
  assert.equal(
    store.updateLeadStage(alpha, captured.alpha.leadId, "contacted", {
      role: "staff",
      actorUserId: carol,
    }),
    1,
  );

  assert.equal(listAudit(db, alpha).filter((r) => r.action === "lead.assign").length, 1);

  closeDb();
});

test("deleting a contact removes their identities, tags and leads", () => {
  const { db, store, alpha, captured } = fixture();

  const contactId = captured.alpha.contactId;
  assert.equal(store.deleteContact(alpha, contactId, { role: "owner" }), 1);
  assert.equal(store.getContact(alpha, contactId), null);
  assert.equal(store.listLeads(alpha).length, 0, "their leads go with them");

  // Cascades must be real, not merely hidden by the scoping filter.
  for (const table of ["contact_identities", "contact_tags", "leads"]) {
    const row = db.prepare(`select count(*) as n from ${table} where contact_id = ?`).get(contactId);
    assert.equal(row.n, 0, `${table} must not keep orphan rows`);
  }

  closeDb();
});

test("deleting requires the role that permits it", () => {
  const { store, alpha, captured, carol } = fixture();

  assert.throws(
    () => store.deleteContact(alpha, captured.alpha.contactId, { role: "staff", actorUserId: carol }),
    /cannot perform/,
  );

  closeDb();
});

test("a plan limit is readable on the server, not only in the interface", () => {
  const { db, alpha } = fixture({ withLeads: false });

  // Starter grants 250 contacts. The point of the entitlement table is that the server can answer
  // "is this allowed" without trusting anything the browser sent.
  const entitlement = entitlementFor(db, alpha, "contacts");
  assert.equal(entitlement.granted, true);
  assert.equal(entitlement.limit, limitOf("starter", "contacts"));

  const seats = entitlementFor(db, alpha, "seats");
  assert.equal(seats.limit, 2);

  // A feature nobody granted is not silently unlimited.
  assert.deepEqual(entitlementFor(db, alpha, "ai-voice-minutes"), { granted: false, limit: null });

  closeDb();
});
