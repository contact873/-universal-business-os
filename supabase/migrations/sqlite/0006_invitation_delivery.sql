-- Whether an invitation was actually delivered, recorded on the invitation itself.
--
-- The alternative is an interface that says "invitation sent" because it tried. Providers fail,
-- keys expire, and a workspace owner should be able to see which invitations need chasing.

alter table invitations add column sent_at text;
alter table invitations add column send_error text;
