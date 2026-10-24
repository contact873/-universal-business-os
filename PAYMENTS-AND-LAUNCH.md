# Payments in Pakistan, and completing the website

The question "payment system for any Pakistani bank" has two honest answers, and they have very
different prerequisites. Both are supported by the code now; only one can be switched on today.

---

## The two paths

| Path | What it needs | Works today |
|---|---|---|
| **Bank transfer invoice** | Nothing but an IBAN. Works with every Pakistani bank, no approval, no card data anywhere | **Yes** |
| **Card or wallet** | A merchant account with Safepay, PayFast, or a bank gateway. Company documents, approval, integration keys | No, not until approved |

**Stripe cannot be used.** It does not accept businesses registered in Pakistan. Any plan that
assumes Stripe has to change, and this code was written so only the adapter changes.

For cards, the integration is with **one** payment service provider, not with each bank. The
provider's network reaches every bank's cards. That is the only practical definition of "any
Pakistani bank".

---

## Part 3: the free plan, and the subscriber list

The funnel is free first, not card first. `SIGNUP_MODE=free` is the default, and it is the setting
that should stay on until a merchant account exists.

### How the free plan is limited, and why that way

**Not by time.** A free plan that expires after fourteen days is a trial wearing a costume. It
produces the one thing a business cannot afford: someone who signed up, never got round to using it,
and now associates the brand with a deadline. The free plan never expires, and its subscription row
has no `period_end` at all.

**By growth.** Contacts and seats are standing counts, checked on the server. Reaching the ceiling
refuses new records and nothing else: existing data stays readable, searchable and editable, and
nothing is ever deleted to enforce a limit.

**By allowance** for the things that cost money to run. Assistant minutes and SMS use `usage_events`
and reset on the first of the month, UTC. One busy week cannot burn an account permanently. When an
allowance runs out, features route to a person rather than failing in front of a customer.

Free is 100 contacts, one person, 100 SMS a month, and no assistant minutes. The assistant is what
Professional sells.

### The subscriber registry

Every sign-up is written to `subscribers`, whether or not the workspace survives. This is the
operator's list, and the reason the free plan is worth running: a workspace that never converts is
still a relationship.

- **Consent is stored, not assumed.** `marketing_consent`, `consent_at` and `consent_source` are
  recorded at the moment the box is ticked. An unticked box stores the address and marks it not
  mailable, which is the only honest reading of not answering the question.
- **Unsubscribing is final.** It clears consent, records the moment, and the guard sits at the queue
  in `offerItem`, not at the send, because a queued offer becomes a sent offer. A broadcast cannot
  reach someone who opted out.
- **A later sign-up cannot erase a filled field.** A form that omits the phone number will not blank
  the one already held.
- **Nothing is duplicated.** Matching is on the normalised address, so `Dana@Clinic.test` and
  ` dana@clinic.TEST ` are one person with one history.

### What you do with it

1. Open `https://app.connect.raschident.com/admin/subscribers`
2. Filter by status, plan, or "only those who consented"
3. Download CSV, which quotes commas and doubled quotes so a spreadsheet opens it properly
4. Record an offer of a future item against a subscriber, then its outcome, so the same person is
   not pitched the same thing twice in a month

`subscriberStats` gives total, free, paying, mailable and the conversion rate, plus acceptance per
offered item. That is the number that says whether the free plan is doing its job.

---

## Part 4: bank transfer, which needs no approval

### What to fill in

Five lines, in the environment of the deployed application:

```
fly secrets set BANK_NAME="Meezan Bank" BANK_ACCOUNT_TITLE="Relco Digital" BANK_IBAN="PK00MEZN0000000000000000"
```

Optional but useful: `BANK_ACCOUNT_NUMBER`, `BANK_BRANCH`.

### What the code does with it

- `POST /api/trial` creates the workspace and, with `TRIAL_REQUIRES_CARD=true`, leaves it with no
  access until a payment method exists
- `/app/billing` shows the plan, the status, the trial end and whether a card is on file
- `issueInvoice()` creates an invoice whose amount comes from the plan catalogue, so the invoice
  cannot contradict the website
- `/admin/invoices` lists them; **Mark paid** confirms the money arrived, sets the subscription
  active for 30 days and opens the features

### Why confirmation is manual

There is no automatic way to know an IBAN transfer landed without a bank feed or a statement parser.
Pretending otherwise means granting months on hope. Confirming by hand is honest, and it is one
click.

Marking the same invoice paid twice is refused, so a duplicate confirmation cannot grant two months.

---

## Part 5: cards and wallets, when the merchant account is approved

### Apply to one of these

| Provider | Why | Ask them |
|---|---|---|
| **Safepay** | Local, documents recurring subscriptions and trial handling | Does recurring work for our MCC? Fees per transaction and per refund? Settlement time? |
| **PayFast** | Local, widely used, simpler onboarding for small merchants | Is tokenised recurring supported, or only one-off payments? |
| **Bank gateway** (Meezan, HBL, UBL) | Lower fees at volume, longer onboarding | Do they support card-on-file for subscriptions, or only one-off sales? |

Questions worth asking before signing anything:

1. Does the account support **recurring / card-on-file**, or only one-off payments? This is the one
   that decides whether the seven day trial can charge automatically
2. Is there a **hosted checkout page**, so card data never touches our server?
3. Do you support **3-D Secure** and what does a failed authentication do to a subscription?
4. What are the **fees** per transaction, per refund, and per chargeback?
5. **Settlement**: how many days, and into which account?
6. Do you provide **verified webhooks** with a signature, and idempotent event ids?
7. Is a subscription **pause/cancel** endpoint available, or only cancellation at period end?

### What I need to finish the adapter

Your account type decides the implementation, so tell me which one approved:

- **Safepay:** `SAFEPAY_API_KEY`, `SAFEPAY_SECRET`, `SAFEPAY_WEBHOOK_SECRET`
- **PayFast:** `PAYFAST_MERCHANT_ID`, `PAYFAST_SECURED_KEY`, `PAYFAST_WEBHOOK_SECRET`

With those, the work is: a checkout call that returns their hosted page, a webhook that verifies
their signature and calls the existing `applyEvent`, and a decision on whether renewals come from
their recurring engine or from our invoices.

None of that changes the database, the plans, the entitlements or the pages. That was the point of
building `applyEvent` and `markInvoicePaid` first.

---

## Part 6: completing the website, in order

### Step 1, upload four files

| Local file | Destination name |
|---|---|
| `UPLOAD-NOW/UPLOAD-THIS-3-business-os.html` | `business-os.html` |
| `UPLOAD-NOW/UPLOAD-THIS-1-ai-automation.html` | `ai-automation.html` |
| `assets/css/styles.css` | `assets/css/styles.css` |
| `assets/img/*` (already uploaded) | no action |

Read the size in File Manager afterwards. HTML may read about 249 bytes larger than local, because
Cloudflare rewrites pages in flight. A marker is the reliable check.

### Step 2, deploy the application

```bash
brew install flyctl
fly auth signup
cd ~/Documents/apps/universal-business-os
fly apps create relco-business-os
fly volumes create ubos_data --region sin --size 1
fly secrets set SESSION_SECRET=<64 hex characters>
fly secrets set PLATFORM_ADMIN_EMAILS=contact@raschident.com APP_URL=https://app.connect.raschident.com
fly secrets set PUBLIC_ORIGINS=https://connect.raschident.com
fly deploy
```

Then the bank details from Part 4, and `fly secrets set RESEND_API_KEY=... EMAIL_FROM="..."` so the
welcome email leaves the building.

### Step 3, the domain

```bash
fly certs add app.connect.raschident.com
```

Then in Cloudflare, zone `raschident.com`, add a **CNAME**: name `app`, target
`relco-business-os.fly.dev`, proxy **DNS only (grey)**. Grey matters, or the certificate never
issues.

### Step 4, prove the journey once

1. Open `https://connect.raschident.com/business-os.html` and submit the trial form
2. The page should say the workspace was created and either show **Add a card** or say card payments
   are not switched on
3. Open `https://app.connect.raschident.com/app/billing` and confirm the plan, the status and the
   missing card are shown honestly
4. In `/admin/invoices`, issue nothing yet; that comes from a paid plan
5. Send yourself a bank transfer of one rupee, mark the invoice paid, and confirm the workspace
   opens

### Step 5, know what is still off

- **Card checkout**: waiting on a merchant account. Until then the billing page says so
- **Automatic renewals**: the invoice path is manual by design
- **Email**: without a Resend key, accounts are created and no email is sent, which the API reports
  as `emailed: false`

---

## Part 7: what converts without a person, and what must not

The lifecycle job (`src/lib/lifecycle.mjs`, called from `/api/cron/lifecycle`) handles the mechanical
half. It runs on a schedule, is idempotent by what an action is about rather than when it ran, and
writes an audit entry for everything it does.

### Automated today

| Step | How |
|---|---|
| Enquiry arrives | Stored, scored, and routed by the API; a handover pack when it needs a person |
| Free sign-up | Workspace created, subscriber registered, limits applied |
| Upgrade request | Invoice issued at the catalogue price, with the bank details and a reference |
| Renewal on bank transfer | One invoice per period, however often the job runs |
| Trial that ended without a card | Falls back to the free plan, keeping the workspace and its data |
| Payment not received | Grace period, then the free plan rather than a silent lapse |
| Win-back | Offered once, only to subscribers who consented, a month after downgrading |

### Automated the moment a provider exists

| Step | What changes |
|---|---|
| Card capture | The provider's hosted page; no card data touches this server |
| The charge at trial end | The provider charges and sends `invoice.paid`, which activates the plan |
| Failed payment | The provider retries; `invoice.payment_failed` moves the subscription to `past_due` |
| Renewal on card | The provider charges at period end; the invoice path is skipped |
| Cancellation | The provider ends the period; the workspace drops to free at that date |

Nothing in the database, the plans, the entitlements or the pages changes for any of this. That is what
`applyEvent` was built for: the provider is a source of verified events, and the state machine already
handles them.

### Deliberately human

| Step | Why |
|---|---|
| Confirming a bank transfer | No bank feed exists, so somebody looks at the account. Pretending otherwise grants months on hope |
| Complaints and refunds | Judgement with liability; the agent acknowledges and routes, and does not decide |
| Medical, legal and pricing exceptions | The refusal list, written by the client |
| Chargebacks | Evidence and a deadline; a person submits it |
| Getting a merchant account | Documents, KYC and approval, whoever you choose |

### The adapter contract

When Safepay, PayFast or Stripe arrives, only two functions are new:

1. `createCheckout({ orgId, planId, email })` returns a URL on the provider's own page, with the
   organisation id in the provider's metadata so the webhook can find the workspace.
2. `parseWebhook(rawBody, headers)` verifies the signature and returns the normalised event shape
   `applyEvent` already accepts.

Then set `PAYMENT_PROVIDER_KEY` and the provider's webhook secret, point the provider at
`/api/webhooks/billing`, and the billing page switches from "card payments are not switched on yet" to a
real button without a deploy of anything else.

### Scheduling it

The endpoint needs a secret before it will run at all, so set your own and keep it:

```bash
SECRET=$(openssl rand -hex 32)
echo "$SECRET"                                  # copy this into the cron entry
fly secrets set LIFECYCLE_SECRET="$SECRET"
```

Then, from cPanel's Cron Jobs, every fifteen minutes:

```
*/15 * * * * curl -s -X POST https://relco-business-os.fly.dev/api/cron/lifecycle -H "x-lifecycle-secret: SECRET"
```

Check it once by hand and read the summary it returns. "nothing to do" is the correct answer on a quiet
afternoon, and it is worth knowing what that looks like before you need to tell the difference between
quiet and broken.
