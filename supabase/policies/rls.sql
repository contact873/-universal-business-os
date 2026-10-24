-- Row level security for Universal Business OS.
--
-- This file is the real tenant boundary on Postgres. The application layer in
-- src/lib/tenant.ts enforces the same boundary in code, but a single missed WHERE clause
-- in a future feature would leak one business's customer list to another. RLS is the
-- backstop that does not depend on remembering.
--
-- Before running anything against Supabase, read the note at the top of
-- ../migrations/postgres/0001_init.sql about the anon key.

-- Who is acting -------------------------------------------------------------

-- Self-hosted: the application sets `app.user_id` per connection.
-- On Supabase, replace the body of this one function with:  select auth.uid()::text
-- Nothing else in this file needs to change.
create or replace function app_current_user() returns text
  language sql stable
as $$
  select nullif(current_setting('app.user_id', true), '')
$$;

-- Membership is the whole authorisation model: you may see a row if you belong to the
-- organisation that owns it. Roles decide what you may do within it, in src/lib/roles.ts.
create or replace function app_is_member(org text) returns boolean
  language sql stable security definer
as $$
  select exists (
    select 1 from memberships m
    where m.organization_id = org
      and m.user_id = app_current_user()
  )
$$;

-- Tenant tables -------------------------------------------------------------
--
-- Every table below carries organization_id. Add a table to this list in the same commit
-- that creates it, or scripts/drift.mjs will fail and tell you that you forgot.

do $$
declare
  t text;
  tenant_tables text[] := array[
    'memberships',
    'invitations',
    'subscriptions',
    'entitlements',
    'contacts',
    'contact_identities',
    'leads',
    'lead_activities',
    'audit_logs',
    'usage_events',
    'services',
    'staff',
    'availability',
    'appointments',
    'invoices',
    'lifecycle_actions',
    'subscribers',
    'subscriber_offers'
  ];
begin
  foreach t in array tenant_tables loop
    execute format('alter table %I enable row level security', t);

    -- Re-running this file must not fail, so drop before creating.
    execute format('drop policy if exists tenant_select on %I', t);
    execute format('drop policy if exists tenant_insert on %I', t);
    execute format('drop policy if exists tenant_update on %I', t);
    execute format('drop policy if exists tenant_delete on %I', t);

    execute format(
      'create policy tenant_select on %I for select using (app_is_member(organization_id))', t);
    execute format(
      'create policy tenant_insert on %I for insert with check (app_is_member(organization_id))', t);
    execute format(
      'create policy tenant_update on %I for update using (app_is_member(organization_id)) with check (app_is_member(organization_id))', t);
    execute format(
      'create policy tenant_delete on %I for delete using (app_is_member(organization_id))', t);
  end loop;
end $$;

-- The one table that reaches its tenant through a parent ---------------------
--
-- contact_tags has no organization_id of its own: the contact it hangs off carries it.
-- Denormalising the column here would be faster and would also allow the two to disagree.

alter table contact_tags enable row level security;

drop policy if exists tenant_select on contact_tags;
drop policy if exists tenant_insert on contact_tags;
drop policy if exists tenant_update on contact_tags;
drop policy if exists tenant_delete on contact_tags;

create policy tenant_select on contact_tags for select
  using (exists (select 1 from contacts c where c.id = contact_tags.contact_id and app_is_member(c.organization_id)));

create policy tenant_insert on contact_tags for insert
  with check (exists (select 1 from contacts c where c.id = contact_tags.contact_id and app_is_member(c.organization_id)));

create policy tenant_update on contact_tags for update
  using (exists (select 1 from contacts c where c.id = contact_tags.contact_id and app_is_member(c.organization_id)));

create policy tenant_delete on contact_tags for delete
  using (exists (select 1 from contacts c where c.id = contact_tags.contact_id and app_is_member(c.organization_id)));

-- Deliberately NOT tenant scoped -------------------------------------------------
--
-- users          a person may belong to several organisations, so a membership filter here
--                would hide their own account from them. Scoped in the application instead.
-- sessions       the same user row, for the same reason.
-- organizations  visible only through memberships; reads go through a join.
-- plans          public price list, nobody's private data.
-- webhook_events written by the provider, not by a person. No user context exists.
--
-- These five have no RLS policy on purpose. If you add a policy to them, add it because you
-- have a threat in mind, not because the list looked short.
