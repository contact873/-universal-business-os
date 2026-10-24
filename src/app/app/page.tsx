import Link from "next/link";
import { requireWorkspace } from "@/lib/session-server";
import { tenantStore, withinLimit } from "@/lib/types";
import { getDb } from "@/lib/db.mjs";

export default async function Dashboard() {
  const session = await requireWorkspace();
  const stats = tenantStore().stats(session.orgId);
  const db = getDb();

  // Usage is shown before a limit is hit, not after. A customer who discovers the ceiling by being
  // refused has already had a bad minute; one who can see it coming decides for themselves.
  const planName =
    (db
      .prepare(
        "select p.name from subscriptions s left join plans p on p.id = s.plan_id where s.organization_id = ? order by s.created_at desc limit 1",
      )
      .get(session.orgId) as { name: string | null } | undefined)?.name ?? "Free";

  const usage = [
    { key: "contacts", label: "Contacts", note: "in this workspace" },
    { key: "seats", label: "People", note: "accounts that can sign in" },
    { key: "sms-messages", label: "SMS", note: "monthly allowance" },
    { key: "assistant-minutes", label: "Assistant minutes", note: "monthly allowance" },
  ].map((feature) => ({ ...feature, ...withinLimit(db, session.orgId, feature.key) }));

  const stageTotal = stats.byStage.reduce((sum, s) => sum + s.n, 0) || 1;

  return (
    <section className="wrap">
      <div className="grid" style={{ marginBottom: "var(--s6)" }}>
        <div className="card">
          <p className="muted small">Contacts</p>
          <p className="price">{stats.contacts}</p>
        </div>
        <div className="card">
          <p className="muted small">Leads</p>
          <p className="price">{stats.leads}</p>
        </div>
        <div className="card">
          <p className="muted small">New this week</p>
          <p className="price">{stats.newThisWeek}</p>
        </div>
      </div>


      <h2 style={{ marginTop: "var(--s7)" }}>Usage on the {planName} plan</h2>
      <p className="small muted">
        Shown before you reach a limit rather than after. Monthly allowances reset on the first of the
        month; contacts and people are counts of what you have, and they do not reset.
      </p>
      <div className="grid">
        {usage.map((row) => {
          const limit = row.limit ?? 0;
          const current = row.current ?? 0;
          const percent = limit > 0 ? Math.min(100, Math.round((current / limit) * 100)) : 0;

          return (
            <div className="card" key={row.key}>
              <p className="muted small" style={{ margin: 0 }}>{row.label}</p>
              <p style={{ fontSize: "1.25rem", fontWeight: 600, margin: "var(--s2) 0" }}>
                {limit === 0 ? "Not included" : `${current} of ${limit}`}
              </p>
              {limit > 0 ? (
                <div style={{ height: 6, background: "#e9e5dc", borderRadius: 99, overflow: "hidden" }}>
                  <div style={{ width: `${percent}%`, height: "100%", background: percent >= 100 ? "#b42318" : "#1f4d3a" }} />
                </div>
              ) : null}
              <p className="small muted" style={{ margin: "var(--s2) 0 0" }}>
                {row.note}
                {row.resets ? ", resets monthly" : ""}
              </p>
              {limit > 0 && row.allowed === false ? (
                <p className="small" style={{ color: "#b42318", margin: "var(--s2) 0 0" }}>
                  Limit reached. <Link href="/app/billing">See the plans</Link>.
                </p>
              ) : null}
            </div>
          );
        })}
      </div>

      <h2>Pipeline</h2>
      {stats.byStage.length === 0 ? (
        <p className="muted">
          No leads yet. <Link href="/app/contacts">Add a contact</Link> to begin.
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Stage</th>
              <th scope="col">Leads</th>
              <th scope="col">Share</th>
            </tr>
          </thead>
          <tbody>
            {stats.byStage.map((row) => (
              <tr key={row.stage}>
                <td>
                  <span className="tag">{row.stage}</span>
                </td>
                <td>{row.n}</td>
                <td>{Math.round((row.n / stageTotal) * 100)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 style={{ marginTop: "var(--s7)" }}>Latest enquiries</h2>
      {stats.recent.length === 0 ? (
        <p className="muted">Nothing has arrived yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Who</th>
              <th scope="col">Stage</th>
              <th scope="col">Source</th>
              <th scope="col">When</th>
            </tr>
          </thead>
          <tbody>
            {stats.recent.map((row) => (
              <tr key={row.id}>
                <td>{row.contact_name ?? "Unnamed"}</td>
                <td>
                  <span className="tag">{row.stage}</span>
                </td>
                <td className="muted small">{row.source ?? "unknown"}</td>
                <td className="muted small">{new Date(row.created_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
