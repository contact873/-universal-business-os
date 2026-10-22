-- A workspace needs a way to receive enquiries from a website it does not control yet without
-- exposing the whole API. The intake key is that handle: it identifies one workspace and does
-- nothing else, so leaking a website's form configuration cannot read anybody's customer list.

alter table organizations add column intake_key text;

create unique index if not exists idx_organizations_intake_key on organizations(intake_key);
