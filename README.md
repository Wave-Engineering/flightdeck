# flightdeck

FlightDeck — event-sourced, containerized status console for wave campaigns & lazyriver floats (Plan #854, Dev Spec `claudecode-workflow:docs/flightdeck-devspec.md`).

Every deterministic state change in the wave-pattern pipeline emits one typed, scope-tagged **event** to an append-only log; this service folds that log into a live view. **No agent is in the reporting path.**

## Phase 2 — container service (this repo, in progress)

The Bun/TS service:

- **Authenticated ingest** (`POST /ingest`) — shared bearer token (F-6); validates each event against the vendored event contract; appends to the append-only log.
- **Event-sourced store** — the JSONL event log is the single source of truth; a `bun:sqlite` table is a rebuildable materialized view. One pure `fold()` computes all derived state; `rebuild()` re-folds the whole log (rebuild ≡ live). The view is never trusted across a restart: a lost/empty **or** SQLite-corrupt view file is discarded on boot and rebuilt from the log.
- **Metrics + split-ETA** — wall / idle / ci-wait / collision / confidence / drift derived from event timestamps; ETA is split into machine-time vs blocked-on-you (campaign burn-down / float cord-band). The token metric is an honest `null` stub until #853 lands.

### The event contract

`src/events/schema.json` is vendored **verbatim** from `claudecode-workflow:src/wave_status/events/schema.json` — the one versioned, additively-evolved contract (schema, not shared code). `src/events/contract.ts` is a TypeScript mirror (typed constants + a dependency-free validator) pinned to the vendored schema by `tests/contract.test.ts`.

## Develop

```bash
bun install
bun test          # unit + integration tests
bun run typecheck # tsc --noEmit (strict)
```

Run the service (needs a token; ingest fails closed without one):

```bash
FLIGHTDECK_INGEST_TOKEN=… FLIGHTDECK_LOG_PATH=data/events.jsonl PORT=8080 bun run src/server.ts
```

## Not in this repo / this phase

Deploy is the **operator's** step (ABSOLUTE prod rule / NG-1): no Dockerfile, Swarm stack, or compose lives here yet — those are Phase 5 deliverables the operator applies. This service only listens and folds.
