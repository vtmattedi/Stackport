FROM node:24-bookworm-slim AS builder
WORKDIR /app

# ── Backend ────────────────────────────────────────
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
# npm run build:api -> version:bump -> scripts/bump-version.cjs (and the client
# build below calls the same script via ../scripts/bump-version.cjs). Deliberately
# build:api, not the root "build" script — that one also runs build:client, which
# would fail here since client/ isn't copied into the image until the next stage.
COPY scripts/ ./scripts/
RUN npm run build:api
RUN npm prune --omit=dev

# ── Frontend ───────────────────────────────────────
COPY client/package*.json ./client/
RUN cd client && npm ci
COPY client/ ./client/
RUN cd client && npm run build

FROM node:24-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production

# StackPort shells out to `docker`/`docker compose` (to run managed projects against
# the host daemon via the mounted socket), `git` (repo clone/fetch/pull), and (Phase
# 1.6) `openssl` directly for certificate expiry/issuer reads against the bind-mounted
# /etc/letsencrypt — see docs/dockerization/BASELINE.md §6, src/services/certbot.ts.
# `gosu` is used by docker-entrypoint.sh to drop from root (needed once at startup to
# align with the mounted docker.sock's GID) back to the unprivileged `node` user
# before the app actually runs.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg git gosu openssl \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
      > /etc/apt/sources.list.d/docker.list \
    && apt-get update && apt-get install -y --no-install-recommends \
      docker-ce-cli docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/client/dist ./client/dist
COPY --chown=node:node scripts/ ./scripts/
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

RUN mkdir -p /app/data /app/logs && chown -R node:node /app/data /app/logs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Runs as root only long enough to align the container's docker-socket group with
# whatever GID the host's /var/run/docker.sock actually has (it varies by distro), then
# drops to the unprivileged `node` user — see docker-entrypoint.sh.
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
