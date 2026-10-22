import { requireWorkspace } from "@/lib/session-server";
import { getDb } from "@/lib/db.mjs";
import { auditTrail, listInvitations, type AuditRow } from "@/lib/types";
import { can } from "@/lib/roles.mjs";
import { inviteMemberAction } from "@/app/actions";

type Member = { email: string; name: string | null; role: string };

export default async function Settings({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; invited?: string }>;
}) {
  const { error, invited } = await searchParams;
  const session = await requireWorkspace();
  const db = getDb();

  const org = db
    .prepare("select name, slug, industry, timezone, intake_key from organizations where id = ?")
    .get(session.orgId) as
    | { name: string; slug: string; industry: string | null; timezone: string | null; intake_key: string | null }
    | undefined;

  const members = db
    .prepare(
      `select u.email, u.name, m.role
         from memberships m join users u on u.id = m.user_id
        where m.organization_id = ?
        order by m.created_at`,
    )
    .all(session.orgId) as Member[];

  const invitations = can(session.role, "member:invite") ? listInvitations(db, session.orgId) : [];

  const audit: AuditRow[] = can(session.role, "audit:read")
    ? auditTrail(db, session.orgId, { limit: 25 })
    : [];

  return (
    <section className="wrap">
      {error ? (
        <p className="notice error" role="alert">
          {error}
        </p>
      ) : null}
      {invited ? (
        <p className="notice ok" role="status">
          Invitation recorded for {invited}. Sending it by email is not built yet, so the person
          has not been contacted.
        </p>
      ) : null}

      <div className="grid" style={{ alignItems: "start" }}>
        <div className="card">
          <h2>Workspace</h2>
          <p className="muted small">
            {org?.name} · {org?.industry ?? "no industry set"} · {org?.timezone ?? "UTC"}
          </p>
          <h3 style={{ marginTop: "var(--s5)" }}>Intake key</h3>
          <p className="muted small">
            Give this to a website you control so that its enquiry form can post into this
            workspace. The key identifies the workspace and grants nothing else: it cannot read
            any customer data.
          </p>
          <p>
            <code
              style={{
                display: "block",
                padding: "var(--s3)",
                background: "var(--bone)",
                borderRadius: 8,
                wordBreak: "break-all",
              }}
            >
              {org?.intake_key ?? "none"}
            </code>
          </p>
          <p className="muted small" style={{ marginBottom: 0 }}>
            Post to <code>/api/enquiries</code> with{" "}
            <code>{'{"intakeKey":"...","name":"...","email":"...","message":"..."}'}</code>
          </p>
        </div>

        <div>
          <h2>People ({members.length})</h2>
          <table>
            <thead>
              <tr>
                <th scope="col">Email</th>
                <th scope="col">Role</th>
              </tr>
            </thead>
            <tbody>
              {members.map((member) => (
                <tr key={member.email}>
                  <td>{member.email}</td>
                  <td>
                    <span className="tag">{member.role}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {can(session.role, "member:invite") ? (
            <div className="card" style={{ marginTop: "var(--s5)" }}>
              <h3>Invite somebody</h3>
              <form action={inviteMemberAction}>
                <div className="field">
                  <label htmlFor="email">Their email</label>
                  <input id="email" name="email" type="email" required />
                </div>
                <div className="field">
                  <label htmlFor="role">Role</label>
                  <select id="role" name="role" defaultValue="staff">
                    <option value="viewer">Viewer, can read only</option>
                    <option value="staff">Staff, can work leads</option>
                    <option value="manager">Manager, can assign and delete</option>
                    <option value="admin">Admin, can invite and see the audit trail</option>
                    <option value="owner">Owner, can delete the workspace</option>
                  </select>
                </div>
                <button type="submit">Record invitation</button>
              </form>

              {invitations.length ? (
                <ul className="small muted" style={{ marginTop: "var(--s4)" }}>
                  {invitations.map((invitation) => (
                    <li key={invitation.id}>
                      {invitation.email} as {invitation.role}{" "}
                      {invitation.accepted_at
                        ? "(accepted)"
                        : invitation.sent_at
                          ? "(emailed)"
                          : `(not emailed${invitation.send_error ? `: ${invitation.send_error}` : ""})`}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : (
            <p className="muted small" style={{ marginTop: "var(--s4)" }}>
              Only an owner or an admin can invite people.
            </p>
          )}
        </div>
      </div>

      <h2 style={{ marginTop: "var(--s7)" }}>Audit trail</h2>
      {can(session.role, "audit:read") ? (
        audit.length ? (
          <table>
            <thead>
              <tr>
                <th scope="col">Action</th>
                <th scope="col">Who</th>
                <th scope="col">When</th>
              </tr>
            </thead>
            <tbody>
              {audit.map((row) => (
                <tr key={row.id}>
                  <td>
                    {row.action} {row.entity ? <span className="muted small">({row.entity})</span> : null}
                  </td>
                  <td className="muted small">{row.actor_email ?? "system"}</td>
                  <td className="muted small">{new Date(row.created_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">Nothing recorded yet.</p>
        )
      ) : (
        <p className="muted small">
          The audit trail is visible to owners and admins.
        </p>
      )}
    </section>
  );
}
