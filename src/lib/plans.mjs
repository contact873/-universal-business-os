// The plan catalogue, as product configuration rather than demo data.
//
// Two rules shaped this:
//
//   1. Every tier pairs a monthly price with a setup fee and a live-in time. A price on its own is
//      not an offer; the buyer needs to know what it costs to start and how long until it works.
//   2. The entry tier is a wedge, not a trap. It does one narrow thing well, proves itself on the
//      customer's own traffic, and is deliberately not the tier you want most people to buy.
//
// The numeric values below are proposals, not commitments. They live in one place so that changing
// a price is one edit and a deploy, rather than a hunt through templates.
//
// HOW THE FREE PLAN IS LIMITED, and why this way:
//
//   Not by time. A free plan that expires after fourteen days is a trial wearing a costume, and it
//   produces exactly the thing a business cannot afford: a customer who signed up, never got round
//   to using it, and now associates the brand with a deadline. The free plan never expires.
//
//   By growth. Contacts and seats are standing counts. Reaching one refuses new records and nothing
//   else: existing data stays readable, searchable and editable, and nothing is ever deleted to
//   enforce a limit. A business hits the ceiling in a busy month, understands what the next tier
//   buys, and upgrades from the billing page with its data already in place.
//
//   By allowance, for the things that cost money to run. Assistant minutes and SMS reset on the
//   first of the month, so one busy week cannot burn an account permanently. When an allowance runs
//   out the features route to a person rather than failing in front of a customer.

export const PLAN_DEFINITIONS = [
  {
    id: "free",
    name: "Free",
    priceMinor: 0,
    setupMinor: 0,
    liveInDays: 0,
    currency: "USD",
    exponent: 2,
    interval: "month",
    // Free forever, and deliberately limited so it is useful rather than a demo. A business can
    // run real enquiries through it, hit the ceiling in a busy month, and know exactly what the
    // next tier buys. It never expires, so it never needs a card and can never produce a chargeback.
    limits: { contacts: 100, seats: 2, "assistant-minutes": 0, "sms-messages": 100 },
  },
  {
    id: "starter",
    name: "Starter",
    priceMinor: 4900,
    setupMinor: 10000,
    liveInDays: 2,
    currency: "USD",
    exponent: 2,
    interval: "month",
    // Retired once the free plan began including two people: at that point Starter differed only in
    // volume, and a paid tier whose only argument is size is a harder sale than no tier at all.
    //
    // It is kept here rather than deleted, because an invoice, a report or a support ticket from last
    // month may reference it and a missing row makes those unreadable. Retired means not selectable,
    // not erased. Existing workspaces on it keep working.
    retired: true,
    limits: { contacts: 500, seats: 2, "assistant-minutes": 0, "sms-messages": 500 },
  },
  {
    id: "professional",
    name: "Professional",
    priceMinor: 14900,
    setupMinor: 30000,
    liveInDays: 5,
    currency: "USD",
    exponent: 2,
    interval: "month",
    // The tier the product is designed around: inbound calls and SMS, qualification, handoff.
    limits: { contacts: 5000, seats: 10, "assistant-minutes": 600, "sms-messages": 3000 },
  },
  {
    id: "business",
    name: "Business AI",
    priceMinor: 29900,
    setupMinor: 50000,
    liveInDays: 10,
    currency: "USD",
    exponent: 2,
    interval: "month",
    limits: { contacts: 25000, seats: 50, "assistant-minutes": 2500, "sms-messages": 10000 },
  },
];

/**
 * Inserts or updates every plan. Updating rather than ignoring means a price change is a deploy,
 * not a manual database edit that somebody forgets on one environment.
 */
export function ensurePlans(db) {
  let changed = 0;

  for (const plan of PLAN_DEFINITIONS) {
    db.prepare(
      `insert into plans (id, name, price_minor, setup_minor, live_in_days, currency, exponent, interval, limits_json)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (id) do update set
         name = excluded.name,
         price_minor = excluded.price_minor,
         setup_minor = excluded.setup_minor,
         live_in_days = excluded.live_in_days,
         currency = excluded.currency,
         exponent = excluded.exponent,
         interval = excluded.interval,
         limits_json = excluded.limits_json`,
    ).run(
      plan.id,
      plan.name,
      plan.priceMinor,
      plan.setupMinor,
      plan.liveInDays,
      plan.currency,
      plan.exponent,
      plan.interval,
      JSON.stringify(plan.limits),
    );
    changed += 1;
  }

  return { plans: changed };
}

/** A plan rendered for a pricing page: monthly, setup, live-in, and the limits in plain words. */
// What can be chosen today. A retired plan still exists in the database so old references resolve,
// but it is never offered: offering a price you have withdrawn is how a customer ends up on a plan
// nobody supports.
export const SELECTABLE_PLANS = PLAN_DEFINITIONS.filter((plan) => !plan.retired).map((plan) => plan.id);
const RETIRED = new Set(PLAN_DEFINITIONS.filter((plan) => plan.retired).map((plan) => plan.id));

export function planForDisplay(db, { includeRetired = false } = {}) {
  const rows = db.prepare("select * from plans order by price_minor asc").all();
  return rows
    .filter((row) => includeRetired || !RETIRED.has(row.id))
    .map((row) => ({
      id: row.id,
      name: row.name,
      monthly: row.price_minor / 100,
      setup: row.setup_minor === null ? null : row.setup_minor / 100,
      liveInDays: row.live_in_days,
      currency: row.currency,
      limits: row.limits_json ? JSON.parse(row.limits_json) : {},
      retired: RETIRED.has(row.id),
    }));
}
