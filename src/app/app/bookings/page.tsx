import { requireWorkspace } from "@/lib/session-server";
import { getDb } from "@/lib/db.mjs";
import {
  listServices,
  listStaffRows,
  listAppointments,
  freeSlots,
  database,
} from "@/lib/types";
import { can } from "@/lib/roles.mjs";
import {
  createServiceAction,
  createStaffAction,
  bookAppointmentAction,
  cancelAppointmentAction,
} from "@/app/actions";

export default async function Bookings({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; booked?: string; cancelled?: string }>;
}) {
  const { error, booked, cancelled } = await searchParams;
  const session = await requireWorkspace();
  const db = getDb();

  const services = listServices(db, session.orgId);
  const staff = listStaffRows(db, session.orgId);
  const now = new Date().toISOString();
  const appointments = listAppointments(db, session.orgId, { from: now, limit: 50 });

  const mayBook = can(session.role, "booking:write");
  const mayManage = can(session.role, "service:write");

  const org = db
    .prepare("select timezone from organizations where id = ?")
    .get(session.orgId) as { timezone: string | null } | undefined;

  // What the diary actually looks like tomorrow, which is the question a clinic asks first.
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const openTomorrow = staff
    .map((member) => ({
      name: member.name,
      slots: services.length
        ? freeSlots(database(), session.orgId, member.id, tomorrow, services[0].duration_minutes).length
        : 0,
    }))
    .filter((row) => row.slots > 0);

  return (
    <section className="wrap">
      {error ? (
        <p className="notice error" role="alert">
          {error}
        </p>
      ) : null}
      {booked ? (
        <p className="notice ok" role="status">
          Appointment booked.
        </p>
      ) : null}
      {cancelled ? (
        <p className="notice ok" role="status">
          Appointment cancelled. The slot is free again.
        </p>
      ) : null}

      <p className="muted small">
        Times are entered as the clinic&rsquo;s local clock and stored as a real instant. The workspace
        timezone is {org?.timezone ?? "UTC"}; each staff member can have their own.
      </p>

      <div className="grid" style={{ alignItems: "start", marginTop: "var(--s5)" }}>
        <div className="card">
          <h2>Book an appointment</h2>
          {!mayBook ? (
            <p className="muted small">Your role is read only here.</p>
          ) : services.length === 0 || staff.length === 0 ? (
            <p className="muted small">Add a service and a staff member first.</p>
          ) : (
            <form action={bookAppointmentAction}>
              <div className="field">
                <label htmlFor="serviceId">Service</label>
                <select id="serviceId" name="serviceId" required>
                  {services.map((service) => (
                    <option key={service.id} value={service.id}>
                      {service.name} ({service.duration_minutes} min)
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="staffId">With</label>
                <select id="staffId" name="staffId" required>
                  {staff.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.name}
                      {member.timezone ? ` (${member.timezone})` : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="startsAt">Local date and time</label>
                <input id="startsAt" name="startsAt" type="datetime-local" required />
              </div>
              <div className="field">
                <label htmlFor="notes">Note</label>
                <input id="notes" name="notes" maxLength={400} />
              </div>
              <button className="accent" type="submit">
                Book it
              </button>
              <p className="muted small" style={{ marginTop: "var(--s3)" }}>
                Refused if it collides with another appointment, or if it runs past closing time.
              </p>
            </form>
          )}
        </div>

        <div className="card">
          <h2>Services</h2>
          {services.length === 0 ? (
            <p className="muted small">None yet.</p>
          ) : (
            <ul className="small">
              {services.map((service) => (
                <li key={service.id}>
                  {service.name}, {service.duration_minutes} minutes
                  {service.price_minor !== null ? `, ${(service.price_minor / 100).toFixed(2)} ${service.currency ?? ""}` : ""}
                </li>
              ))}
            </ul>
          )}

          {mayManage ? (
            <form action={createServiceAction} style={{ marginTop: "var(--s4)" }}>
              <div className="field">
                <label htmlFor="name">New service</label>
                <input id="name" name="name" placeholder="Service name" required maxLength={120} />
              </div>
              <div className="form-row">
                <div className="field">
                  <label htmlFor="durationMinutes">Minutes</label>
                  <input id="durationMinutes" name="durationMinutes" type="number" min={5} max={600} defaultValue={30} required />
                </div>
                <div className="field">
                  <label htmlFor="priceMinor">Price</label>
                  <input id="priceMinor" name="priceMinor" type="number" min={0} step="0.01" />
                </div>
                <div className="field">
                  <label htmlFor="currency">Currency</label>
                  <input id="currency" name="currency" maxLength={3} placeholder="AED" />
                </div>
              </div>
              <button type="submit">Add service</button>
            </form>
          ) : null}
        </div>

        <div className="card">
          <h2>Staff</h2>
          {staff.length === 0 ? (
            <p className="muted small">None yet.</p>
          ) : (
            <ul className="small">
              {staff.map((member) => (
                <li key={member.id}>
                  {member.name} {member.timezone ? <span className="muted">({member.timezone})</span> : null}
                </li>
              ))}
            </ul>
          )}

          {mayManage ? (
            <form action={createStaffAction} style={{ marginTop: "var(--s4)" }}>
              <div className="field">
                <label htmlFor="staffName">New staff member</label>
                <input id="staffName" name="name" placeholder="Staff name" required maxLength={80} />
              </div>
              <div className="field">
                <label htmlFor="timezone">Timezone</label>
                <input id="timezone" name="timezone" placeholder="Asia/Dubai" maxLength={60} />
              </div>
              <button type="submit">Add staff</button>
              <p className="muted small" style={{ marginTop: "var(--s3)" }}>
                New staff start with Monday to Friday, 09:00 to 17:00 in their own timezone.
              </p>
            </form>
          ) : null}
        </div>
      </div>

      {openTomorrow.length ? (
        <p className="small muted" style={{ marginTop: "var(--s5)" }}>
          Open tomorrow: {openTomorrow.map((row) => `${row.name} (${row.slots} slots)`).join(", ")}.
        </p>
      ) : null}

      <h2 style={{ marginTop: "var(--s7)" }}>Upcoming ({appointments.length})</h2>
      {appointments.length === 0 ? (
        <p className="muted">The diary is empty.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Service</th>
              <th scope="col">With</th>
              <th scope="col">Who</th>
              <th scope="col">Status</th>
              <th scope="col"></th>
            </tr>
          </thead>
          <tbody>
            {appointments.map((appointment) => (
              <tr key={appointment.id}>
                <td className="small">{new Date(appointment.starts_at).toLocaleString()}</td>
                <td>{appointment.service_name}</td>
                <td>{appointment.staff_name}</td>
                <td className="muted small">{appointment.contact_name ?? "not linked"}</td>
                <td>
                  <span className="tag">{appointment.status}</span>
                </td>
                <td>
                  {mayBook && appointment.status !== "cancelled" ? (
                    <form action={cancelAppointmentAction}>
                      <input type="hidden" name="appointmentId" value={appointment.id} />
                      <button className="btn-ghost" type="submit">
                        Cancel
                      </button>
                    </form>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
