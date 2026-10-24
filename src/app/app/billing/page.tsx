import { requireWorkspace } from "@/lib/session-server";
import { getDb } from "@/lib/db.mjs";
import { PAYMENT_PROVIDER_CONFIGURED } from "@/lib/config.mjs";
import { can } from "@/lib/roles.mjs";
import { startCardTrialAction, requestUpgradeAction } from "@/app/actions";
import { planForDisplay, invoicesFor, outstandingInvoiceFor, bankDetails } from "@/lib/types";

type Row = {
  status: string;
  plan_id: string | null;
  plan_name: string | null;
  trial_end: string | null;
  trial_days: number | null;
  card_on_file_at: string | null;
  payment_method_brand: string | null;
  payment_method_last4: string | null;
};

export default async function Billing({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { error, notice } = await searchParams;
  const session = await requireWorkspace();
  const db = getDb();

  const row = db
    .prepare(
      `select s.status, s.plan_id, s.trial_end, s.trial_days, s.card_on_file_at,
              s.payment_method_brand, s.payment_method_last4, p.name as plan_name
         from subscriptions s
         left join plans p on p.id = s.plan_id
        where s.organization_id = ?
        order by s.created_at desc
        limit 1`,
    )
    .get(session.orgId) as Row | undefined;

  const plans = planForDisplay(db);
  // Names come from every plan, including retired ones: an outstanding invoice may be for a plan that
  // is no longer sold, and it should still say which plan it was.
  const allPlans = planForDisplay(db, { includeRetired: true });
  const invoices = invoicesFor(db, session.orgId);
  const outstanding = outstandingInvoiceFor(db, session.orgId);
  const bank = bankDetails();

  const cardOnFile = Boolean(row?.card_on_file_at);
  const trialEnds = row?.trial_end ? new Date(row.trial_end) : null;
  const daysLeft = trialEnds ? Math.max(0, Math.ceil((trialEnds.getTime() - Date.now()) / 86_400_000)) : null;
  const mayChange = can(session.role, "billing:write");

  const money = (minor: number, currency: string) => `${currency} ${(minor / 100).toFixed(2)}`;
  const planName = (id: string) => allPlans.find((plan) => plan.id === id)?.name ?? id;

  return (
    <section className="wrap">
      {error ? (
        <p className="notice error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="notice ok" role="status">
          {notice}
        </p>
      ) : null}

      <h2>Billing</h2>

      <div className="grid" style={{ alignItems: "start", marginTop: "var(--s5)" }}>
        <div className="card">
          <h3>Your plan</h3>
          <p className="price" style={{ fontSize: "1.4rem", margin: "var(--s2) 0" }}>
            {row?.plan_name ?? "No plan selected"}
          </p>
          <p className="muted small" style={{ margin: 0 }}>
            Status: <strong>{row?.status ?? "none"}</strong>
          </p>
          {row?.trial_end ? (
            <p className="muted small" style={{ margin: 0 }}>
              Trial {cardOnFile ? "ends" : "would end"} {trialEnds?.toLocaleDateString()}
              {daysLeft !== null ? ` (${daysLeft} day${daysLeft === 1 ? "" : "s"} left)` : ""}
            </p>
          ) : null}
          {!row?.trial_end && row?.status === "active" ? (
            <p className="muted small" style={{ margin: 0 }}>
              No expiry: this plan stays until it is changed.
            </p>
          ) : null}
        </div>

        <div className="card">
          <h3>Payment method</h3>
          {cardOnFile ? (
            <p className="muted small">
              {row?.payment_method_brand ?? "card"} ending {row?.payment_method_last4 ?? "----"}. Nothing
              is charged until the trial ends.
            </p>
          ) : (
            <p className="muted small">
              No card on file. Card payments are not switched on yet, so paid plans are settled by bank
              transfer: choose a plan below and an invoice is issued here.
            </p>
          )}

          {mayChange ? (
            PAYMENT_PROVIDER_CONFIGURED ? (
              <form action={startCardTrialAction}>
                <button className="accent" type="submit">
                  {cardOnFile ? "Update the card" : "Add a card"}
                </button>
              </form>
            ) : (
              <p className="small muted" style={{ marginBottom: 0 }}>
                Nothing here can take a card payment until a provider account exists, and this page will
                keep saying so until it does.
              </p>
            )
          ) : (
            <p className="small muted" style={{ marginBottom: 0 }}>
              Only an owner can change billing details.
            </p>
          )}
        </div>
      </div>

      {outstanding ? (
        <>
          <h2 style={{ marginTop: "var(--s7)" }}>Invoice waiting to be paid</h2>
          <div className="card" style={{ marginTop: "var(--s4)" }}>
            <p className="price" style={{ fontSize: "1.3rem", margin: "0 0 var(--s2)" }}>
              {money(outstanding.amount_minor, outstanding.currency)}
            </p>
            <p className="small muted">
              For the {planName(outstanding.plan_id)} plan.{" "}
              {outstanding.due_at
                ? `Due ${new Date(outstanding.due_at).toLocaleDateString()}.`
                : "Due when you are ready."}{" "}
              The plan switches on when the transfer is confirmed, so nothing is charged automatically
              and there is nothing to cancel.
            </p>

            {bank.configured ? (
              <table>
                <tbody>
                  <tr>
                    <th scope="row">Payable to</th>
                    <td>
                      {bank.legalName}
                      {bank.structure ? <span className="muted"> ({bank.structure})</span> : null}
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">Bank</th>
                    <td>{bank.bankName}</td>
                  </tr>
                  <tr>
                    <th scope="row">Account title</th>
                    <td>{bank.accountTitle}</td>
                  </tr>
                  {bank.accountNumber ? (
                    <tr>
                      <th scope="row">Account number</th>
                      <td>
                        <code>{bank.accountNumber}</code>
                      </td>
                    </tr>
                  ) : null}
                  <tr>
                    <th scope="row">IBAN</th>
                    <td>
                      <code style={{ wordBreak: "break-all" }}>{bank.iban}</code>
                    </td>
                  </tr>
                  {bank.branch ? (
                    <tr>
                      <th scope="row">Branch</th>
                      <td>{bank.branch}</td>
                    </tr>
                  ) : null}
                  {bank.ntn ? (
                    <tr>
                      <th scope="row">Tax number</th>
                      <td>
                        <code>{bank.ntn}</code>
                      </td>
                    </tr>
                  ) : null}
                  <tr>
                    <th scope="row">Reference</th>
                    <td>
                      <code>{outstanding.id}</code>
                    </td>
                  </tr>
                </tbody>
              </table>
            ) : (
              <p className="notice error" role="status">
                Bank details are not configured on the platform yet, so this invoice cannot be paid
                from here. Write to contact@raschident.com and the details will be sent directly.
              </p>
            )}

            {bank.configured && bank.structure.includes("sole") ? (
              <p className="small muted">
                The account is in the owner&rsquo;s own name, which is normal for a sole proprietorship: the
                account name is the business name. If your bank queries the difference, this invoice is the
                explanation.
              </p>
            ) : null}

            <p className="small muted" style={{ marginBottom: 0 }}>
              Quote the reference with the transfer. Confirmation is done by hand, usually within one
              working day, because no bank feed tells us the money arrived.
            </p>
          </div>
        </>
      ) : null}

      <h2 style={{ marginTop: "var(--s7)" }}>Plans</h2>
      <p className="small muted">
        Priced per workspace. Paid plans carry a one-time setup, which covers configuring the product
        on your own services, prices and hours, and that is the part that decides whether it works.
      </p>

      <div className="grid" style={{ marginTop: "var(--s4)" }}>
        {plans.map((plan) => {
          const isCurrent = plan.id === row?.plan_id;
          return (
            <div className="card" key={plan.id}>
              <h3>{plan.name}</h3>
              <p className="price" style={{ fontSize: "1.3rem", margin: "var(--s2) 0" }}>
                {plan.monthly === 0 ? "$0" : `$${plan.monthly}`}
                <small className="muted"> /month</small>
              </p>
              <p className="small muted" style={{ margin: 0 }}>
                {plan.setup
                  ? `plus $${plan.setup} setup${plan.liveInDays ? `, live in ${plan.liveInDays} days` : ""}`
                  : "no setup fee"}
              </p>
              <ul className="small muted" style={{ paddingLeft: 16, marginTop: "var(--s3)" }}>
                <li>{plan.limits.contacts} contacts</li>
                <li>
                  {plan.limits.seats} {plan.limits.seats === 1 ? "person" : "people"}
                </li>
                <li>{plan.limits["sms-messages"]} SMS a month</li>
                <li>
                  {plan.limits["assistant-minutes"] === 0
                    ? "no assistant minutes"
                    : `${plan.limits["assistant-minutes"]} assistant minutes a month`}
                </li>
              </ul>

              {isCurrent ? (
                <p className="small muted" style={{ marginBottom: 0 }}>
                  Your current plan.
                </p>
              ) : plan.monthly === 0 ? (
                <p className="small muted" style={{ marginBottom: 0 }}>
                  Moving down is done by hand, so nothing is lost halfway. Write to us.
                </p>
              ) : mayChange ? (
                <form action={requestUpgradeAction}>
                  <input type="hidden" name="planId" value={plan.id} />
                  <button type="submit">Move to {plan.name}</button>
                </form>
              ) : (
                <p className="small muted" style={{ marginBottom: 0 }}>
                  Only an owner can change the plan.
                </p>
              )}
            </div>
          );
        })}
      </div>

      {invoices.length ? (
        <>
          <h2 style={{ marginTop: "var(--s7)" }}>Invoices</h2>
          <table style={{ marginTop: "var(--s4)" }}>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Plan</th>
                <th scope="col">Amount</th>
                <th scope="col">Status</th>
                <th scope="col">Reference</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((invoice) => (
                <tr key={invoice.id}>
                  <td className="muted small">{new Date(invoice.created_at).toLocaleDateString()}</td>
                  <td className="muted small">{planName(invoice.plan_id)}</td>
                  <td>{money(invoice.amount_minor, invoice.currency)}</td>
                  <td>
                    <span className="tag">{invoice.status}</span>
                  </td>
                  <td className="muted small">{invoice.reference ?? invoice.id}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}

      <p className="small muted" style={{ marginTop: "var(--s5)" }}>
        Card details, when they are switched on, are entered on the payment provider&rsquo;s own page and
        never touch this server. What is stored here is a reference and the last four digits, so a
        support conversation can identify the card without holding it.
      </p>
    </section>
  );
}
