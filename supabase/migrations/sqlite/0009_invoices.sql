-- Invoices, because "any Pakistani bank" resolves to two very different mechanisms.
--
-- Card and wallet payments go through a local payment service provider: Safepay, PayFast, or a
-- merchant gateway from a bank. That needs a merchant account, company documents and approval, and
-- the provider holds the card data.
--
-- Bank transfer needs none of that. An invoice with an IBAN works with every bank in the country
-- today, which is why it is the path implemented here rather than left as a note. The two can run
-- side by side: invoice now, card checkout when the merchant account is live.

create table if not exists invoices (
  id              text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  plan_id         text not null,
  amount_minor    integer not null,
  currency        text not null,
  period_days     integer not null default 30,
  method          text not null default 'bank_transfer',
  status          text not null default 'issued',   -- issued | paid | void
  reference       text,                             -- the bank reference the customer quotes
  note            text,
  due_at          text,
  paid_at         text,
  created_at      text not null,
  updated_at      text not null
);

create index if not exists idx_invoices_org on invoices(organization_id, status, created_at);
