-- Plan terms that a subscription product needs and a price list does not:
--   setup_minor    the one-time onboarding fee, because a subscription that starts on day one with
--                  no setup either ignores the work or hides it inside a higher monthly price
--   live_in_days   the honest "how long until it is working" figure, which buyers ask first
--
-- Both are nullable: a plan can be priced before its onboarding terms are decided, and null means
-- "not published" rather than zero.

alter table plans add column setup_minor integer;
alter table plans add column live_in_days integer;
