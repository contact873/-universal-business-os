// Bookings: services, staff, weekly availability, and appointments.
//
// Two problems dominate a booking system, and both are handled here rather than hoped about.
//
// TIMEZONES. Availability is a weekday plus minutes from midnight, in the staff member's own zone.
// Converting a local wall time to a UTC instant cannot be done with a stored offset, because the
// offset changes twice a year and a clinic in London would shift by an hour in March without
// anybody touching the code. So the conversion goes through Intl, twice, which converges even
// across a daylight saving boundary.
//
// OVERLAP. Availability alone is not enough: a service takes time, so a 90 minute treatment started
// 30 minutes before closing runs past it. Both the start and the end of the appointment must sit
// inside the window, and the appointment must not overlap another one for the same staff member.

import { id as newId, nowIso } from "./identities.mjs";
import { getDb } from "./db.mjs";
import { writeAudit } from "./audit.mjs";
import { assertCan } from "./roles.mjs";

export const APPOINTMENT_STATUSES = ["booked", "confirmed", "cancelled", "completed", "no_show"];
export const SLOT_STEP_MINUTES = 15;

function requireOrg(orgId) {
  if (typeof orgId !== "string" || !orgId.trim()) {
    throw new Error("A bookings call needs an organization id. Refusing to run unscoped.");
  }
  return orgId;
}

/* time ---------------------------------------------------------------------- */

function zoneOffsetMs(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const parts = Object.fromEntries(formatter.formatToParts(date).map((p) => [p.type, p.value]));
  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );

  return asIfUtc - date.getTime();
}

/** A local date, a minute of the day, and a zone, to a real UTC instant. */
export function zonedToUtc(dateIso, minuteOfDay, timeZone) {
  const [year, month, day] = String(dateIso).split("-").map(Number);
  if (!year || !month || !day) throw new Error(`"${dateIso}" is not a YYYY-MM-DD date.`);

  const hours = Math.floor(minuteOfDay / 60);
  const minutes = minuteOfDay % 60;
  const naive = Date.UTC(year, month - 1, day, hours, minutes);

  // Two passes: the first uses the offset of the wrong instant, the second corrects it. This
  // settles for every real zone, including the hour either side of a daylight saving change.
  let instant = naive;
  for (let pass = 0; pass < 2; pass += 1) {
    instant = naive - zoneOffsetMs(new Date(instant), timeZone);
  }

  return new Date(instant).toISOString();
}

/** The reverse: a UTC instant to the local weekday and minute of the day in a zone. */
export function localParts(iso, timeZone) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new Error(`"${iso}" is not a time.`);

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

  const parts = Object.fromEntries(formatter.formatToParts(date).map((p) => [p.type, p.value]));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);

  return {
    weekday,
    minute: Number(parts.hour) * 60 + Number(parts.minute),
    date: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

export function zoneFor(db, orgId, staff) {
  if (staff?.timezone) return staff.timezone;
  const org = db.prepare("select timezone from organizations where id = ?").get(orgId);
  return org?.timezone || "UTC";
}

/* services and staff -------------------------------------------------------- */

export function createService(db, orgId, { name, durationMinutes, priceMinor = null, currency = null, role = null, actorUserId = null }) {
  requireOrg(orgId);
  if (role) assertCan(role, "service:write");

  const clean = String(name ?? "").trim();
  const duration = Number(durationMinutes);
  if (!clean) throw new Error("A service needs a name.");
  if (!Number.isInteger(duration) || duration < 5 || duration > 600) {
    throw new Error("A service duration must be between 5 and 600 minutes.");
  }

  const serviceId = newId("srv");
  db.prepare(
    `insert into services (id, organization_id, name, duration_minutes, price_minor, currency, active, created_at)
     values (?, ?, ?, ?, ?, ?, 1, ?)`,
  ).run(serviceId, orgId, clean, duration, priceMinor, currency, nowIso());

  writeAudit(db, { orgId, actorUserId, action: "service.create", entity: "service", entityId: serviceId, meta: { name: clean, duration } });
  return { serviceId, name: clean, durationMinutes: duration };
}

export function listServices(db, orgId) {
  requireOrg(orgId);
  return db
    .prepare("select * from services where organization_id = ? and active = 1 order by name")
    .all(orgId);
}

export function createStaff(db, orgId, { name, timezone = null, userId = null, weekdays = [1, 2, 3, 4, 5], startMinute = 540, endMinute = 1020, role = null, actorUserId = null }) {
  requireOrg(orgId);
  if (role) assertCan(role, "staff:write");

  const clean = String(name ?? "").trim();
  if (!clean) throw new Error("A staff member needs a name.");

  const staffId = newId("stf");
  const at = nowIso();
  db.prepare(
    `insert into staff (id, organization_id, user_id, name, timezone, active, created_at)
     values (?, ?, ?, ?, ?, 1, ?)`,
  ).run(staffId, orgId, userId, clean, timezone, at);

  for (const weekday of weekdays) {
    db.prepare(
      `insert into availability (id, organization_id, staff_id, weekday, start_minute, end_minute, created_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
    ).run(newId("avl"), orgId, staffId, weekday, startMinute, endMinute, at);
  }

  writeAudit(db, { orgId, actorUserId, action: "staff.create", entity: "staff", entityId: staffId, meta: { name: clean } });
  return { staffId, name: clean };
}

export function listStaff(db, orgId) {
  requireOrg(orgId);
  return db.prepare("select * from staff where organization_id = ? and active = 1 order by name").all(orgId);
}

export function setAvailability(db, orgId, staffId, windows, { role = null, actorUserId = null } = {}) {
  requireOrg(orgId);
  if (role) assertCan(role, "staff:write");

  const staff = db.prepare("select * from staff where id = ? and organization_id = ?").get(staffId, orgId);
  if (!staff) return { ok: false, reason: "unknown_staff" };

  db.prepare("delete from availability where organization_id = ? and staff_id = ?").run(orgId, staffId);

  for (const window of windows) {
    if (window.weekday < 0 || window.weekday > 6) continue;
    if (window.endMinute <= window.startMinute) continue;
    db.prepare(
      `insert into availability (id, organization_id, staff_id, weekday, start_minute, end_minute, created_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
    ).run(newId("avl"), orgId, staffId, window.weekday, window.startMinute, window.endMinute, nowIso());
  }

  return { ok: true, windows: windows.length };
}

export function availabilityFor(db, orgId, staffId, weekday) {
  requireOrg(orgId);
  return db
    .prepare(
      "select start_minute, end_minute from availability where organization_id = ? and staff_id = ? and weekday = ? order by start_minute",
    )
    .all(orgId, staffId, weekday);
}

/* conflicts ----------------------------------------------------------------- */

export function hasConflict(db, orgId, staffId, startsAt, endsAt, { excludeId = null } = {}) {
  requireOrg(orgId);
  const row = db
    .prepare(
      `select id from appointments
        where organization_id = ? and staff_id = ? and status <> 'cancelled'
          and id <> coalesce(?, '')
          and starts_at < ? and ends_at > ?
        limit 1`,
    )
    .get(orgId, staffId, excludeId, endsAt, startsAt);
  return row ? row.id : null;
}

/* booking ------------------------------------------------------------------- */

export function book(db, orgId, { staffId, serviceId, contactId = null, startsAt, notes = null, role = null, actorUserId = null }) {
  requireOrg(orgId);
  if (role) assertCan(role, "booking:write");

  const start = new Date(startsAt);
  if (Number.isNaN(start.getTime())) return { ok: false, reason: "bad_time" };

  const service = db.prepare("select * from services where id = ? and organization_id = ?").get(serviceId, orgId);
  if (!service) return { ok: false, reason: "unknown_service" };

  const staff = db.prepare("select * from staff where id = ? and organization_id = ?").get(staffId, orgId);
  if (!staff) return { ok: false, reason: "unknown_staff" };

  if (contactId) {
    const contact = db.prepare("select id from contacts where id = ? and organization_id = ?").get(contactId, orgId);
    if (!contact) return { ok: false, reason: "unknown_contact" };
  }

  const zone = zoneFor(db, orgId, staff);
  const end = new Date(start.getTime() + service.duration_minutes * 60_000);
  const startsIso = start.toISOString();
  const endsIso = end.toISOString();

  // The start and the end must both be inside a window, so a 90 minute treatment cannot begin 30
  // minutes before closing.
  const startLocal = localParts(startsIso, zone);
  const endLocal = localParts(endsIso, zone);
  const windows = availabilityFor(db, orgId, staffId, startLocal.weekday);

  const fits = windows.some(
    (w) => startLocal.minute >= w.start_minute && endLocal.minute <= w.end_minute,
  );
  if (!fits) return { ok: false, reason: "outside_hours", zone };

  const clash = hasConflict(db, orgId, staffId, startsIso, endsIso);
  if (clash) return { ok: false, reason: "conflict", conflictId: clash };

  const appointmentId = newId("apt");
  const at = nowIso();
  db.prepare(
    `insert into appointments
       (id, organization_id, staff_id, service_id, contact_id, starts_at, ends_at, status, notes, created_by_user_id, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, 'booked', ?, ?, ?, ?)`,
  ).run(appointmentId, orgId, staffId, serviceId, contactId, startsIso, endsIso, notes, actorUserId, at, at);

  writeAudit(db, {
    orgId,
    actorUserId,
    action: "appointment.book",
    entity: "appointment",
    entityId: appointmentId,
    meta: { staffId, serviceId, startsAt: startsIso },
  });

  return { ok: true, appointmentId, startsAt: startsIso, endsAt: endsIso, service: service.name, staff: staff.name };
}

export function reschedule(db, orgId, appointmentId, startsAt, { role = null, actorUserId = null } = {}) {
  requireOrg(orgId);
  if (role) assertCan(role, "booking:write");

  const appointment = db
    .prepare("select * from appointments where id = ? and organization_id = ?")
    .get(appointmentId, orgId);
  if (!appointment) return { ok: false, reason: "unknown_appointment" };
  if (appointment.status === "cancelled") return { ok: false, reason: "already_cancelled" };

  const service = db.prepare("select * from services where id = ?").get(appointment.service_id);
  const staff = db.prepare("select * from staff where id = ?").get(appointment.staff_id);

  const start = new Date(startsAt);
  if (Number.isNaN(start.getTime())) return { ok: false, reason: "bad_time" };

  const zone = zoneFor(db, orgId, staff);
  const end = new Date(start.getTime() + service.duration_minutes * 60_000);
  const startsIso = start.toISOString();
  const endsIso = end.toISOString();

  const startLocal = localParts(startsIso, zone);
  const endLocal = localParts(endsIso, zone);
  const windows = availabilityFor(db, orgId, appointment.staff_id, startLocal.weekday);
  if (!windows.some((w) => startLocal.minute >= w.start_minute && endLocal.minute <= w.end_minute)) {
    return { ok: false, reason: "outside_hours", zone };
  }

  const clash = hasConflict(db, orgId, appointment.staff_id, startsIso, endsIso, { excludeId: appointmentId });
  if (clash) return { ok: false, reason: "conflict", conflictId: clash };

  db.prepare("update appointments set starts_at = ?, ends_at = ?, updated_at = ? where id = ? and organization_id = ?")
    .run(startsIso, endsIso, nowIso(), appointmentId, orgId);

  writeAudit(db, { orgId, actorUserId, action: "appointment.reschedule", entity: "appointment", entityId: appointmentId, meta: { startsAt: startsIso } });
  return { ok: true, appointmentId, startsAt: startsIso, endsAt: endsIso };
}

export function setAppointmentStatus(db, orgId, appointmentId, status, { role = null, actorUserId = null, notes = null } = {}) {
  requireOrg(orgId);
  if (!APPOINTMENT_STATUSES.includes(status)) {
    throw new Error(`Unknown appointment status "${status}".`);
  }
  if (role && status === "cancelled") assertCan(role, "booking:cancel");
  else if (role) assertCan(role, "booking:write");

  const appointment = db
    .prepare("select * from appointments where id = ? and organization_id = ?")
    .get(appointmentId, orgId);
  if (!appointment) return { ok: false, reason: "unknown_appointment" };

  db.prepare("update appointments set status = ?, notes = coalesce(?, notes), updated_at = ? where id = ? and organization_id = ?")
    .run(status, notes, nowIso(), appointmentId, orgId);

  writeAudit(db, {
    orgId,
    actorUserId,
    action: `appointment.${status}`,
    entity: "appointment",
    entityId: appointmentId,
    meta: { from: appointment.status },
  });

  return { ok: true, appointmentId, status };
}

export function listAppointments(db, orgId, { from = null, to = null, staffId = null, limit = 100 } = {}) {
  requireOrg(orgId);
  return db
    .prepare(
      `select a.*, s.name as service_name, s.duration_minutes, st.name as staff_name, c.name as contact_name
         from appointments a
         join services s on s.id = a.service_id
         join staff st on st.id = a.staff_id
         left join contacts c on c.id = a.contact_id
        where a.organization_id = ?
          and (? is null or a.starts_at >= ?)
          and (? is null or a.starts_at <= ?)
          and (? is null or a.staff_id = ?)
        order by a.starts_at asc
        limit ?`,
    )
    .all(orgId, from, from, to, to, staffId, staffId, limit);
}

/** Slots that fit inside the working day and collide with nothing. */
export function freeSlots(db, orgId, staffId, dateIso, durationMinutes, { from = null, stepMinutes = SLOT_STEP_MINUTES } = {}) {
  requireOrg(orgId);

  const staff = db.prepare("select * from staff where id = ? and organization_id = ?").get(staffId, orgId);
  if (!staff) return [];

  const zone = zoneFor(db, orgId, staff);
  const [year, month, day] = dateIso.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const windows = availabilityFor(db, orgId, staffId, weekday);

  const notBefore = from ? new Date(from).getTime() : 0;
  const slots = [];

  for (const window of windows) {
    for (let minute = window.start_minute; minute + durationMinutes <= window.end_minute; minute += stepMinutes) {
      const startsAt = zonedToUtc(dateIso, minute, zone);
      const endsAt = new Date(Date.parse(startsAt) + durationMinutes * 60_000).toISOString();
      if (Date.parse(startsAt) < notBefore) continue;
      if (hasConflict(db, orgId, staffId, startsAt, endsAt)) continue;
      slots.push({ startsAt, endsAt });
    }
  }

  return slots;
}

export function createBookingStore(db = getDb()) {
  return {
    createService: (orgId, input) => createService(db, orgId, input),
    listServices: (orgId) => listServices(db, orgId),
    createStaff: (orgId, input) => createStaff(db, orgId, input),
    listStaff: (orgId) => listStaff(db, orgId),
    setAvailability: (orgId, staffId, windows, options) => setAvailability(db, orgId, staffId, windows, options),
    book: (orgId, input) => book(db, orgId, input),
    reschedule: (orgId, appointmentId, startsAt, options) => reschedule(db, orgId, appointmentId, startsAt, options),
    setStatus: (orgId, appointmentId, status, options) => setAppointmentStatus(db, orgId, appointmentId, status, options),
    listAppointments: (orgId, options) => listAppointments(db, orgId, options),
    freeSlots: (orgId, staffId, dateIso, minutes, options) => freeSlots(db, orgId, staffId, dateIso, minutes, options),
  };
}
