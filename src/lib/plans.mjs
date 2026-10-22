// The plan catalogue, as product configuration rather than demo data.
//
// Seeding is for demos and is refused in production. Plans are not: a deployed platform with no
// plans cannot create a workspace, because a workspace starts on a plan. So both the demo seed and
// the production admin script call this, and it is idempotent.

export const PLAN_DEFINITIONS = [
  {
    id: "starter",
    name: "Starter",
    priceMinor: 1900,
    currency: "USD",
    exponent: 2,
    interval: "month",
    limits: { contacts: 250, seats: 2 },
  },
  {
    id: "professional",
    name: "Professional",
    priceMinor: 4900,
    currency: "USD",
    exponent: 2,
    interval: "month",
    limits: { contacts: 2500, seats: 10 },
  },
  {
    id: "business",
    name: "Business AI",
    priceMinor: 9900,
    currency: "USD",
    exponent: 2,
    interval: "month",
    limits: { contacts: 25000, seats: 50 },
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
      `insert into plans (id, name, price_minor, currency, exponent, interval, limits_json)
       values (?, ?, ?, ?, ?, ?, ?)
       on conflict (id) do update set
         name = excluded.name,
         price_minor = excluded.price_minor,
         currency = excluded.currency,
         exponent = excluded.exponent,
         interval = excluded.interval,
         limits_json = excluded.limits_json`,
    ).run(
      plan.id,
      plan.name,
      plan.priceMinor,
      plan.currency,
      plan.exponent,
      plan.interval,
      JSON.stringify(plan.limits),
    );
    changed += 1;
  }

  return { plans: changed };
}
