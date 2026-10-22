# Universal Business OS

One platform, many businesses. Each business gets a private workspace holding its own contacts,
enquiries and pipeline. You run one backend and one deployment.

This is **milestone 1**: the tenant core and the CRM. Everything else in the wider blueprint is
listed at the bottom as not built, and nothing in the interface pretends otherwise.

---

## What actually works today

| Works | Detail |
|---|---|
| Accounts | Sign up, sign in, sign out, scrypt password hashing, session revocation |
| Workspaces | Create, membership, five roles, workspace switching, invitations recorded |
| Isolation | One business cannot read or change another's records, proven over HTTP |
| CRM | Contacts with multiple identities, tags, first-touch source, deduplication |
| Leads | Pipeline stages, per-lead history, notes, assignment |
| Audit | Every consequential action recorded, credentials redacted before storage |
| Entitlements | Plan limits readable and enforced on the server, checked before a contact is added |
| Billing events | Verified webhook signatures, idempotent handling, subscription state, entitlements synced on upgrade and revoked on downgrade |
| Public intake | A website posts enquiries in with a workspace intake key |
| Health | `/api/health` touches the database, so it fails when the database is down |

## What is deliberately not built

- **No payment provider adapter.** No card is charged and no checkout URL is returned. Everything
  around it is built and tested: the signed webhook path, the idempotency, the subscription state
  machine, the grace period, and server-side enforcement of the plan limits. What is missing is the
  handful of lines that talk to a specific provider's API, which cannot be written honestly without
  an account to test against.
- **No messaging channels.** No WhatsApp, no Instagram, no voice.
- **No AI assistant.**
- **No email sending.** Invitations are recorded in the database and not sent.
- **No bookings module.** The blueprint's scheduling comes next.

---

## Run it

```bash
cd ~/Documents/apps/universal-business-os
npm install

cp .env.example .env.local
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# put that value in .env.local as SESSION_SECRET

npm run migrate        # applies supabase/migrations/sqlite
npm run seed           # two demo workspaces, plans, and a platform admin
npm run dev            # http://127.0.0.1:3000
```

`npm run seed` prints the two owner emails and the shared demo password. Sign in as each and
confirm they see different rows. That is the point of the product.

---

## Verification

Every claim above is checkable. Nothing here reports success it did not observe.

```bash
npm run verify:all        # drift self-check, drift, 53 unit assertions
npm run build             # production build, 12 routes
npm run preflight         # the deployment skill's gate, needs production values present

# end to end, needs the server running:
npm run start -- -p 3210
npm run verify:http       # 23 checks: reachability, storage, dedupe, refusals, rate limit
SESSION_SECRET=<same value as the server> npm run verify:isolation   # 17 checks
```

Recorded results at the time of writing:

| Suite | Result |
|---|---|
| Unit and integration (`node --test`) | 74 passed, 0 failed |
| Drift self-check | 11 passed, 0 failed |
| Schema drift between dialects | in sync, 17 tables, 10 tenant tables with policies |
| HTTP checks against a running server | 32 passed, 0 failed |
| Isolation proof over HTTP | 17 passed, 0 failed |
| Vendored `guard.mjs` self-test | 58 passed, 0 failed |
| Vendored audience store self-test | 83 passed, 0 failed |
| Production build | 14 routes, no type errors |
| Deployment preflight | CLEAR TO DEPLOY, 13 checks, 1 warning |

### The isolation proof, in plain terms

`scripts/prove-isolation.mjs` mints a real session for each workspace owner using the
application's own session module, then requests the dashboard and the contact list with each
session. It then asserts that each owner sees a contact name unique to their own workspace, and
that the other workspace's unique contact names and business name appear in **neither** page.
It also confirms a session with no workspace is redirected, and that a revoked session is refused
even though its signature is still valid.

---

## Layout

```
src/lib/
  guard.mjs        vendored from the api-and-auth skill, unmodified
  identities.mjs   re-exports the identity helpers from the lead-capture skill
  vendor/          the lead-capture skill, verbatim, for provenance
  passwords.mjs    scrypt hashing and verification
  sessions.mjs     signed cookie plus a database row, so revocation works
  roles.mjs        owner, admin, manager, staff, viewer; per-record checks
  tenant.mjs       the only module that touches tenant-owned tables
  audit.mjs        the audit trail, with redaction
  accounts.mjs     users, organisations, memberships, entitlements
  billing.mjs      provider events in, subscription state and entitlements out
  subscription-state.mjs   the single rule for whether a subscription still pays
  config.mjs       every environment read, in one place
  types.ts         the typed contract for the plain JavaScript modules
supabase/
  migrations/sqlite/     numbered migrations, applied by scripts/migrate.mjs
  migrations/postgres/   the same migrations for Supabase
  policies/rls.sql       row level security, the database-side tenant boundary
scripts/
  migrate.mjs  drift.mjs  seed.mjs  verify.mjs  prove-isolation.mjs
tests/         53 assertions across passwords, sessions, roles, CRM, isolation, drift
```

---

## How tenancy is enforced, twice

**In the application.** `src/lib/tenant.mjs` is the only module that reads or writes
tenant-owned tables. Every function takes an organisation id first and refuses to run without
one. Writes return the number of changed rows, so a cross-tenant update reports zero rather than
silently succeeding. `tests/isolation.test.mjs` asserts both directions: nothing is readable and
nothing is changed.

**In the database.** `supabase/policies/rls.sql` enables row level security on every tenant table
and grants access only through membership. It is the backstop for a future feature that forgets
the filter. `scripts/drift.mjs` fails the build if a table with an `organization_id` is missing
from that policy file, which is the mistake that would otherwise be invisible.

### One deliberate deviation from the lead-capture skill

The skill's identity table is `UNIQUE(kind, value_normalized)` globally, so two businesses could
never both hold the same customer: the second insert would collide. Here the key is
`UNIQUE(organization_id, kind, value_normalized)`. Two businesses may hold the same person, and
that case is tested in both dialects by `tests/drift.test.mjs`.

---

## Billing, and the four rules it follows

Billing state is decided by **verified provider events, never by the customer landing back on a
success page**. A browser redirect can be forged, replayed, or simply never happen because the
customer closed the tab after paying.

| Rule | Why |
|---|---|
| **Idempotent by event id** | Providers retry. The uniqueness is enforced by the database, not by an application check, because two retries arriving together would both pass a check |
| **Fail closed** | With no webhook secret configured, the endpoint answers 503 and refuses everything. An endpoint that trusts an unsigned body because a secret was forgotten is worse than one that is switched off |
| **Grace, not disconnection** | A failed payment marks the subscription `past_due` and access continues to the end of the period already paid for. Losing a clinic because a card expired on a Friday is not a business anyone wants |
| **Revoke on downgrade** | Sync removes entitlements the new plan does not include. A downgrade that only adds entitlements is not a downgrade |

Two things worth knowing about the shape of it:

- A webhook about a subscription the platform does not know is **recorded and ignored**, because
  creating a customer from a webhook alone would mean anything able to sign an event can create a
  paying account.
- The plan limit is re-checked against the subscription on every use. Entitlement rows survive a
  lapse, so checking only the row would let a non-paying workspace keep using a paid feature. That
  inconsistency existed in the first draft of this code and a test now fails if it returns.

Stripe is mapped (`customer.subscription.*`, `invoice.paid`, `invoice.payment_failed`) and its
signature scheme is implemented with the timestamp check that stops a captured request being
replayed. It is **unverified against Stripe**, because there is no account to test against. To
switch it on: set `STRIPE_WEBHOOK_SECRET`, then write the adapter in
`src/app/api/billing/checkout/route.ts` that returns a checkout URL, and set
`PAYMENT_PROVIDER_KEY`. Until then that route answers 503 and says so.

To exercise the whole path without a payment account, set `BILLING_WEBHOOK_SECRET` and run the
checks below. Nine of the HTTP checks drive exactly that path.

---

## Deploying

The app **refuses to start on a serverless host without `DATABASE_URL`**. That is intentional: on
Vercel the filesystem is read-only and `/tmp` is per-instance, so storing customer records there
loses them silently. It fails loudly instead.

**Recommended: Vercel plus Turso.** Turso is libSQL, so the SQL we already have stays the same,
and it is one environment variable.

1. Create a Turso database and copy its URL and token.
2. In Vercel, set `SESSION_SECRET`, `DATABASE_URL`, `PLATFORM_ADMIN_EMAILS` and `APP_URL`.
3. Deploy, then point `app.connect.raschident.com` at the Vercel project with a CNAME.
4. Apply migrations against the hosted database before the first request.

**Or: Supabase.** Apply `supabase/migrations/postgres` with the Supabase CLI, then apply
`supabase/policies/rls.sql`. Read the note in that file about swapping `app_current_user()` for
`auth.uid()`. Until the RLS policies are applied, a table without a policy is open to any holder
of the anon key.

---

## Next

1. The provider adapter that returns a checkout URL, once an account exists to test against. The
   webhook path behind it is finished.
2. Bookings and staff calendars.
3. Email delivery for invitations and lead notifications.
4. One messaging channel, live only when it genuinely is.
5. The AI assistant, with tool permissions scoped to one workspace and a human handoff.

---

## What this file is careful not to claim

Two mistakes are easy to make in a README and expensive to make in a business: saying something
works when it has not been run, and saying a feature exists when only its scaffolding does.

So, plainly: the numbers in the verification table were observed by running the commands above, on
this machine, and the failures they caught are recorded in the commit history. The billing webhook
path is proven over HTTP and in unit tests, and the **Stripe mapping is unverified** because there
is no Stripe account. No payment has ever been taken. No messaging channel exists. The AI assistant
does not exist. Where this file says a thing is not built, it is not built.
