import { requirePlatformAdmin } from "@/lib/session-server";
import { getDb } from "@/lib/db.mjs";

type OrgRow = {
  id: string;
  name: string;
  slug: string;
  industry: string | null;
  created_at: string;
  members: number;
  contacts: number;
  leads: number;
  status: string | null;
  trial_end: string | null;
};

export default async function Admin() {
  await requirePlatformAdmin();
  const db = getDb();

  const orgs = db
    .prepare(
      `select o.id, o.name, o.slug, o.industry, o.created_at,
              (select count(*) from memberships m where m.organization_id = o.id) as members,
              (select count(*) from contacts c where c.organization_id = o.id) as contacts,
              (select count(*) from leads l where l.organization_id = o.id) as leads,
              (select s.status from subscriptions s where s.organization_id = o.id
                order by s.created_at desc limit 1) as status,
              (select s.trial_end from subscriptions s where s.organization_id = o.id
                order by s.created_at desc limit 1) as trial_end
         from organizations o
        order by o.created_at desc`,
    )
    .all() as OrgRow[];

  const totals = {
    orgs: orgs.length,
    contacts: orgs.reduce((sum, o) => sum + o.contacts, 0),
    leads: orgs.reduce((sum, o) => sum + o.leads, 0),
  };

  return (
    <section className="wrap">
      <span className="eyebrow">Platform administration</span>
      <h1>Workspaces ({totals.orgs})</h1>
      <p className="lede">
        Every business on the platform, with what it holds. This view is deliberately not linked
        from a workspace: a business owner never sees this page, and reaching it requires a
        platform administrator account.
      </p>

      <div className="grid" style={{ margin: "var(--s6) 0" }}>
        <div className="card">
          <p className="muted small">Workspaces</p>
          <p className="price">{totals.orgs}</p>
        </div>
        <div className="card">
          <p className="muted small">Contacts across all</p>
          <p className="price">{totals.contacts}</p>
        </div>
        <div className="card">
          <p className="muted small">Leads across all</p>
          <p className="price">{totals.leads}</p>
        </div>
      </div>

      {orgs.length === 0 ? (
        <p className="muted">No workspaces yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Workspace</th>
              <th scope="col">Industry</th>
              <th scope="col">People</th>
              <th scope="col">Contacts</th>
              <th scope="col">Leads</th>
              <th scope="col">Billing</th>
            </tr>
          </thead>
          <tbody>
            {orgs.map((org) => (
              <tr key={org.id}>
                <td>
                  {org.name}
                  <div className="muted small">{org.slug}</div>
                </td>
                <td className="muted small">{org.industry ?? "none"}</td>
                <td>{org.members}</td>
                <td>{org.contacts}</td>
                <td>{org.leads}</td>
                <td className="muted small">
                  {org.status ?? "no subscription"}
                  {org.status === "trialing" && org.trial_end
                    ? ` (ends ${new Date(org.trial_end).toLocaleDateString()})`
                    : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="muted small" style={{ marginTop: "var(--s5)" }}>
        No payment provider is connected, so a trialing workspace is never charged and never
        suspended. The status column reports what is recorded, not what has been collected.
      </p>
    </section>
  );
}
