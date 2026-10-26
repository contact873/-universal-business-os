# Moving raschident.com to the Cloudflare account you control

Written 25 October 2026. Every value below was read from the live zone, not assumed.

## The one thing that goes wrong here

Cloudflare does not carry records between accounts. When the registry starts answering from
`chin`/`clyde`, the zone in your new account is **empty except for what you create**, and the old one
stops answering. So every record the business depends on must exist in the new account **before** the
switch finishes — and the one that hurts is mail, because your email is Google Workspace and a missing
MX record means mail stop arriving with no error to anybody, including the sender.

Two facts that make this safer than it looks:

- **DNSSEC is unsigned.** Confirmed by whois. Nothing to disable first, which removes the usual
  way this goes wrong.
- **`relcoai.com` is in a different account** (`art`/`coco`). Mia's domain is unaffected by this move.

## What the live zone holds now

| Type | Name | Value | Proxy |
|---|---|---|---|
| A | `raschident.com` | `23.227.38.65` | DNS only | 
| CNAME | `www` | `shops.myshopify.com` | DNS only |
| A | `connect` | `158.106.138.119` | **Proxied** |
| A | `mail` | `158.106.138.119` | **Proxied** |
| MX | `raschident.com` | `10 aspmx.l.google.com`, `20 alt1.aspmx.l.google.com`, `20 alt2.aspmx.l.google.com`, `30 aspmx2.googlemail.com`, `30 aspmx3.googlemail.com`, `30 aspmx4.googlemail.com`, `30 aspmx5.googlemail.com` | — |
| TXT | `raschident.com` | `v=spf1 include:_spf.google.com ~all` | — |
| AAAA | `connect`, `mail` | `2606:4700:3033::6815:b1a`, `2606:4700:3035::ac43:a514` | Proxied |

Not present, and worth adding later: `google._domainkey` (Workspace DKIM is off, which is why some of
your mail lands in spam), `_dmarc`, and anything for Resend.

## The origin address, confirmed

`158.106.138.119` — the Shared IP from cPanel. Verified rather than assumed, by asking that address
directly while pretending to be a browser:

```
http://158.106.138.119/  with Host: connect.raschident.com   ->  200, LiteSpeed
https://connect.raschident.com  resolved to that address      ->  200, certificate valid
```

The second line is the one that matters for the switch. The origin holds a **valid certificate** for
your hostname, which means the new zone can use **Full (strict)** — the setting that actually encrypts
between Cloudflare and your host. If the certificate had been missing or self-signed, the temptation
would have been Flexible, and that setting quietly serves a padlock over an unencrypted connection.

## Create these in the new account, before the switch completes

| # | Type | Name | Value | Proxy |
|---|---|---|---|---|
| 1 | A | `@` | `23.227.38.65` | DNS only |
| 2 | CNAME | `www` | `shops.myshopify.com` | DNS only |
| 3 | A | `connect` | `158.106.138.119` | Proxied |
| 4 | A | `mail` | `158.106.138.119` | Proxied |
| 5 | MX | `@` | the seven Google entries above, with their priorities | — |
| 6 | TXT | `@` | `v=spf1 include:_spf.google.com ~all` | — |
| 7 | CNAME | `app.connect` | `relco-business-os.fly.dev` | **DNS only** |
| 8 | TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:contact@raschident.com` | — |

Rules that are easy to get wrong:

- **MX records are never proxied.** Cloudflare will not let you, but do not try.
- **`app.connect` must be grey**, DNS only. Fly terminates TLS for that hostname and validates the
  certificate by reading the CNAME. Behind the orange cloud there is nothing for it to read.
- **`www` must be grey.** Shopify checks the record and refuses the domain when it is proxied.
- **DMARC starts at `p=none`.** It reports without blocking. Moving to `p=quarantine` after a month of
  clean reports is the correct order; starting at quarantine silently bins your own invoices.

## Then the switch, in this order

1. Create records 1–8 above. The zone may still say "pending" — records can be created anyway.
2. Confirm the registrar has `chin.ns.cloudflare.com` and `clyde.ns.cloudflare.com`, and that
   `olga` and `sid` are gone.
3. Wait. Check with `~/Documents/apps/check-domain.sh` — it says which nameservers are answering.
4. When the new nameservers answer: **SSL/TLS → Overview → Full (strict)**. Never Flexible: it makes
   the browser think the site is secure while Cloudflare talks to your host in plain text, and it
   breaks submitted forms.
5. Let Cloudflare issue its universal certificate, then confirm `connect` still serves.
6. **Skip "only allow Cloudflare IP addresses at your origin"** for now. It is a fine idea and the
   wrong week to do it: locking the origin to Cloudflare's ranges while records are still settling is
   how people cut themselves off from their own cPanel.
7. For the application, once the name resolves:

   ```bash
   fly certs add app.connect.raschident.com -a relco-business-os
   ```

   Then the app accepts that hostname once `PUBLIC_ORIGINS` includes it.
8. For platform email, add Resend's records on a **subdomain** — `send.raschident.com` — so Google's
   SPF on the root is never disturbed. Resend shows the exact three records; add those and nothing
   else. Then `fly secrets set RESEND_FROM="Connect <hello@raschident.com>"` and send one real test.

## How to know it worked

```
./check-domain.sh
```

It reports: which nameservers answer, whether mail still has somewhere to go, whether SPF survived,
whether `connect` and `app.connect` resolve, and whether the site answers over HTTPS. Run it before
the switch, so you have a picture of "working" to compare against.
