# Universal Business OS, container image.
#
# Three stages so the build tools for the native SQLite module never reach the runtime image.
# better-sqlite3 compiles from source here on purpose: relying on a matching prebuilt binary for
# every platform is how a deploy fails on a Tuesday for no visible reason.
#
# Debian slim rather than Alpine, because musl and node-gyp have a long history of disagreeing
# about this particular module.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-bookworm-slim AS builder
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Pages are rendered on demand, so the build should not touch the database. This placeholder is
# belt and braces: if a page ever does try to open it during the build, the error is a clear
# "missing secret" rather than a confusing stack. It is not the runtime secret, which comes from
# `fly secrets` and is never baked into an image.
ENV NEXT_TELEMETRY_DISABLED=1 \
    SESSION_SECRET=build-time-placeholder-not-the-real-secret
RUN npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DATA_DIR=/data

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 1001 nodejs \
 && useradd -u 1001 -g nodejs --create-home nextjs

# The built server, its dependencies, and the two directories the release command needs:
# scripts/migrate.mjs imports src/lib and reads supabase/migrations.
COPY --from=builder --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/.next ./.next
COPY --from=builder --chown=nextjs:nodejs /app/package.json ./package.json
COPY --from=builder --chown=nextjs:nodejs /app/next.config.mjs ./next.config.mjs
COPY --from=builder --chown=nextjs:nodejs /app/src ./src
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts
COPY --from=builder --chown=nextjs:nodejs /app/supabase ./supabase

# The volume is mounted here by fly.toml. Creating the directory with the right owner means the
# first migration works even if the volume mounts empty.
RUN mkdir -p /data && chown -R nextjs:nodejs /data

USER nextjs
EXPOSE 3000

# The server itself. Migrations run as Fly's release command before traffic arrives, not here,
# so two machines can never migrate at the same time.
CMD ["npm", "run", "start"]
