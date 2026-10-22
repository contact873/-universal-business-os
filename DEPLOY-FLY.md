# Deploying to Fly.io

This is the deployment this repository is prepared for: one machine, one volume, one SQLite file.

**Read this first.** A Fly volume attaches to a single machine, so this app runs as one instance
and does not scale horizontally. That is the correct trade at this stage, and it stops being true
the moment two machines need to write at once. The answer then is the asynchronous database
migration, not a second machine.

---

## What is already in the repository

| File | Purpose |
|---|---|
| `Dockerfile` | Three stage build. The C++ toolchain used to compile `better-sqlite3` never reaches the runtime image |
| `.dockerignore` | Keeps `node_modules`, the local database and `.env` files out of the build context |
| `fly.toml` | Region, volume mount, release command, health check, one always on machine |
| `scripts/create-admin.mjs` | Creates the first administrator, with a hashed password, on a fresh volume |

**Not verified here:** neither Docker nor `flyctl` is installed on this machine, so the image has
never been built and the deploy has never been run. The first `fly deploy` is the first build. If it
fails, it will be in the Dockerfile, and the error will say which line.

---

## Steps

Each line is one command. Type them, or paste one at a time and press Return.

### 1. Install the CLI and sign in

```
brew install flyctl
```

```
fly auth signup
```

Fly asks for a payment card even on the smallest machine. A shared 1 vCPU, 1GB machine plus a 1GB
volume is the smallest configuration that runs this. Check current pricing on their site rather than
trusting a number in this file.

### 2. Create the app and the volume

```
cd ~/Documents/apps/universal-business-os
```

```
fly apps create relco-business-os
```

```
fly volumes create ubos_data --region dxb --size 1
```

`dxb` is Dubai. It is the closest region to Pakistan and the Gulf; `sin` and `bom` are the
alternatives if you would rather.

If `relco-business-os` is taken, choose another name and change the `app` line in `fly.toml` to
match. The volume name must stay `ubos_data`, because `fly.toml` mounts that name at `/data`.

### 3. Set the secrets

Generate a session secret first:

```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Then set it, pasting the value it printed:

```
fly secrets set SESSION_SECRET=paste-the-value-here
```

The rest, all on one line:

```
fly secrets set PLATFORM_ADMIN_EMAILS=contact@raschident.com APP_URL=https://app.connect.raschident.com
```

Optional, and only when you have the keys:

```
fly secrets set RESEND_API_KEY=re_your_key EMAIL_FROM="Relco <noreply@send.raschident.com>"
```

```
fly secrets set BILLING_WEBHOOK_SECRET=any-long-random-string
```

There is deliberately no `DATABASE_URL`. This build writes to the volume at `DATA_DIR=/data`, and
setting a hosted database URL would make it refuse to start, because the driver is synchronous and
cannot talk to one.

### 4. Deploy

```
fly deploy
```

What happens, in order: the image builds, the volume mounts at `/data`, the release command runs
`node scripts/migrate.mjs` so the schema exists, then the machine takes traffic. A failed migration
stops the deploy rather than leaving new code on an old schema.

### 5. Check it

```
fly status
```

```
curl -s https://relco-business-os.fly.dev/api/health
```

That should print `{"ok":true,...,"database":"reachable"}`. If it says `unreachable`, the volume is
not mounted where the app expects it, which means `DATA_DIR` and the mount do not match.

### 6. Create your account

Signing up through the interface also works, but the first platform administrator should be created
deliberately:

```
fly ssh console
```

Then, inside that shell:

```
node scripts/create-admin.mjs --email=contact@raschident.com --password='your long password'
```

It creates one user, one workspace, and the plan catalogue, and refuses to run again without
`--force`. Type `exit` to leave the shell.

### 7. Point the domain at it

```
fly certs add app.connect.raschident.com
```

Then in Cloudflare, in the `raschident.com` zone:

- Type: **CNAME**
- Name: **app**
- Target: **relco-business-os.fly.dev**
- Proxy status: **DNS only**, the grey cloud

The grey cloud matters. With Cloudflare proxying, Fly cannot complete its certificate challenge, and
the domain will keep showing a TLS error. Once the certificate is issued you can turn the proxy back
on if you want Cloudflare in front.

Then set the app URL, so links in emails and redirects are correct:

```
fly secrets set APP_URL=https://app.connect.raschident.com
```

### 8. First real check

Open `https://app.connect.raschident.com/app/bookings`. Add a service, add a staff member with a
timezone, and book an appointment at a time the diary should accept. Then try the same time again
and confirm it is refused. That exercises the two rules the booking module exists to enforce.

---

## Day to day

| Task | Command |
|---|---|
| Deploy a change | `fly deploy` |
| See logs | `fly logs` |
| Open a shell on the machine | `fly ssh console` |
| List releases | `fly releases` |
| Stop the app entirely | `fly apps destroy relco-business-os` |
| Scale down to save money | Set `min_machines_running = 0` in `fly.toml`, then `fly deploy` |

Scaling to zero means the first visitor of the day waits for a cold start. Scaling to two machines
is not possible with this volume, and pretending otherwise would corrupt the database.

## Backups, before you take a real customer

Fly snapshots volumes, but **a backup you have never restored is not a backup**. Before the first
paying workspace exists, do this once, deliberately:

1. Take a snapshot or copy the database file out with `fly ssh console`.
2. Restore it into a throwaway app.
3. Sign in and confirm the workspaces are there.

If step 3 does not work, the backup does not exist.

## When this stops being the right shape

The moment you need two machines, scheduled jobs, or a serverless platform, the SQLite file has to
go. That is the asynchronous database milestone: convert the data layer to a hosted client, keep
every test as the guard rail, then a database URL becomes the only change. Until then, one machine
and one volume is simpler, cheaper, and easier to reason about.
