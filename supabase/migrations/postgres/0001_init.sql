-- Universal Business OS, milestone 1. Postgres dialect, intended for Supabase.
--
-- Lockstep partner: ../sqlite/0001_init.sql. `node scripts/drift.mjs` fails if the table or
-- column names in the two files stop matching. Types are allowed to differ; names are not.
--
-- Differences from the SQLite file, all deliberate:
--   * boolean where SQLite uses integer 0/1
--   * timestamptz with a default instead of ISO text
--   * text ids, so nothing depends on extension-generated uuids
--
-- Before running this against Supabase, read ../../policies/rls.sql. Row level security is what
-- actually keeps one business out of another's data; without it the policy-free tables are open
-- to any holder of the anon key.

create table if not exists schema_meta (
  version    integer primary key,
  dialect    text not null,
  applied_at timestamptz not null default now()
);

-- Identity ------------------------------------------------------------------

create table if not exists users (
  id                text primary key,
  email             text not null unique,
  password_hash     text not null,
  name              text,
  email_verified_at timestamptz,
  is_platform_admin boolean not null default false,
  created_at        timestamptz not null default now()
);

create table if not exists sessions (
  id         text primary key,
  user_id    text not null references users(id) on delete cascade,
  org_id     text,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_sessions_user on sessions(user_id);

-- Tenancy -------------------------------------------------------------------

create table if not exists organizations (
  id         text primary key,
  name       text not null,
  slug       text not null unique,
  industry   text,
  timezone   text,
  created_at timestamptz not null default now()
);

create table if not exists memberships (
  organization_id text not null references organizations(id) on delete cascade,
  user_id         text not null references users(id) on delete cascade,
  role            text not null,
  created_at      timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create index if not exists idx_memberships_user on memberships(user_id);

create table if not exists invitations (
  id              text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  email           text not null,
  role            text not null,
  token_hash      text not null unique,
  expires_at      timestamptz not null,
  accepted_at     timestamptz,
  created_at      timestamptz not null default now()
);

-- Billing -------------------------------------------------------------------

create table if not exists plans (
  id          text primary key,
  name        text not null,
  price_minor integer not null,
  currency    text not null,
  exponent    integer not null default 2,
  interval    text not null,
  limits_json text
);

create table if not exists subscriptions (
  id              text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  provider        text,
  provider_id     text unique,
  status          text not null,
  trial_end       timestamptz,
  period_end      timestamptz,
  created_at      timestamptz not null default now()
);

create table if not exists entitlements (
  id              text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  feature         text not null,
  limit_value     integer,
  created_at      timestamptz not null default now(),
  unique (organization_id, feature)
);

-- CRM -----------------------------------------------------------------------

create table if not exists contacts (
  id               text primary key,
  organization_id  text not null references organizations(id) on delete cascade,
  name             text,
  source           text,
  first_seen_at    timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  submission_count integer not null default 1
);

create index if not exists idx_contacts_org on contacts(organization_id, last_seen_at);

create table if not exists contact_identities (
  id               text primary key,
  organization_id  text not null references organizations(id) on delete cascade,
  contact_id       text not null references contacts(id) on delete cascade,
  kind             text not null,
  value_raw        text not null,
  value_normalized text not null,
  label            text,
  needs_review     boolean not null default false,
  first_seen_at    timestamptz not null default now(),
  unique (organization_id, kind, value_normalized)
);

create index if not exists idx_identities_lookup on contact_identities(organization_id, kind, value_normalized);

create table if not exists contact_tags (
  contact_id text not null references contacts(id) on delete cascade,
  tag        text not null,
  added_at   timestamptz not null default now(),
  primary key (contact_id, tag)
);

create index if not exists idx_contact_tags_tag on contact_tags(tag);

create table if not exists leads (
  id              text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  contact_id      text not null references contacts(id) on delete cascade,
  stage           text not null default 'new',
  source          text,
  form_id         text,
  message         text,
  value_minor     integer,
  currency        text,
  owner_user_id   text references users(id) on delete set null,
  payload_hash    text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_leads_org_stage on leads(organization_id, stage, created_at);
create index if not exists idx_leads_dedupe on leads(organization_id, form_id, payload_hash, created_at);

create table if not exists lead_activities (
  id              text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  lead_id         text not null references leads(id) on delete cascade,
  actor_user_id   text references users(id) on delete set null,
  kind            text not null,
  body            text,
  created_at      timestamptz not null default now()
);

create index if not exists idx_activities_org_lead on lead_activities(organization_id, lead_id, created_at);

-- Operations ----------------------------------------------------------------

create table if not exists audit_logs (
  id              text primary key,
  organization_id text references organizations(id) on delete cascade,
  actor_user_id   text references users(id) on delete set null,
  action          text not null,
  entity          text,
  entity_id       text,
  meta_json       text,
  created_at      timestamptz not null default now()
);

create index if not exists idx_audit_org on audit_logs(organization_id, created_at);

create table if not exists usage_events (
  id              text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  event_type      text not null,
  quantity        integer not null default 1,
  created_at      timestamptz not null default now()
);

create index if not exists idx_usage_org on usage_events(organization_id, event_type, created_at);

create table if not exists webhook_events (
  id           text primary key,
  provider     text not null,
  event_id     text not null unique,
  payload_hash text,
  processed_at timestamptz,
  created_at   timestamptz not null default now()
);
