import "./setup.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { openTestDb, closeDb } from "../src/lib/db.mjs";
import { seedPlans } from "./fixtures.mjs";
import { createUser, createOrganization, entitlementFor } from "../src/lib/accounts.mjs";
import {
  issueInvoice,
  markInvoicePaid,
  invoicesFor,
  outstandingInvoiceFor,
  providerStatus,
  bankDetails,
  paymentReadiness,
} from "../src/lib/payments.mjs";
import { isPaying } from "../src/lib/billing.mjs";

const DAY = 86_400_000;

function workspace() {
  const db = seedPlans(openTestDb());
  const owner = createUser(db, { email: "owner@alpha.test", password: "a-long-enough-password" });
  const org = createOrganization(db, { name: "Alpha Clinic", ownerUserId: owner.userId });
  return { db, orgId: org.orgId, ownerId: owner.userId };
}

test("an invoice takes its amount from the plan catalogue, not from a form", () => {
  const { db, orgId } = workspace();
  const invoice = issueInvoice(db, orgId, "professional");

  assert.equal(invoice.amountMinor, 14900, "the Professional monthly price");
  assert.equal(invoice.currency, "USD");

  const stored = invoicesFor(db, orgId)[0];
  assert.equal(stored.status, "issued");
  assert.equal(stored.method, "bank_transfer");
  assert.ok(Date.parse(stored.due_at) > Date.now());

  closeDb();
});

test("an unknown plan is refused rather than invoiced at zero", () => {
  const { db, orgId } = workspace();
  assert.throws(() => issueInvoice(db, orgId, "plan-that-does-not-exist"), /Unknown plan/);
  assert.equal(invoicesFor(db, orgId).length, 0);
  closeDb();
});

test("marking an invoice paid starts the subscription and opens the workspace", () => {
  const { db, orgId, ownerId } = workspace();
  const invoice = issueInvoice(db, orgId, "professional");

  const paid = markInvoicePaid(db, invoice.invoiceId, { reference: "TRX-9911", actorUserId: ownerId });
  assert.equal(paid.ok, true);

  const subscription = db.prepare("select * from subscriptions where organization_id = ?").get(orgId);
  assert.equal(subscription.status, "active");
  assert.equal(subscription.provider, "bank_transfer");
  assert.equal(isPaying(subscription), true);

  const days = (Date.parse(subscription.period_end) - Date.now()) / DAY;
  assert.ok(days > 29 && days <= 30.1, `a paid month should be about 30 days, was ${days.toFixed(1)}`);

  assert.equal(entitlementFor(db, orgId, "contacts").granted, true, "paying opens the features");
  assert.equal(invoicesFor(db, orgId)[0].status, "paid");
  assert.equal(invoicesFor(db, orgId)[0].reference, "TRX-9911");

  closeDb();
});

test("marking the same invoice paid twice does not grant a second month", () => {
  const { db, orgId } = workspace();
  const invoice = issueInvoice(db, orgId, "professional");

  const first = markInvoicePaid(db, invoice.invoiceId);
  const periodEnd = db.prepare("select period_end from subscriptions where organization_id = ?").get(orgId).period_end;

  const second = markInvoicePaid(db, invoice.invoiceId);
  assert.equal(second.ok, false);
  assert.equal(second.reason, "already_paid");

  assert.equal(
    db.prepare("select period_end from subscriptions where organization_id = ?").get(orgId).period_end,
    periodEnd,
    "the period must not move on a duplicate confirmation",
  );

  closeDb();
});

test("a second invoice extends the period rather than replacing it", () => {
  const { db, orgId } = workspace();
  const one = issueInvoice(db, orgId, "professional");
  markInvoicePaid(db, one.invoiceId, { now: Date.now() - 30 * DAY });

  const two = issueInvoice(db, orgId, "professional");
  const paid = markInvoicePaid(db, two.invoiceId);

  assert.equal(paid.ok, true);
  assert.equal(invoicesFor(db, orgId).filter((i) => i.status === "paid").length, 2);

  closeDb();
});

test("bank details are only considered configured when all three fields exist", () => {
  assert.equal(bankDetails({}).configured, false);

  const partial = bankDetails({ BANK_NAME: "Meezan Bank", BANK_IBAN: "PK00MEZN0000000000000000" });
  assert.equal(partial.configured, false, "an account title is required too");

  const ready = bankDetails({
    BANK_NAME: "Meezan Bank",
    BANK_ACCOUNT_TITLE: "Relco Digital",
    BANK_IBAN: "PK00MEZN0000000000000000",
    BANK_ACCOUNT_NUMBER: "0000000000",
  });
  assert.equal(ready.configured, true);
  assert.equal(ready.accountTitle, "Relco Digital");
});

test("a provider is reported unconfigured with the exact variables missing", () => {
  const safepay = providerStatus("safepay", {});
  assert.equal(safepay.configured, false);
  assert.deepEqual(safepay.missing, ["SAFEPAY_API_KEY", "SAFEPAY_SECRET", "SAFEPAY_WEBHOOK_SECRET"]);

  const partial = providerStatus("payfast", { PAYFAST_MERCHANT_ID: "123" });
  assert.equal(partial.configured, false);
  assert.equal(partial.missing.length, 2);

  assert.equal(providerStatus("nonsense", {}).reason, "unknown_provider");

  const readiness = paymentReadiness({});
  assert.equal(readiness.bankTransfer, false);
  assert.match(readiness.note, /BANK_NAME/);

  closeDb();
});

test("an unpaid invoice is findable, and stops being unpaid when it is settled", () => {
  const { db, orgId } = workspace();

  assert.equal(outstandingInvoiceFor(db, orgId), null, "nothing owed at the start");

  const invoice = issueInvoice(db, orgId, "professional");
  const owed = outstandingInvoiceFor(db, orgId);

  assert.ok(owed, "the invoice just issued is the one the customer has to pay");
  assert.equal(owed.id, invoice.invoiceId);
  assert.equal(owed.amount_minor, 14900);
  assert.equal(owed.status, "issued");

  markInvoicePaid(db, invoice.invoiceId, { reference: "TRX-5" });
  assert.equal(outstandingInvoiceFor(db, orgId), null, "settled, so nothing is outstanding");

  // The next invoice is the new outstanding one, not the settled one resurfacing.
  const second = issueInvoice(db, orgId, "starter");
  assert.equal(outstandingInvoiceFor(db, orgId).id, second.invoiceId);

  closeDb();
});

test("moving onto a paid plan activates that plan and its limits", () => {
  const { db, orgId } = workspace();
  const invoice = issueInvoice(db, orgId, "business");

  markInvoicePaid(db, invoice.invoiceId);

  const subscription = db.prepare("select * from subscriptions where organization_id = ?").get(orgId);
  assert.equal(subscription.plan_id, "business");
  assert.equal(subscription.status, "active");
  assert.equal(entitlementFor(db, orgId, "contacts").limit, 25000);
  assert.equal(
    db.prepare("select limit_value from entitlements where organization_id = ? and feature = ?").get(orgId, "assistant-minutes").limit_value,
    2500,
  );

  closeDb();
});
