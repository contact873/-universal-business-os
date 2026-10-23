// Shared test fixture.
//
// Two organisations, not one. A single workspace cannot demonstrate the only claim that really
// matters here, which is that one business cannot reach another's data.

import { openTestDb } from "../src/lib/db.mjs";
import { createUser, createOrganization, addMember } from "../src/lib/accounts.mjs";
import { createTenantStore } from "../src/lib/tenant.mjs";
import { ensurePlans } from "../src/lib/plans.mjs";

export const TEST_PASSWORD = "a-long-enough-password";

export function seedPlans(db) {
  // The real catalogue, so a price or limit change cannot make the tests disagree with the product.
  ensurePlans(db);
  return db;
}


export function fixture({ withLeads = true } = {}) {
  const db = seedPlans(openTestDb());
  const store = createTenantStore(db);

  const alice = createUser(db, { email: "alice@alpha.test", password: TEST_PASSWORD, name: "Alice" });
  const bob = createUser(db, { email: "bob@beta.test", password: TEST_PASSWORD, name: "Bob" });
  const carol = createUser(db, { email: "carol@alpha.test", password: TEST_PASSWORD, name: "Carol" });

  const alpha = createOrganization(db, {
    name: "Alpha Clinic",
    ownerUserId: alice.userId,
    plan: "starter",
    industry: "med-spa",
  });
  const beta = createOrganization(db, {
    name: "Beta Consulting",
    ownerUserId: bob.userId,
    plan: "starter",
    industry: "consulting",
  });

  // Carol is staff at Alpha only. She is the fixture for "can write, cannot invite".
  addMember(db, alpha.orgId, carol.userId, "staff");

  const captured = {};

  if (withLeads) {
    captured.alpha = store.capture(
      alpha.orgId,
      { name: "Jane Okafor", mobile: "+971501234567", message: "Alpha enquiry" },
      { source: "website", tags: ["clinic"], defaultCountry: "+971" },
    );

    // The same person, same phone number, in a different workspace.
    captured.beta = store.capture(
      beta.orgId,
      { name: "Jane Okafor", mobile: "+971501234567", message: "Beta enquiry" },
      { source: "referral", tags: ["consulting"], defaultCountry: "+971" },
    );
  }

  return {
    db,
    store,
    captured,
    alpha: alpha.orgId,
    beta: beta.orgId,
    alice: alice.userId,
    bob: bob.userId,
    carol: carol.userId,
  };
}
