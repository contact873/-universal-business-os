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

## Part 1: bank transfer, which needs no approval

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

## Part 2: cards and wallets, when the merchant account is approved

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

## Part 3: completing the website, in order

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
fly volumes create ubos_data --region dxb --size 1
fly secrets set SESSION_SECRET=<64 hex characters>
fly secrets set PLATFORM_ADMIN_EMAILS=contact@raschident.com APP_URL=https://app.connect.raschident.com
fly secrets set PUBLIC_ORIGINS=https://connect.raschident.com
fly deploy
```

Then the bank details from Part 1, and `fly secrets set RESEND_API_KEY=... EMAIL_FROM="..."` so the
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
