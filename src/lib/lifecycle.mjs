// The conversion lifecycle: what happens to a subscription when nobody is watching.
//
// Runs on a schedule and does the things that are purely mechanical:
//
//   * a trial that ended is resolved, one way or the other, the same day
//   * an active workspace on bank transfer gets its next invoice issued, once
//   * a subscription past its grace period falls back to the free plan rather than silently continuing
//   * a workspace that has been downgraded for a month with consent becomes a win-back candidate
//
// It deliberately does NOT charge cards. Charging requires a payment provider, and a charge is the one
// action that must never be simulated: a "successful" charge with nothing behind it is a lie the
// customer discovers from their bank statement. When a provider exists, it produces the event that
// moves the subscription, and this module handles everything around that event.
//
// Every action is idempotent and audited. Running the job twice in a minute is safe, which matters
// because a scheduler will eventually run twice in a minute.

import { id as newId } from "./identities.mjs";
import { writeAudit } from "./audit.mjs";
import { syncEntitlements } from "./billing.mjs";
import { issueInvoice, outstandingInvoiceFor } from "./payments.mjs";
import { setSubscriberStatus, offerItem } from "./subscribers.mjs";

const DAY = 86_400_000;
export const GRACE_DAYS = 7;
export const WIN_BACK_AFTER_DAYS = 30;

/** Idempotency for lifecycle actions, keyed by what the action is about rather than by time. */
function alreadyDone(db, key) {
  return Boolean(db.prepare("select 1 as yes from lifecycle_actions where key = ?").get(key));
}

function recordAction(db, { key, kind, orgId, now, meta = {} }) {
  try {
    db.prepare(
      "insert into lifecycle_actions (key, kind, organization_id, at) values (?, ?, ?, ?)",
    ).run(key, kind, orgId, new Date(now).toISOString());
  } catch {
    return false;
  }
  return true;
}

function latestSubscription(db, orgId) {
  return db
    .prepare("select * from subscriptions where organization_id = ? order by created_at desc limit 1")
    .get(orgId);
}

function downgradeToFree(db, orgId, { now, reason }) {
  const at = new Date(now).toISOString();
  const current = latestSubscription(db, orgId);

  // The free plan is the floor, never a hole: a workspace keeps its data and its access to the free
  // tier rather than being switched off. Losing access is reserved for the end of a cancellation.
  db.prepare(
    `insert into subscriptions (id, organization_id, provider, provider_id, status, plan_id, trial_end, period_end, created_at)
     values (?, ?, 'system', null, 'active', 'free', null, null, ?)`,
  ).run(newId("sub"), orgId, at);

  const entitlements = syncEntitlements(db, orgId, "free", { now, status: "active", periodEnd: null });

  try {
    setSubscriberStatus(db, { organizationId: orgId, status: "free", planId: "free" }, { now });
  } catch (error) {
    // The registry is a marketing convenience; failing to update it must not undo the downgrade.
  }

  writeAudit(db, {
    orgId,
    actorUserId: null,
    action: "lifecycle.downgraded_to_free",
    entity: "subscription",
    entityId: current?.id ?? null,
    meta: { reason, previousPlan: current?.plan_id ?? null },
  });

  return { orgId, reason, entitlements };
}

/**
 * Runs every rule, in an order that matters: expired trials first, then renewals, then grace, then
 * win-back. A subscription is only ever acted on once per run.
 */
export function runLifecycle(db, { now = Date.now() } = {}) {
  const actions = [];
  const skipped = [];

  const subscriptions = db
    .prepare("select * from subscriptions order by created_at desc")
    .all();

  // Only the newest subscription per workspace is the live one.
  const live = new Map();
  for (const subscription of subscriptions) {
    if (!live.has(subscription.organization_id)) live.set(subscription.organization_id, subscription);
  }

  for (const [orgId, subscription] of live) {
    // 1. A trial that has ended.
    if (subscription.status === "trialing" && subscription.trial_end && Date.parse(subscription.trial_end) <= now) {
      const key = `trial-ended:${subscription.id}`;
      if (alreadyDone(db, key)) {
        skipped.push({ orgId, reason: "trial already resolved" });
        continue;
      }

      if (subscription.card_on_file_at && subscription.provider_customer_id) {
        // A card exists, so the next step belongs to the payment provider. Until its event arrives the
        // subscription sits in past_due: access continues, and the customer is not cut off while a bank
        // decides whether to authorise.
        db.prepare("update subscriptions set status = 'past_due' where id = ?").run(subscription.id);
        recordAction(db, { key, kind: "trial_ended_charge_due", orgId, now, meta: { planId: subscription.plan_id } });
        writeAudit(db, {
          orgId,
          actorUserId: null,
          action: "lifecycle.trial_ended_awaiting_charge",
          entity: "subscription",
          entityId: subscription.id,
          meta: { planId: subscription.plan_id },
        });
        actions.push({ orgId, action: "awaiting_charge", planId: subscription.plan_id });
      } else {
        const result = downgradeToFree(db, orgId, { now, reason: "trial ended without a card" });
        recordAction(db, { key, kind: "trial_ended_to_free", orgId, now });
        actions.push({ orgId, action: "downgraded", reason: result.reason });
      }
      continue;
    }

    // 2. An active subscription whose period has ended.
    if (subscription.status === "active" && subscription.period_end && Date.parse(subscription.period_end) <= now) {
      const periodKey = `renewal:${orgId}:${String(subscription.period_end).slice(0, 10)}`;
      if (alreadyDone(db, periodKey)) {
        skipped.push({ orgId, reason: "renewal already handled" });
        continue;
      }

      if (subscription.provider === "bank_transfer") {
        const outstanding = outstandingInvoiceFor(db, orgId);
        if (outstanding) {
          skipped.push({ orgId, reason: "invoice already outstanding" });
          continue;
        }
        issueInvoice(db, orgId, subscription.plan_id);
        recordAction(db, { key: periodKey, kind: "renewal_invoice_issued", orgId, now, meta: { planId: subscription.plan_id } });
        actions.push({ orgId, action: "invoice_issued", planId: subscription.plan_id });
      } else {
        // A card subscription renews through the provider. Nothing here charges anybody.
        recordAction(db, { key: periodKey, kind: "renewal_charge_due", orgId, now });
        writeAudit(db, {
          orgId,
          actorUserId: null,
          action: "lifecycle.renewal_awaiting_charge",
          entity: "subscription",
          entityId: subscription.id,
          meta: { planId: subscription.plan_id },
        });
        actions.push({ orgId, action: "awaiting_renewal_charge", planId: subscription.plan_id });
      }
      continue;
    }

    // 3. Past due beyond the grace period.
    if (subscription.status === "past_due") {
      const since = subscription.period_end ? Date.parse(subscription.period_end) : null;
      const overdue = since !== null && now - since > GRACE_DAYS * DAY;
      if (overdue) {
        const key = `past-due-grace:${subscription.id}`;
        if (alreadyDone(db, key)) {
          skipped.push({ orgId, reason: "grace already applied" });
          continue;
        }
        const result = downgradeToFree(db, orgId, { now, reason: "payment not received within the grace period" });
        recordAction(db, { key, kind: "past_due_to_free", orgId, now });
        actions.push({ orgId, action: "downgraded", reason: result.reason });
      } else {
        skipped.push({ orgId, reason: "inside the grace period" });
      }
      continue;
    }
  }

  // 4. Win-back: downgraded a month ago, consented, still on the free plan.
  const candidates = db
    .prepare(
      `select id, organization_id, updated_at, marketing_consent
         from subscribers
        where status = 'free' and marketing_consent = 1 and unsubscribed_at is null`,
    )
    .all();

  for (const subscriber of candidates) {
    const downgradedOn = Date.parse(subscriber.updated_at ?? "");
    if (!Number.isFinite(downgradedOn) || now - downgradedOn < WIN_BACK_AFTER_DAYS * DAY) continue;

    const result = offerItem(db, subscriber.id, {
      itemKey: "pro-upgrade",
      itemLabel: "Professional, with the assistant",
      channel: "email",
      note: "Automatic win-back after a month on the free plan",
      now,
    });

    if (result.ok) actions.push({ orgId: subscriber.organization_id, action: "win_back_offered" });
  }

  return { actions, skipped, at: new Date(now).toISOString() };
}

/** A one-line summary for a cron log, because a cron log is read at a glance or not at all. */
export function summarise(result) {
  const counts = result.actions.reduce((acc, row) => {
    acc[row.action] = (acc[row.action] ?? 0) + 1;
    return acc;
  }, {});
  const parts = Object.entries(counts).map(([key, value]) => `${key} ${value}`);
  return parts.length ? parts.join(", ") : "nothing to do";
}
