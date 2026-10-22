-- Bookings: services, staff, weekly availability, and appointments. Postgres dialect.
--
-- The difference from the SQLite file is the overlap guard. Postgres can express "this staff member
-- cannot have two overlapping appointments" as a database rule, and a database rule cannot be
-- bypassed by a future code path that forgets to check. It needs btree_gist for the equality part
-- of the exclusion, which Supabase provides but a plain Postgres install may not, so it is wrapped
-- in a guarded block: without the extension the constraint is skipped rather than failing the
-- migration half way through.

create extension if not exists btree_gist;

create table if not exists services (
  id               text primary key,
  organization_id  text not null references organizations(id) on delete cascade,
  name             text not null,
  duration_minutes integer not null,
  price_minor      integer,
  currency         text,
  active           boolean not null default true,
  created_at       timestamptz not null default now()
);

create index if not exists idx_services_org on services(organization_id, active);

create table if not exists staff (
  id              text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  user_id         text references users(id) on delete set null,
  name            text not null,
  timezone        text,
  active          boolean not null default true,
  created_at      timestamptz not null default now()
);

create index if not exists idx_staff_org on staff(organization_id, active);

create table if not exists availability (
  id              text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  staff_id        text not null references staff(id) on delete cascade,
  weekday         integer not null,
  start_minute    integer not null,
  end_minute      integer not null,
  created_at      timestamptz not null default now()
);

create index if not exists idx_availability_staff on availability(organization_id, staff_id, weekday);

create table if not exists appointments (
  id                 text primary key,
  organization_id    text not null references organizations(id) on delete cascade,
  staff_id           text not null references staff(id) on delete cascade,
  service_id         text not null references services(id) on delete restrict,
  contact_id         text references contacts(id) on delete set null,
  starts_at          timestamptz not null,
  ends_at            timestamptz not null,
  status             text not null default 'booked',
  notes              text,
  created_by_user_id text references users(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists idx_appointments_org_start on appointments(organization_id, starts_at);
create index if not exists idx_appointments_staff_start on appointments(organization_id, staff_id, starts_at);

-- Cancelled appointments must not block a slot, which is why the predicate excludes them.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'btree_gist') then
    alter table appointments
      add constraint appointments_no_overlap
      exclude using gist (
        staff_id with =,
        tstzrange(starts_at, ends_at) with &&
      ) where (status <> 'canceled');
  end if;
end $$;
