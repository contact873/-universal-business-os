-- Bookings: services, staff, weekly availability, and appointments. SQLite dialect.
--
-- Two deliberate choices worth stating, because both are places where a booking system usually
-- goes wrong:
--
--   * Overlap is checked in code, not by a constraint. SQLite has no exclusion constraint, so a
--     unique index on (staff_id, starts_at) would only stop the exact same start time while two
--     overlapping appointments ten minutes apart sailed through. The Postgres file adds a real
--     overlap guard; this one relies on the application, and that difference is stated rather than
--     hidden.
--   * Availability is stored as minutes from midnight on a weekday, in the staff member's own
--     timezone. Timezones are resolved with Intl at read time rather than by storing offsets, so
--     daylight saving does not silently shift a clinic's day.

create table if not exists services (
  id               text primary key,
  organization_id  text not null references organizations(id) on delete cascade,
  name             text not null,
  duration_minutes integer not null,
  price_minor      integer,
  currency         text,
  active           integer not null default 1,
  created_at       text not null
);

create index if not exists idx_services_org on services(organization_id, active);

create table if not exists staff (
  id              text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  user_id         text references users(id) on delete set null,
  name            text not null,
  timezone        text,
  active          integer not null default 1,
  created_at      text not null
);

create index if not exists idx_staff_org on staff(organization_id, active);

create table if not exists availability (
  id              text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  staff_id        text not null references staff(id) on delete cascade,
  weekday         integer not null,
  start_minute    integer not null,
  end_minute      integer not null,
  created_at      text not null
);

create index if not exists idx_availability_staff on availability(organization_id, staff_id, weekday);

create table if not exists appointments (
  id                 text primary key,
  organization_id    text not null references organizations(id) on delete cascade,
  staff_id           text not null references staff(id) on delete cascade,
  service_id         text not null references services(id) on delete restrict,
  contact_id         text references contacts(id) on delete set null,
  starts_at          text not null,
  ends_at            text not null,
  status             text not null default 'booked',
  notes              text,
  created_by_user_id text references users(id) on delete set null,
  created_at         text not null,
  updated_at         text not null
);

create index if not exists idx_appointments_org_start on appointments(organization_id, starts_at);
create index if not exists idx_appointments_staff_start on appointments(organization_id, staff_id, starts_at);
