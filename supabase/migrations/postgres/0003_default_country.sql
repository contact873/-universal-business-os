-- A workspace needs to know which country it is in, so that a mobile number typed the local way
-- ("0501234567") can be matched against the same number typed internationally. Without this the
-- intake endpoint has no country to assume, and the number is stored with a plus in front of the
-- local trunk zero, which matches nothing and is flagged for review instead.

alter table organizations add column default_country text;
