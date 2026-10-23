// Payments for a Pakistan-registered business.
//
// Two mechanisms, deliberately separated, because they have completely different prerequisites:
//
//   bank_transfer   an invoice with an IBAN. Works with every bank in Pakistan today, needs no
//                   merchant account, no approval, and no card data anywhere near this server.
//   card / wallet   Safepay, PayFast, or a bank merchant gateway. Needs a merchant account and
//                   company documents, and the provider holds the card. Stripe is not an option for
//                   a Pakistan-registered entity.
//
// This module implements the first completely, and reports honestly about the second rather than
// pretending an adapter exists. The state changes are the same either way, so when a merchant
// account arrives only the collection step changes.

import { id as newId, nowIso } from "./identities.mjs";
import { syncEntitlements } from "./billing.mjs";
import { writeAudit } from "./audit.mjs";

export const PROVIDERS = ["bank_transfer", "safepay", "payfast", "stripe"];

/** Card details never reach this server; these are the names we expect, not values we hold. */
export const PROVIDER_ENV = {
  safepay: ["SAFEPAY_API_KEY", "SAFEPAY_SECRET", "SAFEPAY_WEBHOOK_SECRET"],
  payfast: ["PAYFAST_MERCHANT_ID", "PAYFAST_SECURED_KEY", "PAYFAST_WEBHOOK_SECRET"],
  stripe: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
};

export function providerStatus(provider, env = process.env) {
  if (provider === "bank_transfer") {
    const needed = ["BANK_NAME", "BANK_ACCOUNT_TITLE", "BANK_IBAN"];
    const missing = needed.filter((name) => !env[name]?.trim());
    return { provider, configured: missing.length === 0, missing };
  }

  const needed = PROVIDER_ENV[provider] ?? [];
  if (!needed.length) return { provider, configured: false, missing: [], reason: "unknown_provider" };

  const missing = needed.filter((name) => !env[name]?.trim());
  return { provider, configured: missing.length === 0, missing };
}

export function bankDetails(env = process.env) {
  return {
    bankName: env.BANK_NAME?.trim() || null,
    accountTitle: env.BANK_ACCOUNT_TITLE?.trim() || null,
    accountNumber: env.BANK_ACCOUNT_NUMBER?.trim() || null,
    iban: env.BANK_IBAN?.trim() || null,
    branch: env.BANK_BRANCH?.trim() || null,
    configured: Boolean(env.BANK_NAME?.trim() && env.BANK_ACCOUNT_TITLE?.trim() && env.BANK_IBAN?.trim()),
  };
}

/**
 * Issues an invoice for one billing period. The amount comes from the plan catalogue, so a price
 * change is one edit rather than an invoice that contradicts the website.
 */
export function issueInvoice(db, orgId, planId, { periodDays = 30, dueDays = 7, now = Date.now(), note = null } = {}) {
  const plan = db.prepare("select * from plans where id = ?").get(planId);
  if (!plan) {
    const error = new Error(`Unknown plan "${planId}".`);
    error.status = 400;
    throw error;
  }

  const invoiceId = newId("inv");
  const at = new Date(now).toISOString();

  db.prepare(
    `insert into invoices
       (id, organization_id, plan_id, amount_minor, currency, period_days, method, status, reference, note, due_at, paid_at, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, 'bank_transfer', 'issued', null, ?, ?, null, ?, ?)`,
  ).run(
    invoiceId,
    orgId,
    planId,
    plan.price_minor,
    plan.currency,
    periodDays,
    note,
    new Date(now + dueDays * 86_400_000).toISOString(),
    at,
    at,
  );

  writeAudit(db, {
    orgId,
    actorUserId: null,
    action: "billing.invoice_issued",
    entity: "invoice",
    entityId: invoiceId,
    meta: { planId, amountMinor: plan.price_minor, currency: plan.currency },
  });

  return { invoiceId, amountMinor: plan.price_minor, currency: plan.currency, dueAt: new Date(now + dueDays * 86_400_000).toISOString() };
}

/**
 * Records that the money arrived. Idempotent: marking the same invoice paid twice does not extend
 * the subscription twice, which is the mistake that gives a customer a free month for one transfer
 * and a support ticket.
 */
export function markInvoicePaid(db, invoiceId, { reference = null, actorUserId = null, now = Date.now() } = {}) {
  const invoice = db.prepare("select * from invoices where id = ?").get(invoiceId);
  if (!invoice) return { ok: false, reason: "unknown_invoice" };
  if (invoice.status === "paid") return { ok: false, reason: "already_paid" };

  const at = new Date(now).toISOString();
  const periodEnd = new Date(now + (invoice.period_days ?? 30) * 86_400_000).toISOString();

  const applied = db.transaction(() => {
    const updated = db
      .prepare("update invoices set status = 'paid', reference = coalesce(?, reference), paid_at = ?, updated_at = ? where id = ? and status = 'issued'")
      .run(reference, at, at, invoiceId);

    // Lost the race with another admin: treat as already paid rather than extending twice.
    if (updated.changes === 0) return { ok: false, reason: "already_paid" };

    const subscription = db
      .prepare("select * from subscriptions where organization_id = ? order by created_at desc limit 1")
      .get(invoice.organization_id);

    if (subscription) {
      db.prepare(
        "update subscriptions set status = 'active', provider = 'bank_transfer', plan_id = ?, period_end = ? where id = ?",
      ).run(invoice.plan_id, periodEnd, subscription.id);
    } else {
      db.prepare(
        `insert into subscriptions (id, organization_id, provider, provider_id, status, plan_id, trial_end, period_end, created_at)
         values (?, ?, 'bank_transfer', null, 'active', ?, null, ?, ?)`,
      ).run(newId("sub"), invoice.organization_id, invoice.plan_id, periodEnd, at);
    }

    const entitlements = syncEntitlements(db, invoice.organization_id, invoice.plan_id, {
      now,
      status: "active",
      periodEnd,
    });

    writeAudit(db, {
      orgId: invoice.organization_id,
      actorUserId,
      action: "billing.invoice_paid",
      entity: "invoice",
      entityId: invoiceId,
      meta: { reference, amountMinor: invoice.amount_minor, currency: invoice.currency, periodEnd },
    });

    return { ok: true, invoiceId, orgId: invoice.organization_id, periodEnd, entitlements };
  });

  return applied();
}

export function invoicesFor(db, orgId, { limit = 20 } = {}) {
  return db
    .prepare("select * from invoices where organization_id = ? order by created_at desc limit ?")
    .all(orgId, limit);
}

/** What the operator still has to do, in the order that unblocks the most. */
export function paymentReadiness(env = process.env) {
  const bank = bankDetails(env);

  return {
    bankTransfer: bank.configured,
    bank,
    cards: {
      safepay: providerStatus("safepay", env),
      payfast: providerStatus("payfast", env),
    },
    note: bank.configured
      ? "Bank transfer can take money today. Issue an invoice from the billing page."
      : "Set BANK_NAME, BANK_ACCOUNT_TITLE and BANK_IBAN to switch on bank transfer invoices.",
  };
}
