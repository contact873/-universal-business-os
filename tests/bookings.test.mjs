import "./setup.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./fixtures.mjs";
import { closeDb } from "../src/lib/db.mjs";
import { listAudit } from "../src/lib/audit.mjs";
import {
  zonedToUtc,
  localParts,
  createService,
  listServices,
  createStaff,
  listStaff,
  setAvailability,
  availabilityFor,
  book,
  reschedule,
  setAppointmentStatus,
  listAppointments,
  freeSlots,
  hasConflict,
} from "../src/lib/bookings.mjs";

const DUBAI = "Asia/Dubai";     // UTC+4 all year
const LONDON = "Europe/London"; // UTC+0 in winter, UTC+1 in summer

/** The first date on or after a base date that falls on a given weekday. */
function dateFor(weekday, fromIso = "2026-03-01") {
  const date = new Date(`${fromIso}T00:00:00Z`);
  while (date.getUTCDay() !== weekday) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

const MONDAY = dateFor(1);
const SATURDAY = dateFor(6);
const MONDAY_IN_SUMMER = dateFor(1, "2026-07-01");

test("a local wall time becomes the right UTC instant in both zones", () => {
  // Dubai has no daylight saving, so this is arithmetic.
  assert.equal(zonedToUtc(MONDAY, 10 * 60, DUBAI), `${MONDAY}T06:00:00.000Z`);
  // London in July is BST, one hour ahead of UTC. A stored offset would have made this 10:00Z and
  // quietly moved every summer appointment by an hour.
  assert.equal(zonedToUtc(MONDAY_IN_SUMMER, 10 * 60, LONDON), `${MONDAY_IN_SUMMER}T09:00:00.000Z`);
});

test("the conversion round trips, which is what keeps a slot on the hour", () => {
  const iso = zonedToUtc(MONDAY, 14 * 60 + 30, DUBAI);
  const local = localParts(iso, DUBAI);
  assert.equal(local.minute, 14 * 60 + 30);
  assert.equal(local.date, MONDAY);
  assert.equal(local.weekday, 1, "the first Monday in March 2026 should be a Monday");
});

test("a service duration is validated rather than trusted", () => {
  const { db, alpha } = fixture({ withLeads: false });
  assert.throws(() => createService(db, alpha, { name: "Consult", durationMinutes: 0 }), /between 5 and 600/);
  assert.throws(() => createService(db, alpha, { name: "Consult", durationMinutes: 1000 }), /between 5 and 600/);
  assert.throws(() => createService(db, alpha, { name: "  ", durationMinutes: 30 }), /needs a name/);

  const created = createService(db, alpha, { name: "Consult", durationMinutes: 45, priceMinor: 15000, currency: "AED" });
  assert.ok(created.serviceId);
  closeDb();
});

test("services are scoped to their workspace", () => {
  const { db, alpha, beta } = fixture({ withLeads: false });
  createService(db, alpha, { name: "Alpha consult", durationMinutes: 30 });

  assert.equal(listServices(db, alpha).length, 1);
  assert.equal(listServices(db, beta).length, 0, "beta must not see alpha's services");
  assert.throws(() => listServices(db, null), /needs an organization id/);

  closeDb();
});

test("new staff come with a working week, not an empty diary", () => {
  const { db, alpha } = fixture({ withLeads: false });
  const { staffId } = createStaff(db, alpha, { name: "Dana", timezone: DUBAI });

  const monday = availabilityFor(db, alpha, staffId, 1);
  const saturday = availabilityFor(db, alpha, staffId, 6);
  assert.equal(monday.length, 1);
  assert.equal(monday[0].start_minute, 540, "09:00");
  assert.equal(monday[0].end_minute, 1020, "17:00");
  assert.equal(saturday.length, 0, "the weekend is closed by default");
  assert.equal(listStaff(db, alpha).length, 1);

  closeDb();
});

test("a booking inside the working day is accepted and ends when the service ends", () => {
  const { db, alpha } = fixture({ withLeads: false });
  const service = createService(db, alpha, { name: "Facial", durationMinutes: 60 });
  const { staffId } = createStaff(db, alpha, { name: "Dana", timezone: DUBAI });

  const startsAt = zonedToUtc(MONDAY, 10 * 60, DUBAI);
  const result = book(db, alpha, { staffId, serviceId: service.serviceId, startsAt });

  assert.equal(result.ok, true);
  assert.equal(result.startsAt, `${MONDAY}T06:00:00.000Z`);
  assert.equal(result.endsAt, `${MONDAY}T07:00:00.000Z`, "the end is the start plus the duration");

  closeDb();
});

test("a booking outside opening hours is refused", () => {
  const { db, alpha } = fixture({ withLeads: false });
  const service = createService(db, alpha, { name: "Facial", durationMinutes: 60 });
  const { staffId } = createStaff(db, alpha, { name: "Dana", timezone: DUBAI });

  const evening = book(db, alpha, { staffId, serviceId: service.serviceId, startsAt: zonedToUtc(MONDAY, 20 * 60, DUBAI) });
  assert.equal(evening.ok, false);
  assert.equal(evening.reason, "outside_hours");

  const weekend = book(db, alpha, { staffId, serviceId: service.serviceId, startsAt: zonedToUtc(SATURDAY, 10 * 60, DUBAI) });
  assert.equal(weekend.reason, "outside_hours");

  closeDb();
});

test("a treatment that would run past closing time is refused", () => {
  const { db, alpha } = fixture({ withLeads: false });
  const service = createService(db, alpha, { name: "Deep treatment", durationMinutes: 90 });
  const { staffId } = createStaff(db, alpha, { name: "Dana", timezone: DUBAI });

  // 16:30 with a 17:00 close. The start is inside the day and the end is not, which is exactly the
  // booking a system that only checks the start time will happily accept.
  const result = book(db, alpha, { staffId, serviceId: service.serviceId, startsAt: zonedToUtc(MONDAY, 16 * 60 + 30, DUBAI) });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "outside_hours");

  // 15:30 is the latest that fits.
  const fits = book(db, alpha, { staffId, serviceId: service.serviceId, startsAt: zonedToUtc(MONDAY, 15 * 60 + 30, DUBAI) });
  assert.equal(fits.ok, true);

  closeDb();
});

test("two overlapping appointments for one person are refused", () => {
  const { db, alpha } = fixture({ withLeads: false });
  const service = createService(db, alpha, { name: "Facial", durationMinutes: 60 });
  const { staffId } = createStaff(db, alpha, { name: "Dana", timezone: DUBAI });

  const first = book(db, alpha, { staffId, serviceId: service.serviceId, startsAt: zonedToUtc(MONDAY, 10 * 60, DUBAI) });
  assert.equal(first.ok, true);

  // Thirty minutes later overlaps the first by half an hour.
  const overlap = book(db, alpha, { staffId, serviceId: service.serviceId, startsAt: zonedToUtc(MONDAY, 10 * 60 + 30, DUBAI) });
  assert.equal(overlap.ok, false);
  assert.equal(overlap.reason, "conflict");
  assert.equal(overlap.conflictId, first.appointmentId);

  // Back to back is not a conflict, and refusing it would lose a real appointment every day.
  const next = book(db, alpha, { staffId, serviceId: service.serviceId, startsAt: zonedToUtc(MONDAY, 11 * 60, DUBAI) });
  assert.equal(next.ok, true);

  closeDb();
});

test("cancelling frees the slot", () => {
  const { db, alpha } = fixture({ withLeads: false });
  const service = createService(db, alpha, { name: "Facial", durationMinutes: 60 });
  const { staffId } = createStaff(db, alpha, { name: "Dana", timezone: DUBAI });

  const startsAt = zonedToUtc(MONDAY, 10 * 60, DUBAI);
  const first = book(db, alpha, { staffId, serviceId: service.serviceId, startsAt });

  assert.equal(setAppointmentStatus(db, alpha, first.appointmentId, "cancelled").ok, true);
  assert.equal(hasConflict(db, alpha, staffId, first.startsAt, first.endsAt), null);

  const rebooked = book(db, alpha, { staffId, serviceId: service.serviceId, startsAt });
  assert.equal(rebooked.ok, true, "a cancelled slot must be bookable again");

  closeDb();
});

test("rescheduling respects both the diary and the opening hours", () => {
  const { db, alpha } = fixture({ withLeads: false });
  const service = createService(db, alpha, { name: "Facial", durationMinutes: 60 });
  const { staffId } = createStaff(db, alpha, { name: "Dana", timezone: DUBAI });

  const first = book(db, alpha, { staffId, serviceId: service.serviceId, startsAt: zonedToUtc(MONDAY, 10 * 60, DUBAI) });
  const second = book(db, alpha, { staffId, serviceId: service.serviceId, startsAt: zonedToUtc(MONDAY, 12 * 60, DUBAI) });

  const clash = reschedule(db, alpha, second.appointmentId, zonedToUtc(MONDAY, 10 * 60, DUBAI));
  assert.equal(clash.ok, false);
  assert.equal(clash.reason, "conflict");

  const late = reschedule(db, alpha, second.appointmentId, zonedToUtc(MONDAY, 20 * 60, DUBAI));
  assert.equal(late.reason, "outside_hours");

  // Moving it to a free hour works, and the appointment keeps its own identity.
  const moved = reschedule(db, alpha, second.appointmentId, zonedToUtc(MONDAY, 14 * 60, DUBAI));
  assert.equal(moved.ok, true);
  const listed = listAppointments(db, alpha).find((a) => a.id === second.appointmentId);
  assert.equal(listed.starts_at, `${MONDAY}T10:00:00.000Z`);
  assert.equal(listed.id, second.appointmentId);
  assert.notEqual(first.appointmentId, second.appointmentId);

  closeDb();
});

test("a booking cannot reach across workspaces", () => {
  const { db, alpha, beta } = fixture({ withLeads: false });

  const alphaService = createService(db, alpha, { name: "Alpha facial", durationMinutes: 60 });
  const betaService = createService(db, beta, { name: "Beta consult", durationMinutes: 30 });
  const alphaStaff = createStaff(db, alpha, { name: "Dana", timezone: DUBAI });
  const betaStaff = createStaff(db, beta, { name: "Sam", timezone: LONDON });

  const startsAt = zonedToUtc(MONDAY, 10 * 60, DUBAI);

  // Alpha's service with beta's staff, and beta's service with alpha's staff: both refused, because
  // both would write a row that one of the two workspaces could not explain.
  assert.equal(book(db, alpha, { staffId: betaStaff.staffId, serviceId: alphaService.serviceId, startsAt }).reason, "unknown_staff");
  assert.equal(book(db, alpha, { staffId: alphaStaff.staffId, serviceId: betaService.serviceId, startsAt }).reason, "unknown_service");

  const ok = book(db, alpha, { staffId: alphaStaff.staffId, serviceId: alphaService.serviceId, startsAt });
  assert.equal(ok.ok, true);

  assert.equal(listAppointments(db, alpha).length, 1);
  assert.equal(listAppointments(db, beta).length, 0, "beta must not see alpha's diary");

  // And a staff member belongs to one workspace only.
  assert.equal(freeSlots(db, beta, alphaStaff.staffId, MONDAY, 60).length, 0, "alpha's staff have no diary in beta");

  closeDb();
});

test("free slots are inside the day and clear of what is already booked", () => {
  const { db, alpha } = fixture({ withLeads: false });
  const service = createService(db, alpha, { name: "Facial", durationMinutes: 60 });
  const { staffId } = createStaff(db, alpha, { name: "Dana", timezone: DUBAI });

  const before = freeSlots(db, alpha, staffId, MONDAY, 60);
  // 09:00 to 16:00 in 15 minute steps is 29 slots.
  assert.equal(before.length, 29);
  assert.equal(before[0].startsAt, `${MONDAY}T05:00:00.000Z`, "09:00 in Dubai");
  assert.equal(before[before.length - 1].startsAt, `${MONDAY}T12:00:00.000Z`, "16:00 in Dubai");

  book(db, alpha, { staffId, serviceId: service.serviceId, startsAt: zonedToUtc(MONDAY, 10 * 60, DUBAI) });

  const after = freeSlots(db, alpha, staffId, MONDAY, 60);
  // A one hour appointment at 10:00 knocks out seven quarter hour starts: 09:15 through 10:45 are
  // the ones that would overlap it. 09:00 is untouched because it ends exactly when the booking
  // begins, and 11:00 is untouched because it starts exactly when the booking ends.
  assert.equal(after.length, 22, "29 minus the seven starts that would overlap");
  assert.equal(after.some((slot) => slot.startsAt === `${MONDAY}T06:00:00.000Z`), false, "the booked hour is not offered again");
  assert.equal(after.some((slot) => slot.startsAt === `${MONDAY}T05:00:00.000Z`), true, "09:00 still works, it ends exactly at 10:00");
  assert.equal(after.some((slot) => slot.startsAt === `${MONDAY}T07:00:00.000Z`), true, "11:00 still works, it starts exactly at 11:00");

  closeDb();
});

test("a closed day offers nothing at all", () => {
  const { db, alpha } = fixture({ withLeads: false });
  const { staffId } = createStaff(db, alpha, { name: "Dana", timezone: DUBAI });
  assert.deepEqual(freeSlots(db, alpha, staffId, SATURDAY, 60), []);
  closeDb();
});

test("availability can be replaced, which is how a clinic changes its hours", () => {
  const { db, alpha } = fixture({ withLeads: false });
  const { staffId } = createStaff(db, alpha, { name: "Dana", timezone: DUBAI });

  const result = setAvailability(db, alpha, staffId, [
    { weekday: 1, startMinute: 600, endMinute: 780 },
    { weekday: 3, startMinute: 600, endMinute: 780 },
  ]);
  assert.equal(result.ok, true);
  assert.equal(availabilityFor(db, alpha, staffId, 1)[0].start_minute, 600);
  assert.equal(availabilityFor(db, alpha, staffId, 2).length, 0, "the old Monday to Friday set is gone");
  assert.equal(availabilityFor(db, alpha, staffId, 3).length, 1, "the new Wednesday is there");

  closeDb();
});

test("roles gate booking, and an unknown status is refused", () => {
  const { db, alpha } = fixture({ withLeads: false });
  const service = createService(db, alpha, { name: "Facial", durationMinutes: 60 });
  const { staffId } = createStaff(db, alpha, { name: "Dana", timezone: DUBAI });

  assert.throws(
    () => book(db, alpha, { staffId, serviceId: service.serviceId, startsAt: zonedToUtc(MONDAY, 600, DUBAI), role: "viewer" }),
    /cannot perform booking:write/,
  );
  assert.throws(() => createService(db, alpha, { name: "Nails", durationMinutes: 30, role: "staff" }), /cannot perform service:write/);

  const created = book(db, alpha, { staffId, serviceId: service.serviceId, startsAt: zonedToUtc(MONDAY, 600, DUBAI), role: "staff" });
  assert.equal(created.ok, true);
  assert.throws(() => setAppointmentStatus(db, alpha, created.appointmentId, "banana"), /Unknown appointment status/);

  closeDb();
});

test("booking and cancelling are recorded in the audit trail", () => {
  const { db, alpha, alice } = fixture({ withLeads: false });
  const service = createService(db, alpha, { name: "Facial", durationMinutes: 60, actorUserId: alice });
  const { staffId } = createStaff(db, alpha, { name: "Dana", timezone: DUBAI, actorUserId: alice });

  const created = book(db, alpha, { staffId, serviceId: service.serviceId, startsAt: zonedToUtc(MONDAY, 600, DUBAI), actorUserId: alice });
  setAppointmentStatus(db, alpha, created.appointmentId, "cancelled", { actorUserId: alice });

  const actions = listAudit(db, alpha).map((r) => r.action);
  for (const expected of ["service.create", "staff.create", "appointment.book", "appointment.cancelled"]) {
    assert.ok(actions.includes(expected), `${expected} should be in the audit trail`);
  }

  closeDb();
});

test("a booking can be attached to a contact from the same workspace only", () => {
  const { db, alpha, beta, captured } = fixture();
  const service = createService(db, alpha, { name: "Facial", durationMinutes: 60 });
  const { staffId } = createStaff(db, alpha, { name: "Dana", timezone: DUBAI });

  const mine = book(db, alpha, {
    staffId,
    serviceId: service.serviceId,
    contactId: captured.alpha.contactId,
    startsAt: zonedToUtc(MONDAY, 600, DUBAI),
  });
  assert.equal(mine.ok, true);

  const theirs = book(db, alpha, {
    staffId,
    serviceId: service.serviceId,
    contactId: captured.beta.contactId,
    startsAt: zonedToUtc(MONDAY, 14 * 60, DUBAI),
  });
  assert.equal(theirs.ok, false);
  assert.equal(theirs.reason, "unknown_contact");

  closeDb();
});
