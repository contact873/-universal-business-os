import "./setup.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { openTestDb, closeDb } from "../src/lib/db.mjs";
import { seedPlans } from "./fixtures.mjs";
import { createFreeAccount } from "../src/lib/onboarding.mjs";
import { issueInvoice, markInvoicePaid } from "../src/lib/payments.mjs";
import {
  upsertSubscriber,
  normalizeEmail,
  canEmail,
  setMarketingConsent,
  unsubscribe,
  offerItem,
  recordOfferOutcome,
  offersFor,
  subscribersFor,
  subscriberStats,
  setSubscriberStatus,
  toCsv,
} from "../src/lib/subscribers.mjs";

const PERSON = {
  email: "Dana@Example.test",
  name: "Dana",
  company: "Dana Clinic",
  country: "PK",
  source: "website",
};

test("an email address is normalised before it is stored, so two spellings are one person", () => {
  const db = seedPlans(openTestDb());

  const first = upsertSubscriber(db, { ...PERSON, marketingConsent: false });
  const second = upsertSubscriber(db, { email: "  dana@example.TEST ", company: "Dana Clinic Ltd" });

  assert.equal(first.created, true);
  assert.equal(second.created, false, "the same address must not become a second subscriber");
  assert.equal(first.subscriberId, second.subscriberId);
  assert.equal(second.email, "dana@example.test");
  assert.equal(db.prepare("select count(*) as n from subscribers").get().n, 1);

  // The filled field was updated, the blank ones were left alone rather than erased.
  const row = db.prepare("select * from subscribers where id = ?").get(first.subscriberId);
  assert.equal(row.company, "Dana Clinic Ltd");
  assert.equal(row.name, "Dana");
  assert.equal(row.country, "PK");

  closeDb();
});

test("a malformed address is refused rather than stored and failed later", () => {
  const db = seedPlans(openTestDb());

  for (const bad of ["", "  ", "dana", "dana@", "@example.test", "dana@example", "a b@example.test"]) {
    assert.equal(normalizeEmail(bad), null, `${JSON.stringify(bad)} must not pass`);
    assert.equal(upsertSubscriber(db, { email: bad }).ok, false);
  }

  assert.equal(db.prepare("select count(*) as n from subscribers").get().n, 0);
  closeDb();
});

test("consent is stored with its moment and source, and is not invented", () => {
  const db = seedPlans(openTestDb());
  const now = Date.parse("2026-03-01T09:00:00.000Z");

  const opted = upsertSubscriber(db, { ...PERSON, marketingConsent: true, consentSource: "signup_form" }, { now });
  const row = db.prepare("select * from subscribers where id = ?").get(opted.subscriberId);

  assert.equal(row.marketing_consent, 1);
  assert.equal(row.consent_at, "2026-03-01T09:00:00.000Z");
  assert.equal(row.consent_source, "signup_form");
  assert.equal(canEmail(row).ok, true);

  // Someone who did not tick the box is stored, and is not mailable.
  const quiet = upsertSubscriber(db, { email: "quiet@example.test", company: "Quiet Co" });
  const quietRow = db.prepare("select * from subscribers where id = ?").get(quiet.subscriberId);
  assert.equal(quietRow.marketing_consent, 0);
  assert.equal(quietRow.consent_at, null);
  assert.equal(canEmail(quietRow).ok, false);
  assert.equal(canEmail(quietRow).reason, "no_consent");

  closeDb();
});

test("a later sign-up cannot silently remove consent already given", () => {
  const db = seedPlans(openTestDb());

  const opted = upsertSubscriber(db, { ...PERSON, marketingConsent: true });
  upsertSubscriber(db, { email: PERSON.email, company: "Dana Clinic" });

  const row = db.prepare("select * from subscribers where id = ?").get(opted.subscriberId);
  assert.equal(row.marketing_consent, 1, "a form that omits consent must not revoke it");
  assert.equal(canEmail(row).ok, true);

  closeDb();
});

test("unsubscribing is final, and blocks the queue rather than the send", () => {
  const db = seedPlans(openTestDb());
  const { subscriberId } = upsertSubscriber(db, { ...PERSON, marketingConsent: true });

  const result = unsubscribe(db, "dana@example.test", { reason: "not interested" });
  assert.equal(result.ok, true);

  const row = db.prepare("select * from subscribers where id = ?").get(subscriberId);
  assert.equal(row.marketing_consent, 0, "opting out clears consent; there is no keep-marketing variant");
  assert.ok(row.unsubscribed_at);
  assert.equal(canEmail(row).reason, "unsubscribed");

  const offer = offerItem(db, subscriberId, { itemKey: "pro-upgrade", itemLabel: "Professional plan" });
  assert.equal(offer.ok, false, "an offer must not even be queued for someone who opted out");
  assert.equal(offer.reason, "unsubscribed");
  assert.equal(offersFor(db, subscriberId).length, 0);

  // Idempotent, so a repeated click is not an error the visitor has to understand.
  assert.equal(unsubscribe(db, "dana@example.test").already, true);

  closeDb();
});

test("consent can be granted later, and withdrawing it again works", () => {
  const db = seedPlans(openTestDb());
  const { subscriberId } = upsertSubscriber(db, { ...PERSON });

  assert.equal(canEmail(db.prepare("select * from subscribers where id = ?").get(subscriberId)).reason, "no_consent");

  setMarketingConsent(db, subscriberId, true, { source: "billing_page" });
  let row = db.prepare("select * from subscribers where id = ?").get(subscriberId);
  assert.equal(canEmail(row).ok, true);
  assert.equal(row.consent_source, "billing_page");

  setMarketingConsent(db, subscriberId, false);
  row = db.prepare("select * from subscribers where id = ?").get(subscriberId);
  assert.equal(canEmail(row).reason, "no_consent");

  closeDb();
});

test("future items are offered once, and the outcome is recorded", () => {
  const db = seedPlans(openTestDb());
  const { subscriberId } = upsertSubscriber(db, { ...PERSON, marketingConsent: true });

  const offer = offerItem(db, subscriberId, {
    itemKey: "ai-receptionist",
    itemLabel: "AI front desk for the clinic",
    note: "told us the phones are the problem",
  });
  assert.equal(offer.ok, true);
  assert.equal(offer.status, "queued");

  const offers = offersFor(db, subscriberId);
  assert.equal(offers.length, 1);
  assert.equal(offers[0].item_key, "ai-receptionist");

  assert.equal(recordOfferOutcome(db, offer.offerId, "sent").ok, true);
  assert.equal(recordOfferOutcome(db, offer.offerId, "accepted").ok, true);
  assert.equal(recordOfferOutcome(db, offer.offerId, "nonsense").reason, "bad_status");

  const after = offersFor(db, subscriberId)[0];
  assert.equal(after.status, "accepted");
  assert.ok(after.responded_at);

  closeDb();
});

test("a workspace sign-up lands in the registry, and paying moves it", async () => {
  const db = seedPlans(openTestDb());

  const result = await createFreeAccount(
    db,
    {
      email: "owner@clinic.test",
      password: "a-long-enough-password",
      company: "Registry Clinic",
      country: "PK",
      phone: "+92 300 0000000",
      marketingConsent: true,
    },
    { sendEmail: null },
  );

  assert.ok(result.subscriberId, "signing up must create a subscriber row");

  let row = db.prepare("select * from subscribers where id = ?").get(result.subscriberId);
  assert.equal(row.email_normalized, "owner@clinic.test");
  assert.equal(row.status, "free");
  assert.equal(row.plan_id, "free");
  assert.equal(row.organization_id, result.orgId, "the row is linked to the workspace");
  assert.equal(row.user_id, result.userId);
  assert.equal(row.phone, "+92 300 0000000");
  assert.equal(canEmail(row).ok, true);

  // Upgrading is recorded, so the list can be filtered to paying customers.
  const invoice = issueInvoice(db, result.orgId, "professional");
  markInvoicePaid(db, invoice.invoiceId, { reference: "TRX-1" });

  row = db.prepare("select * from subscribers where id = ?").get(result.subscriberId);
  assert.equal(row.status, "paying");
  assert.equal(row.plan_id, "professional");

  const stats = subscriberStats(db);
  assert.equal(stats.total, 1);
  assert.equal(stats.paying, 1);
  assert.equal(stats.free, 0);
  assert.equal(stats.mailable, 1);
  assert.equal(stats.conversionRate, 1);

  closeDb();
});

test("the list can be filtered by status, plan, consent and text", () => {
  const db = seedPlans(openTestDb());

  upsertSubscriber(db, { email: "a@alpha.test", company: "Alpha Clinic", marketingConsent: true, status: "free", planId: "free" });
  upsertSubscriber(db, { email: "b@beta.test", company: "Beta Spa", marketingConsent: false, status: "paying", planId: "professional" });
  upsertSubscriber(db, { email: "c@gamma.test", company: "Gamma Dental", marketingConsent: true, status: "free", planId: "free" });

  assert.equal(subscribersFor(db, {}).length, 3);
  assert.equal(subscribersFor(db, { status: "free" }).length, 2);
  assert.equal(subscribersFor(db, { planId: "professional" }).length, 1);
  assert.equal(subscribersFor(db, { consentedOnly: true }).length, 2);
  assert.equal(subscribersFor(db, { q: "spa" }).length, 1, "search is case-insensitive on the company");
  assert.equal(subscribersFor(db, { q: "gamma" }).length, 1);

  const moved = setSubscriberStatus(db, { email: "a@alpha.test", status: "cancelled" });
  assert.equal(moved.ok, true);
  assert.equal(subscribersFor(db, { status: "cancelled" }).length, 1);
  assert.equal(setSubscriberStatus(db, { email: "a@alpha.test", status: "nope" }).reason, "bad_status");

  closeDb();
});

test("the export quotes anything containing a comma, so a spreadsheet can open it", () => {
  const csv = toCsv([
    { email: "a@alpha.test", name: 'Dana "Dee" Khan', company: "Alpha, Clinic", status: "free" },
    { email: "b@beta.test", name: null, company: null, status: "paying" },
  ]);

  const lines = csv.trim().split("\n");
  assert.equal(lines[0].startsWith("email,name,company"), true);
  assert.ok(lines[1].includes('"Alpha, Clinic"'), "a comma in a value must be quoted");
  assert.ok(lines[1].includes('"Dana ""Dee"" Khan"'), "a quote inside a value must be doubled");
  assert.equal(lines[2].includes(",,,"), true, "empty values stay empty, not 'null'");

  assert.equal(lines[1].startsWith("a@alpha.test,"), true);
  assert.equal(lines[2].startsWith("b@beta.test,"), true);
  // Plain values stay unquoted, so it opens as a table rather than a wall of quotes.
  assert.equal(lines[1].includes('a@alpha.test,"Dana'), true);
  assert.equal(lines[1].split(",").length > 3, true, "the row keeps its many columns");
});
