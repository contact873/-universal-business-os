import { requirePlatformAdmin } from "@/lib/session-server";
import { getDb } from "@/lib/db.mjs";
import { subscribersFor, subscriberStats, offersFor } from "@/lib/subscribers.mjs";

export default async function AdminSubscribers({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string; mailable?: string }>;
}) {
  const { status, q, mailable } = await searchParams;
  await requirePlatformAdmin();
  const db = getDb();

  const rows = subscribersFor(db, {
    status: status || null,
    q: q || null,
    consentedOnly: mailable === "1",
    limit: 200,
  } as never) as Record<string, any>[];
  const stats = subscriberStats(db);

  const query = new URLSearchParams();
  if (status) query.set("status", status);
  if (q) query.set("q", q);
  if (mailable === "1") query.set("mailable", "1");

  return (
    <section className="wrap">
      <span className="eyebrow">Platform administration</span>
      <h1>Subscribers</h1>
      <p className="lede">
        Everyone who has ever signed up, whether or not they still have a workspace. This is the
        list the free plan exists to build.
      </p>

      <div className="grid" style={{ margin: "var(--s5) 0" }}>
        <div className="card">
          <p className="muted small">Total</p>
          <p className="price">{stats.total}</p>
        </div>
        <div className="card">
          <p className="muted small">On the free plan</p>
          <p className="price">{stats.free}</p>
        </div>
        <div className="card">
          <p className="muted small">Paying</p>
          <p className="price">{stats.paying}</p>
          <p className="muted small">{stats.total ? `${Math.round(stats.conversionRate * 1000) / 10}% of sign-ups` : "no sign-ups yet"}</p>
        </div>
        <div className="card">
          <p className="muted small">May be emailed</p>
          <p className="price">{stats.mailable}</p>
          <p className="muted small">{stats.unsubscribed} opted out</p>
        </div>
      </div>

      <form method="get" style={{ display: "flex", gap: "8px", alignItems: "flex-end", flexWrap: "wrap" }}>
        <label>
          <span className="small muted">Search</span>
          <input name="q" defaultValue={q ?? ""} placeholder="name, company or email" />
        </label>
        <label>
          <span className="small muted">Status</span>
          <select name="status" defaultValue={status ?? ""}>
            <option value="">any</option>
            <option value="lead">lead</option>
            <option value="trial">trial</option>
            <option value="free">free</option>
            <option value="paying">paying</option>
            <option value="cancelled">cancelled</option>
          </select>
        </label>
        <label className="small">
          <input type="checkbox" name="mailable" value="1" defaultChecked={mailable === "1"} /> only those who consented
        </label>
        <button type="submit">Filter</button>
      </form>

      <p className="small" style={{ margin: "var(--s4) 0" }}>
        <a href={`/admin/subscribers/export?${query.toString()}`}>Download as CSV</a>
      </p>

      {rows.length === 0 ? (
        <p className="muted">Nobody yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Email</th>
              <th scope="col">Name</th>
              <th scope="col">Company</th>
              <th scope="col">Status</th>
              <th scope="col">Plan</th>
              <th scope="col">Consent</th>
              <th scope="col">Joined</th>
              <th scope="col">Offered</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row: Record<string, any>) => {
              const offers = offersFor(db, row.id);
              return (
                <tr key={row.id}>
                  <td>{row.email}</td>
                  <td className="muted small">{row.name ?? "-"}</td>
                  <td className="muted small">{row.company ?? "-"}</td>
                  <td>
                    <span className="tag">{row.status}</span>
                  </td>
                  <td className="muted small">{row.plan_id ?? "-"}</td>
                  <td className="muted small">
                    {row.unsubscribed_at ? "opted out" : row.marketing_consent ? "consented" : "no"}
                  </td>
                  <td className="muted small">{new Date(row.created_at).toLocaleDateString()}</td>
                  <td className="muted small">
                    {offers.length === 0
                      ? "-"
                      : `${offers.length}: ${offers.map((offer: Record<string, any>) => `${offer.item_label} (${offer.status})`).join(", ")}`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <p className="small muted" style={{ marginTop: "var(--s5)" }}>
        Consent is recorded when it is given, and unsubscribing is final: the offer guard refuses to
        queue anything for someone who has opted out, so a broadcast cannot reach them by accident.
      </p>
    </section>
  );
}
