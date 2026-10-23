import { requirePlatformAdmin } from "@/lib/session-server";
import { getDb } from "@/lib/db.mjs";
import { markInvoicePaidAction } from "@/app/actions";

type Row = {
  id: string;
  org_name: string;
  plan_name: string | null;
  amount_minor: number;
  currency: string;
  status: string;
  reference: string | null;
  due_at: string | null;
  paid_at: string | null;
  created_at: string;
};

export default async function AdminInvoices({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; paid?: string }>;
}) {
  const { error, paid } = await searchParams;
  await requirePlatformAdmin();
  const db = getDb();

  const invoices = db
    .prepare(
      `select i.*, o.name as org_name, p.name as plan_name
         from invoices i
         join organizations o on o.id = i.organization_id
         left join plans p on p.id = i.plan_id
        order by i.created_at desc
        limit 100`,
    )
    .all() as Row[];

  const issued = invoices.filter((invoice) => invoice.status === "issued");
  const collected = invoices
    .filter((invoice) => invoice.status === "paid")
    .reduce((total, invoice) => total + invoice.amount_minor, 0);

  return (
    <section className="wrap">
      {error ? <p className="notice error" role="alert">{error}</p> : null}
      {paid ? <p className="notice ok" role="status">Invoice marked paid. The subscription is active.</p> : null}

      <span className="eyebrow">Platform administration</span>
      <h1>Invoices</h1>
      <p className="lede">
        Bank transfers are confirmed here, by hand, once the money is in the account. That is
        deliberate: nothing marks an invoice paid automatically, so a support agent cannot grant a
        month by guessing.
      </p>

      <div className="grid" style={{ margin: "var(--s5) 0" }}>
        <div className="card">
          <p className="muted small">Awaiting payment</p>
          <p className="price">{issued.length}</p>
        </div>
        <div className="card">
          <p className="muted small">Collected, all time</p>
          <p className="price">{(collected / 100).toFixed(2)}</p>
        </div>
      </div>

      {invoices.length === 0 ? (
        <p className="muted">No invoices yet. One is issued from the billing page of a workspace.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Workspace</th>
              <th scope="col">Plan</th>
              <th scope="col">Amount</th>
              <th scope="col">Status</th>
              <th scope="col">Due</th>
              <th scope="col">Reference</th>
              <th scope="col"></th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((invoice) => (
              <tr key={invoice.id}>
                <td>{invoice.org_name}</td>
                <td className="muted small">{invoice.plan_name ?? invoice.id}</td>
                <td>
                  {invoice.currency} {(invoice.amount_minor / 100).toFixed(2)}
                </td>
                <td>
                  <span className="tag">{invoice.status}</span>
                </td>
                <td className="muted small">
                  {invoice.due_at ? new Date(invoice.due_at).toLocaleDateString() : "-"}
                </td>
                <td className="muted small">{invoice.reference ?? "-"}</td>
                <td>
                  {invoice.status === "issued" ? (
                    <form action={markInvoicePaidAction} style={{ display: "flex", gap: "8px" }}>
                      <input type="hidden" name="invoiceId" value={invoice.id} />
                      <input
                        name="reference"
                        placeholder="bank ref"
                        aria-label={`Bank reference for ${invoice.org_name}`}
                        style={{ width: "120px" }}
                      />
                      <button type="submit">Mark paid</button>
                    </form>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="small muted" style={{ marginTop: "var(--s5)" }}>
        Marking the same invoice twice is refused, so a duplicate confirmation cannot extend a
        subscription by a second month.
      </p>
    </section>
  );
}
