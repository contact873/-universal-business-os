# What actually serves raschident.com, and the only two ways out

Queried directly against the authoritative nameservers on 23 October 2026. Nothing here is a guess:
the records below were read from `olga.ns.cloudflare.com`, the server that answers for your domain.

## The split that explains everything

| | Nameservers | What it controls |
|---|---|---|
| **Live zone** | `olga.ns.cloudflare.com`, `sid.ns.cloudflare.com` | Everything your visitors and mail servers actually use |
| **Editing zone** | `chin.ns.cloudflare.com`, `clyde.ns.cloudflare.com` | Everything you have been adding since this started |

Registrar is PDR Ltd, and it delegates to **olga/sid**. The zone you can log into is `chin`/`clyde`.

So every record added there — the Resend DKIM and SPF, the DMARC entry, the `app.connect` CNAME to the
Fly app — is in a zone nothing queries. Those records are not wrong. They are in the wrong building.

## What the live zone actually contains

```
raschident.com                A      23.227.38.65                    (Shopify)
raschident.com                MX     10 aspmx.l.google.com.          (Google Workspace)
                                    20 alt1.aspmx.l.google.com.
                                    20 alt2.aspmx.l.google.com.
                                    30 aspmx2..aspmx5.googlemail.com.
raschident.com                TXT    "v=spf1 include:_spf.google.com ~all"
www.raschident.com            CNAME  shops.myshopify.com.             (the store)
connect.raschident.com        A      172.67.165.20 / 104.21.11.26      (Cloudflare proxy)
                                     AAAA 2606:4700:3033::6815:b1a
                                          2606:4700:3035::ac43:a514
mail.raschident.com           A      172.67.165.20 / 104.21.11.26      (Cloudflare proxy)
relcoai.com                   A      216.150.1.1 / 216.150.16.1        (Vercel)
relcoai.com                   MX     1 smtp.google.com.
relcoai.com                   TXT    "google-site-verification=nh1Y45..."
www.relcoai.com               CNAME  deff2731928a4e33.vercel-dns-016.com.
```

Two things to notice:

1. **Your email is Google Workspace**, and the only sender authorised by SPF is Google. That is why
   the Resend DKIM records had no effect: they are not in this zone, and nothing here includes Resend.
2. **`relcoai.com` is in the same live zone.** Mia's domain depends on the same account you cannot
   reach. Anything you ever need to change there has the same problem.

Not present in the live zone, though added elsewhere: `send`, `rsend.send`, `resend._domainkey`,
`_dmarc`, `app.connect`. All five are inert where they sit.

## The decision, which is binary

### Route A — get back into the account behind olga/sid

Nothing needs to be rebuilt. You log in, add the `app.connect` CNAME and the Resend records, and both
the application hostname and customer email start working. It also keeps the Shopify store, the
Cloudflare proxy in front of cPanel, and Google Workspace exactly as they are.

Worth trying, in this order: password reset on every email address you have owned; search old inboxes
for Cloudflare verification mail; ask whoever built the Shopify store or the cPanel site, because
they usually created the zone. If all of that fails, Cloudflare support can move a zone on proof of
domain ownership — and you do control the registrar, which is what such a claim rests on.

### Route B — change the nameservers at PDR Ltd

This puts the whole zone under the account you can reach. It fixes the hostname and email together.
It also means **you must reproduce every record above by hand, and you cannot read the live zone to
check your work.** Four things make that genuinely dangerous:

- `connect.raschident.com` and `mail.raschident.com` are behind Cloudflare's proxy, so their origin
  IPs are hidden from any query. You would have to read the shared IP from cPanel to reconstruct them.
- Cloudflare settings that DNS cannot express would be lost: page rules, redirects, SSL mode, WAF,
  origin certificates, cache rules. Records alone do not rebuild the edge.
- Five Google MX records and the SPF string must be exact, or mail to your domain stops.
- `relcoai.com` is in the same zone. Moving the nameservers moves that too.

If you go this way, the order is: finish the inventory, reproduce it in the reachable zone, verify
every name with `dig` **before** touching the registrar, then switch and watch both mail and the
store for a day.

## What to gather, whichever route you choose

1. Can you log into the Cloudflare account whose nameservers are `olga` and `sid`? Try every email you
   have used. This single answer decides the route.
2. Does PDR Ltd offer DNS management for raschident.com in its own control panel? If it does, that is
   a third option: leave Cloudflare out of it entirely and serve DNS from the registrar.
3. The shared IP address of the cPanel server, from the right-hand sidebar in cPanel. Needed for
   any move, and unobtainable by query while the proxy is on.

## Meanwhile

Nothing about the website or the application depends on this. The form posts to
`https://relco-business-os.fly.dev/api/trial`, which works today. The only things waiting on the
hostname are the tidier URL and outbound customer email.

## The origin address, confirmed 25 October 2026

```
raschident.com        origin  158.106.138.119   (cPanel, LiteSpeed, /home/raschide)
```

This is the value behind the Cloudflare proxy, so it is invisible from outside; it was read from the
cPanel sidebar and then verified by requesting it directly with `Host: connect.raschident.com`, which
answered 200 over HTTP and 200 over HTTPS with a valid certificate.

It matters for two records in the new zone: `connect` and `mail` must both point at it, both proxied.
It also settles the SSL mode: the origin has a valid certificate, so Full (strict) is correct and
Flexible is not needed anywhere.
