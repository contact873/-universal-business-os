import { requireWorkspace } from "@/lib/session-server";
import { tenantStore } from "@/lib/types";
import { createContactAction } from "@/app/actions";

export default async function Contacts({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; created?: string }>;
}) {
  const { error, created } = await searchParams;
  const session = await requireWorkspace();
  const store = tenantStore();
  const contacts = store.listContacts(session.orgId, { limit: 200 });

  return (
    <section className="wrap">
      {error ? (
        <p className="notice error" role="alert">
          {error}
        </p>
      ) : null}
      {created ? (
        <p className="notice ok" role="status">
          Contact saved.
        </p>
      ) : null}

      <div className="grid" style={{ alignItems: "start" }}>
        <div className="card">
          <h2>Add a contact</h2>
          <form action={createContactAction}>
            <div className="field">
              <label htmlFor="name">Name</label>
              <input id="name" name="name" maxLength={120} />
            </div>
            <div className="field">
              <label htmlFor="email">Email</label>
              <input id="email" name="email" type="email" />
            </div>
            <div className="field">
              <label htmlFor="mobile">Mobile</label>
              <input id="mobile" name="mobile" inputMode="tel" />
            </div>
            <div className="field">
              <label htmlFor="telephone">Telephone</label>
              <input id="telephone" name="telephone" inputMode="tel" />
            </div>
            <div className="field">
              <label htmlFor="tags">Tags, separated by commas</label>
              <input id="tags" name="tags" placeholder="clinic, dubai" />
            </div>
            <div className="field">
              <label htmlFor="notes">Notes</label>
              <textarea id="notes" name="notes" rows={3} maxLength={4000} />
            </div>
            <button className="accent" type="submit">
              Save contact
            </button>
          </form>
          <p className="muted small" style={{ marginTop: "var(--s3)" }}>
            One email or one phone number is enough. An email address is not required, because
            most enquiries arrive with a mobile number only.
          </p>
        </div>

        <div>
          <h2>Contacts ({contacts.length})</h2>
          {contacts.length === 0 ? (
            <p className="muted">Nobody yet.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Reachable by</th>
                  <th scope="col">Source</th>
                  <th scope="col">Enquiries</th>
                </tr>
              </thead>
              <tbody>
                {contacts.map((contact) => {
                  const detail = store.getContact(session.orgId, contact.id);
                  return (
                    <tr key={contact.id}>
                      <td>{contact.name ?? "Unnamed"}</td>
                      <td className="small">
                        {(detail?.identities ?? []).map((identity) => (
                          <div key={identity.id} className="muted">
                            {identity.kind}: {identity.value_normalized}
                          </div>
                        ))}
                      </td>
                      <td className="muted small">{contact.source ?? "unknown"}</td>
                      <td>{contact.submission_count}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </section>
  );
}
