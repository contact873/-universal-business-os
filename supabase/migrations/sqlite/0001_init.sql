-- Universal Business OS, milestone 1. SQLite dialect.
--
-- Kept in lockstep with ../postgres/0001_init.sql. `node scripts/drift.mjs` fails the build if the
-- two files stop describing the same tables and columns, because two hand-maintained dialects
-- will diverge and nobody notices until a migration runs in production.
--
-- Conventions:
--   * ids are text (uuid strings), timestamps are ISO-8601 text
--   * money is an integer count of minor units, never a float
--   * booleans are 0/1 integers here, real booleans in Postgres
--   * every tenant-owned table carries organization_id and is listed in ../../policies/rls.sql

create table if not exists schema_meta (
  version    integer primary key,
  dialect    text not null,
  applied_at text not null
);

-- Identity ------------------------------------------------------------------

create table if not exists users (
  id                text primary key,
  email             text not null unique,   -- the one email that is genuinely required: it is the login
  password_hash     text not null,
  name              text,
  email_verified_at text,
  is_platform_admin integer not null default 0,
  created_at        text not null
);

create table if not exists sessions (
  id         text primary key,
  user_id    text not null references users(id) on delete cascade,
  org_id     text,                          -- the workspace this session is currently acting in
  token_hash text not null unique,
  expires_at text not null,
  revoked_at text,
  created_at text not null
);

create index if not exists idx_sessions_user on sessions(user_id);

-- Tenancy -------------------------------------------------------------------

create table if not exists organizations (
  id         text primary key,
  name       text not null,
  slug       text not null unique,
  industry   text,
  timezone   text,
  created_at text not null
);

create table if not exists memberships (
  organization_id text not null references organizations(id) on delete cascade,
  user_id         text not null references users(id) on delete cascade,
  role            text not null,
  created_at      text not null,
  primary key (organization_id, user_id)
);

create index if not exists idx_memberships_user on memberships(user_id);

create table if not exists invitations (
  id              text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  email           text not null,
  role            text not null,
  token_hash      text not null unique,
  expires_at      text not null,
  accepted_at     text,
  created_at      text not null
);

-- Billing -------------------------------------------------------------------
-- Present from the start so that turning billing on later is an integration, not a rewrite.

create table if not exists plans (
  id          text primary key,
  name        text not null,
  price_minor integer not null,
  currency    text not null,
  exponent    integer not null default 2,   -- KWD, BHD and OMR use 3
  interval    text not null,                -- month | year
  limits_json text
);

create table if not exists subscriptions (
  id              text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  provider        text,
  provider_id     text unique,
  status          text not null,            -- trialing | active | past_due | canceled
  trial_end       text,
  period_end      text,
  created_at      text not null
);

create table if not exists entitlements (
  id              text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  feature         text not null,
  limit_value     integer,                  -- null means unlimited within fair use
  created_at      text not null,
  unique (organization_id, feature)
);

-- CRM -----------------------------------------------------------------------

create table if not exists contacts (
  id               text primary key,
  organization_id  text not null references organizations(id) on delete cascade,
  name             text,
  source           text,                    -- first touch, set once, never overwritten
  first_seen_at    text not null,
  last_seen_at     text not null,
  submission_count integer not null default 1
);

create index if not exists idx_contacts_org on contacts(organization_id, last_seen_at);

create table if not exists contact_identities (
  id               text primary key,
  organization_id  text not null references organizations(id) on delete cascade,
  contact_id       text not null references contacts(id) on delete cascade,
  kind             text not null,           -- email | phone | whatsapp | instagram | facebook | linkedin | telegram | x
  value_raw        text not null,           -- exactly as the person typed it
  value_normalized text not null,
  label            text,
  needs_review     integer not null default 0,
  first_seen_at    text not null,
  -- Per organisation, not global. Two businesses may legitimately have the same customer,
  -- so a global unique key here would make the second one fail to save.
  unique (organization_id, kind, value_normalized)
);

create index if not exists idx_identities_lookup on contact_identities(organization_id, kind, value_normalized);

create table if not exists contact_tags (
  contact_id text not null references contacts(id) on delete cascade,
  tag        text not null,                 -- audience categories are many-to-many tags, not a column
  added_at   text not null,
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
  payload_hash    text,                     -- idempotency hashes the payload, never the clock
  created_at      text not null,
  updated_at      text not null
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
  created_at      text not null
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
  created_at      text not null
);

create index if not exists idx_audit_org on audit_logs(organization_id, created_at);

create table if not exists usage_events (
  id              text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  event_type      text not null,
  quantity        integer not null default 1,
  created_at      text not null
);

create index if not exists idx_usage_org on usage_events(organization_id, event_type, created_at);

-- A webhook retry must never grant a second subscription or a second credit,
-- so the provider's own event id is the primary defence.
create table if not exists webhook_events (
  id           text primary key,
  provider     text not null,
  event_id     text not null unique,
  payload_hash text,
  processed_at text,
  created_at   text not null
);
