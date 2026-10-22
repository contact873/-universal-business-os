-- A subscription has to say which plan it is on, or the entitlement sync has nothing to sync from.
-- Without this, a webhook could record that a payment succeeded and still not know what the customer
-- bought.

alter table subscriptions add column plan_id text;

create index if not exists idx_subscriptions_org on subscriptions(organization_id, created_at);
