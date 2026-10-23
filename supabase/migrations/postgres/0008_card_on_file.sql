-- Card-on-file trials.
--
-- The requirement: a subscriber registers, gives card details, gets seven days, and is charged
-- automatically at the end. That needs three facts stored against the subscription, none of which
-- is a card number:
--
--   provider_customer_id     the provider's id for this business
--   payment_method_*         brand and last four, for display and support only
--   card_on_file_at          when the card was actually attached
--
-- Card data never touches this database. The provider holds it, we hold a reference. That is the
-- difference between being able to accept a card and being obliged to pass a PCI audit.

alter table subscriptions add column provider_customer_id text;
alter table subscriptions add column payment_method_brand text;
alter table subscriptions add column payment_method_last4 text;
alter table subscriptions add column card_on_file_at timestamptz;
alter table subscriptions add column trial_days integer;

create index if not exists idx_subscriptions_customer on subscriptions(provider_customer_id);
