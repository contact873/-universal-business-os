import { requireWorkspace } from "@/lib/session-server";
import { tenantStore } from "@/lib/types";
import { LEAD_STAGES } from "@/lib/tenant.mjs";
import { can } from "@/lib/roles.mjs";
import { moveStageAction, addNoteAction } from "@/app/actions";

export default async function Leads({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; noted?: string }>;
}) {
  const { error, noted } = await searchParams;
  const session = await requireWorkspace();
  const store = tenantStore();
  const leads = store.listLeads(session.orgId, { limit: 100 });

  const mayWrite = can(session.role, "lead:write");

  return (
    <section className="wrap">
      {error ? (
        <p className="notice error" role="alert">
          {error}
        </p>
      ) : null}
      {noted ? (
        <p className="notice ok" role="status">
          Note added.
        </p>
      ) : null}

      <h2>Leads ({leads.length})</h2>

      {!mayWrite ? (
        <p className="notice">
          Your role is {session.role}, so this view is read only. Stage changes and notes need
          staff access or above.
        </p>
      ) : null}

      {leads.length === 0 ? (
        <p className="muted">No leads yet.</p>
      ) : (
        leads.map((lead) => {
          const detail = store.getLead(session.orgId, lead.id);
          const contact = lead.contact_id
            ? store.getContact(session.orgId, lead.contact_id)
            : null;

          return (
            <div className="card" key={lead.id} style={{ marginBottom: "var(--s4)" }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: "var(--s4)",
                  flexWrap: "wrap",
                }}
              >
                <div>
                  <h3 style={{ marginBottom: "var(--s1)" }}>
                    {contact?.name ?? "Unnamed"}{" "}
                    <span className="tag">{lead.stage}</span>
                  </h3>
                  <p className="muted small" style={{ margin: 0 }}>
                    {contact?.identities.map((i) => i.value_normalized).join(" · ") ||
                      "No contact details"}
                  </p>
                  <p className="muted small" style={{ margin: 0 }}>
                    {lead.source ?? "unknown source"} ·{" "}
                    {new Date(lead.created_at).toLocaleString()}
                  </p>
                </div>

                {mayWrite ? (
                  <form action={moveStageAction} style={{ display: "flex", gap: "var(--s2)", alignItems: "flex-end" }}>
                    <input type="hidden" name="leadId" value={lead.id} />
                    <div>
                      <label htmlFor={`stage-${lead.id}`}>Move to</label>
                      <select id={`stage-${lead.id}`} name="stage" defaultValue={lead.stage}>
                        {LEAD_STAGES.map((stage) => (
                          <option key={stage} value={stage}>
                            {stage}
                          </option>
                        ))}
                      </select>
                    </div>
                    <button type="submit">Save</button>
                  </form>
                ) : null}
              </div>

              {lead.message ? (
                <p style={{ marginTop: "var(--s3)" }}>
                  <strong className="small muted">They wrote:</strong> {lead.message}
                </p>
              ) : null}

              <details style={{ marginTop: "var(--s3)" }}>
                <summary className="small muted">
                  History ({detail?.activities.length ?? 0})
                </summary>

                <ul className="small" style={{ marginTop: "var(--s2)" }}>
                  {(detail?.activities ?? []).map((activity) => (
                    <li key={activity.id}>
                      {activity.kind}: {activity.body} ·{" "}
                      <span className="muted">{new Date(activity.created_at).toLocaleString()}</span>
                    </li>
                  ))}
                  {(detail?.activities ?? []).length === 0 ? <li className="muted">Nothing yet.</li> : null}
                </ul>

                {mayWrite ? (
                  <form action={addNoteAction} style={{ marginTop: "var(--s3)" }}>
                    <input type="hidden" name="leadId" value={lead.id} />
                    <div className="field">
                      <label htmlFor={`note-${lead.id}`}>Add a note</label>
                      <textarea id={`note-${lead.id}`} name="body" rows={2} maxLength={4000} />
                    </div>
                    <button type="submit">Add note</button>
                  </form>
                ) : null}
              </details>
            </div>
          );
        })
      )}
    </section>
  );
}
