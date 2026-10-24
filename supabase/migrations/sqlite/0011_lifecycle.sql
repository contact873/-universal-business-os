-- What the lifecycle job has already done, so running it twice is safe.
--
-- A scheduler will run twice in the same minute eventually, and a lifecycle that issues two invoices
-- for one period or downgrades a workspace twice is worse than one that does nothing at all. The key is
-- what the action is about (a trial, a period end), not when it ran, so a retry finds it and stops.

create table if not exists lifecycle_actions (
  key             text primary key,
  kind            text not null,
  organization_id text not null references organizations(id) on delete cascade,
  at              text not null
);

create index if not exists idx_lifecycle_org on lifecycle_actions(organization_id, at);
