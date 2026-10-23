-- The subscriber registry: every sign-up, kept so the business can be talked to again.
--
-- This is the operator's list, not a tenant's customer list. A row may have a workspace attached
-- (once someone signs up) or not (a lead from the contact form). organization_id is nullable for
-- exactly that reason, and the tenant policy means a workspace can read its own row and nothing
-- else, while the platform administrator reads the whole list.
--
-- Consent is stored, not assumed. An email address is not permission to market to it.
create table if not exists subscribers (
  id                text primary key,
  organization_id   text references organizations(id) on delete set null,
  user_id           text references users(id) on delete set null,
  email             text not null,
  email_normalized  text not null unique,
  name              text,
  phone             text,
  company           text,
  country           text,
  city              text,
  language          text,
  source            text not null default 'website',
  status            text not null default 'lead',   -- lead | trial | free | paying | cancelled
  plan_id           text,
  marketing_consent integer not null default 0,
  consent_at        text,
  consent_source    text,
  unsubscribed_at   text,
  tags_json         text,
  notes             text,
  created_at        text not null,
  updated_at        text not null
);

create index if not exists idx_subscribers_status on subscribers(status, created_at);
create index if not exists idx_subscribers_org on subscribers(organization_id);

-- What we have offered them, and what came of it. A record of offers is the only way to know
-- whether the list is worth anything, and it stops the same person being pitched the same thing
-- twice in a month.
create table if not exists subscriber_offers (
  id              text primary key,
  organization_id text references organizations(id) on delete set null,
  subscriber_id   text not null references subscribers(id) on delete cascade,
  item_key        text not null,
  item_label      text not null,
  channel         text not null default 'email',
  status          text not null default 'queued',   -- queued | sent | accepted | declined | ignored
  note            text,
  offered_at      text not null,
  responded_at    text,
  created_at      text not null
);

create index if not exists idx_subscriber_offers_sub on subscriber_offers(subscriber_id, offered_at);
create index if not exists idx_subscriber_offers_item on subscriber_offers(item_key, status);
