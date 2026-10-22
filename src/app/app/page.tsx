import Link from "next/link";
import { requireWorkspace } from "@/lib/session-server";
import { tenantStore } from "@/lib/types";

export default async function Dashboard() {
  const session = await requireWorkspace();
  const stats = tenantStore().stats(session.orgId);

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
