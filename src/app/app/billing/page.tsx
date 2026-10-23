import { requireWorkspace } from "@/lib/session-server";
import { getDb } from "@/lib/db.mjs";
import { PAYMENT_PROVIDER_CONFIGURED } from "@/lib/config.mjs";
import { can } from "@/lib/roles.mjs";
import { startCardTrialAction } from "@/app/actions";

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

  const cardOnFile = Boolean(row?.card_on_file_at);
  const trialEnds = row?.trial_end ? new Date(row.trial_end) : null;
  const daysLeft = trialEnds ? Math.max(0, Math.ceil((trialEnds.getTime() - Date.now()) / 86_400_000)) : null;
  const mayChange = can(session.role, "billing:write");

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
        </div>

        <div className="card">
          <h3>Payment method</h3>
          {cardOnFile ? (
            <p className="muted small">
              {row?.payment_method_brand ?? "card"} ending {row?.payment_method_last4 ?? "----"}.
              Nothing is charged until the trial ends.
            </p>
          ) : (
            <p className="muted small">
              No card on file. The workspace exists, but the features that need a subscription stay
              closed until one is added.
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
                Card payments are not switched on yet. Nothing here can take a payment until a
                provider account exists, and this page will keep saying so until it does.
              </p>
            )
          ) : (
            <p className="small muted" style={{ marginBottom: 0 }}>
              Only an owner can change billing details.
            </p>
          )}
        </div>
      </div>

      <p className="small muted" style={{ marginTop: "var(--s5)" }}>
        Card details are entered on the payment provider&rsquo;s own page and never touch this
        server. What is stored here is a reference and the last four digits, so a support
        conversation can identify the card without holding it.
      </p>
    </section>
  );
}
