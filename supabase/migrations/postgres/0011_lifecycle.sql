create table if not exists lifecycle_actions (
  key             text primary key,
  kind            text not null,
  organization_id text not null references organizations(id) on delete cascade,
  at              timestamptz not null
);

create index if not exists idx_lifecycle_org on lifecycle_actions(organization_id, at);
