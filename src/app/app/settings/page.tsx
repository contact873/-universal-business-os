import { requireWorkspace } from "@/lib/session-server";
import { getDb } from "@/lib/db.mjs";
import { auditTrail, listInvitations, type AuditRow } from "@/lib/types";
import { can } from "@/lib/roles.mjs";
import {
  changePasswordAction,
  inviteMemberAction,
  revokeInvitationAction,
  updateWorkspaceAction,
} from "@/app/actions";

type Member = { email: string; name: string | null; role: string };

// Industry choices, with whatever is already set added in front so opening the page cannot silently
// change a value somebody chose.
const INDUSTRIES = ["med-spa", "salon", "real-estate", "consulting", "home-services", "retail", "others"];

const TIMEZONE_CHOICES = [
  "Asia/Karachi",
  "Asia/Dubai",
  "Asia/Riyadh",
  "Asia/Qatar",
  "Asia/Kolkata",
  "Europe/London",
  "America/New_York",
  "America/Los_Angeles",
  "UTC",
];

export default async function Settings({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; invited?: string; link?: string; saved?: string; revoked?: string }>;
}) {
  const { error, invited, link, saved, revoked } = await searchParams;
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

  const industryOptions = [
    ...new Set([...(org?.industry ? [org.industry] : []), ...INDUSTRIES]),
  ];

  return (
    <section className="wrap">
      {error ? (
        <p className="notice error" role="alert">
          {error}
        </p>
      ) : null}
      {saved === "password" ? (
        <p className="notice ok" role="status">
          Password changed. Every other device has been signed out, as it should be: if somebody else had
          your password, they no longer do.
        </p>
      ) : saved ? (
        <p className="notice ok" role="status">
          Workspace saved.
        </p>
      ) : null}
      {revoked ? (
        <p className="notice ok" role="status">
          Invitation for {revoked} cancelled, and the seat is free again.
        </p>
      ) : null}
      {invited && link ? (
        <div className="notice ok" role="status">
          <p style={{ marginBottom: "var(--s3)" }}>
            Invitation recorded for {invited}. No email was sent, so send this link yourself. It works
            once, and it is shown only on this page: the database stores a hash of it, never the link.
          </p>
          <p className="small" style={{ wordBreak: "break-all", marginBottom: "var(--s3)" }}>
            <a href={link}>{link}</a>
          </p>
          <p className="small muted">
            Whoever opens it must be able to receive mail at {invited}, because the invitation is tied
            to that address.
          </p>
        </div>
      ) : null}
      {invited && !link ? (
        <p className="notice ok" role="status">
          Invitation recorded for {invited}, and the email has gone.
        </p>
      ) : null}

      <div className="grid" style={{ alignItems: "start" }}>
        <div className="card">
          <h2>Workspace</h2>
          <p className="muted small">
            {org?.name} · {org?.industry ?? "no industry set"} · {org?.timezone ?? "UTC"}
          </p>
          {can(session.role, "org:update") ? (
            <form action={updateWorkspaceAction} style={{ marginTop: "var(--s4)" }}>
              <div className="field">
                <label htmlFor="w-name">Workspace name</label>
                <input id="w-name" name="name" defaultValue={org?.name ?? ""} maxLength={80} />
              </div>
              <div className="form-row">
                <div className="field">
                  <label htmlFor="w-industry">Industry</label>
                  <select id="w-industry" name="industry" defaultValue={org?.industry ?? "other"}>
                    {industryOptions.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field" data-industry-other>
                  <label htmlFor="w-industryOther">If you chose Others, say what the business does</label>
                  <input
                    id="w-industryOther"
                    name="industryOther"
                    maxLength={60}
                    placeholder="Please specify"
                  />
                </div>
                <div className="field">
                  <label htmlFor="w-timezone">Timezone</label>
                  <select id="w-timezone" name="timezone" defaultValue={org?.timezone ?? "UTC"}>
                    {TIMEZONE_CHOICES.map((zone) => (
                      <option key={zone} value={zone}>
                        {zone}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <p className="small muted">
                Appointments are stored in UTC and displayed in this timezone, so a wrong value shows
                every booking at the wrong hour.
              </p>
              <button type="submit">Save workspace</button>
              <script
                dangerouslySetInnerHTML={{
                  __html:
                    "(function(){var s=document.getElementById('w-industry');var w=document.querySelector('[data-industry-other]');if(!s||!w)return;var u=function(){w.style.display=s.value==='others'?'':'none'};s.addEventListener('change',u);u();})();",
                }}
              />
            </form>
          ) : null}

          <h3 style={{ marginTop: "var(--s5)" }}>Your password</h3>
          <form action={changePasswordAction}>
            <div className="field">
              <label htmlFor="p-current">Current password</label>
              <input id="p-current" name="currentPassword" type="password" autoComplete="current-password" required />
            </div>
            <div className="form-row">
              <div className="field">
                <label htmlFor="p-new">New password</label>
                <input id="p-new" name="newPassword" type="password" autoComplete="new-password" minLength={10} required />
              </div>
              <div className="field">
                <label htmlFor="p-again">New password again</label>
                <input id="p-again" name="confirmPassword" type="password" autoComplete="new-password" minLength={10} required />
              </div>
            </div>
            <p className="small muted">
              At least ten characters. Changing it signs out every other device.
            </p>
            <button type="submit">Change password</button>
          </form>

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
                      {!invitation.accepted_at ? (
                        <form action={revokeInvitationAction} style={{ display: "inline", marginLeft: "var(--s3)" }}>
                          <input type="hidden" name="invitationId" value={invitation.id} />
                          <button type="submit">Cancel</button>
                        </form>
                      ) : null}
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
