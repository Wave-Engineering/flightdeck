# syntax=docker/dockerfile:1
#
# FlightDeck container image (S5.4 / #878) — DELIVERABLE, not deployed here.
#
# `docker build .` produces the image the operator later pulls from GHCR (see
# .github/workflows/release.yml). This repo never runs the container or deploys
# it (ABSOLUTE prod rule / NG-1). Multi-stage: an isolated deps stage so the
# runtime image carries no devDependencies or build context cruft.
#
# Bun version is pinned to match CI (.github/workflows/ci.yml: bun@1.3.11).

# ── Stage 1: production dependencies ────────────────────────────────────────
# Isolated so the runtime image never inherits devDependencies (typescript,
# @types/bun) or a host node_modules. FlightDeck currently has ZERO runtime deps
# (it uses only Bun built-ins: Bun.serve + bun:sqlite), so this resolves to an
# (near-)empty node_modules today — the stage exists so adding a real runtime
# dep later needs no Dockerfile change. `mkdir` guarantees the dir for COPY even
# when nothing is installed.
FROM oven/bun:1.3.11-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN mkdir -p node_modules && bun install --frozen-lockfile --production

# ── Stage 2: runtime ────────────────────────────────────────────────────────
FROM oven/bun:1.3.11-slim AS runtime

# Build identity (#24). Fed by the release workflow from the git tag + SHA and
# baked as ENV so the RUNNING service can report which image it is — the one
# fact that separates "stale deployment" from "genuine defect" during triage.
# Defaults keep a plain `docker build .` honest rather than claiming a release.
ARG FLIGHTDECK_VERSION=dev
ARG FLIGHTDECK_GIT_SHA=unknown

# Defaults are safe for a container: bind 0.0.0.0:8080 and keep the append-only
# event log + SQLite materialized view on the persistent /data volume (below),
# never in an image layer. Every value is overridable at deploy time.
ENV FLIGHTDECK_VERSION=${FLIGHTDECK_VERSION} \
    FLIGHTDECK_GIT_SHA=${FLIGHTDECK_GIT_SHA} \
    NODE_ENV=production \
    PORT=8080 \
    FLIGHTDECK_LOG_PATH=/data/events.jsonl \
    FLIGHTDECK_DB_PATH=/data/flightdeck.db

WORKDIR /app

# Prod deps first (stable layer), then source last so a code-only change doesn't
# bust the deps cache.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY src ./src

# Secret-file bridge: translates Swarm/Docker secret files (FLIGHTDECK_*_FILE)
# into the bare env vars the server reads, then exec's the service. Packaging
# glue only — src/server.ts is unchanged. See docker-entrypoint.sh.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Persistent state mount point: the append-only event log (source of truth) AND
# the rebuildable SQLite view both live here. Owned by the non-root run user so
# the service can write once the operator maps a named volume onto it.
RUN mkdir -p /data && chown -R bun:bun /data
VOLUME ["/data"]

# Drop root. The oven/bun image ships a non-privileged `bun` user (uid/gid 1000).
USER bun

EXPOSE 8080

# Liveness: the service exposes GET /health -> {ok:true, version, gitSha,
# startedAt} (#24). The probe only checks res.ok, so the added fields do not
# change the healthcheck contract. Uses bun (already on PATH) so no curl/wget
# is needed in the slim image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The server reads FLIGHTDECK_INGEST_TOKEN from the environment (a Swarm secret
# at deploy) and fails closed if unset — no token is ever baked into the image.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["bun", "run", "src/server.ts"]
