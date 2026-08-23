# Deploying FlightDeck (operator runbook)

FlightDeck ships as a container image on GHCR. **You (the operator) deploy it** —
this repo only produces the image + this stack file and never touches your Swarm
(ABSOLUTE prod rule). Read the [SEAMS](#seams) section first: it lists everything
you must supply for your environment.

Deliverables in this repo:

| File | Purpose |
| --- | --- |
| `Dockerfile` | Builds the non-root Bun image; state on a `/data` volume. |
| `docker-entrypoint.sh` | Bridges Swarm secret **files** → the env the server reads (`*_FILE` convention). |
| `.github/workflows/release.yml` | On a `v*` tag / release, builds + pushes `ghcr.io/wave-engineering/flightdeck`. |
| `deploy/flightdeck.stack.yml` | The Swarm stack (this file's sibling). |
| `config/flightdeck.env.example` | Every env knob, documented, with placeholders. |

---

## Prerequisites

- A Docker **Swarm** manager node (`docker swarm init` if you haven't).
- Access to pull from GHCR. The package is published under
  `ghcr.io/wave-engineering/flightdeck`. If it's private, log in on each node:
  ```sh
  echo "$GHCR_PAT" | docker login ghcr.io -u <your-user> --password-stdin
  ```
  (A read:packages PAT, or make the package public in GHCR.)
- An existing **ingress / reverse-proxy** (Traefik, Caddy, nginx-proxy, …) on the
  Swarm — FlightDeck sits behind it (see the ingress SEAM).

---

## 1. Choose the image tag

Releases are cut by pushing a `v*` **git** tag (e.g. `v0.1.0`), which runs
`.github/workflows/release.yml` and publishes the image. **The published image tag
strips the leading `v`** (semver convention — git `v0.1.0` → image `0.1.0`), so
`IMAGE_TAG` below is the *image* tag, not the git tag. Pick a **released** tag
(never `latest` in prod) and export it — the stack file requires it:

```sh
export IMAGE_TAG=0.1.0        # git tag v0.1.0 → image tag 0.1.0
```

Pull it onto the nodes (optional; Swarm will pull on deploy):

```sh
docker pull ghcr.io/wave-engineering/flightdeck:$IMAGE_TAG
```

## 2. Create the secrets

The ingest bearer token is **required**; the Discord token is optional. Values go
straight into Swarm's encrypted store — never into a file in this repo.

```sh
# Required — the shared token the emitters send on POST /ingest.
# Generate a long random value and give the SAME value to the emitters
# (their FLIGHTDECK_INGEST_TOKEN).
openssl rand -hex 32 | tr -d '\n' | docker secret create flightdeck_ingest_token -

# Optional — only if you want Discord phone alerts. Otherwise create a throwaway
# placeholder so the secret reference resolves (push stays inert without a channel):
printf 'unused' | docker secret create flightdeck_discord_token -
```

## 3. Map the volume

The stack declares a named volume `flightdeck_data` (driver `local`) mounted at
`/data` — it holds the append-only event log (source of truth) **and** the SQLite
view. No action needed for a single-node Swarm; Docker creates it on first deploy.
For **multi-node**, see the volume SEAM below so state survives rescheduling.

Note for later: `flightdeck_data` is the **stack-file key**, not the volume
Docker actually creates — Swarm namespaces it as `<stack>_<key>`, i.e.
`flightdeck_flightdeck_data` for a stack deployed as `flightdeck` (step 6).
Matters if you ever need to `docker run -v` against it directly — see
"Repairing accumulated bad state" below.

## 4. Wire ingress (SEAM — you fill this)

FlightDeck listens on `:8080` and is **not** meant to be published directly. Attach
it to your ingress network and add your proxy's routing labels. Both are left as
seams in `flightdeck.stack.yml`. Example for **Traefik** (adapt host/entrypoint/TLS):

```yaml
    networks:
      - flightdeck
      - traefik-public            # your existing ingress network
    deploy:
      labels:
        - "traefik.enable=true"
        - "traefik.docker.network=traefik-public"
        - "traefik.http.routers.flightdeck.rule=Host(`flightdeck.example.lan`)"
        - "traefik.http.routers.flightdeck.entrypoints=websecure"
        - "traefik.http.routers.flightdeck.tls=true"
        - "traefik.http.services.flightdeck.loadbalancer.server.port=8080"
```

Then declare the ingress network as external at the bottom of the stack file:

```yaml
networks:
  flightdeck:
    driver: overlay
    attachable: true
  traefik-public:
    external: true
```

## 5. Validate (no deploy)

```sh
IMAGE_TAG=$IMAGE_TAG docker stack config -c deploy/flightdeck.stack.yml
```

Renders + validates the fully-interpolated stack **without applying** it. Fix any
error before step 6.

## 6. Deploy

```sh
IMAGE_TAG=$IMAGE_TAG docker stack deploy -c deploy/flightdeck.stack.yml flightdeck
```

Watch it come up and confirm health:

```sh
docker stack services flightdeck
docker service logs -f flightdeck_flightdeck   # expect: "[flightdeck] listening on ..."
```

The service is healthy when `GET /health` returns `"ok": true` (the image's
`HEALTHCHECK` polls it — it acts only on `ok`). Point the emitters'
`FLIGHTDECK_INGEST_URL` at the ingress host and confirm events land
(`POST /ingest` → `202`).

### Which build is deployed? (#24)

`/health` reports the running image's build identity, so triage never has to
guess or shell into the manager node:

```sh
curl -s https://<ingress-host>/health
# {"ok":true,"version":"0.2.8","gitSha":"<full sha>","startedAt":"<iso-8601>"}
```

The same version is shown in the UI topbar (right-hand side), with the full SHA
and process start in its tooltip — so an operator reporting a problem can state
the build without any shell access at all.

`version` is the semver-stripped git tag baked in at image build time, **not**
whatever is in the source tree. A `dev` / `unknown` reading means the image was
built outside the release workflow. The release workflow refuses to publish a
tag that disagrees with `package.json` (`scripts/ci/check-version.sh`), so the
reported version cannot silently drift from the tag the way it did through
v0.2.0–v0.2.7.

`startedAt` is the process start, not the deploy time — if it is recent but you
did not deploy, the container restarted on its own.

To smoke-test ingest end-to-end, ALWAYS mark the event synthetic (#7) — the board
filters `detail.synthetic: true` activities, so a test event never masquerades as
a real campaign in the closed lane:

```sh
curl -sS -X POST "https://<ingress-host>/ingest" \
  -H "Authorization: Bearer $FLIGHTDECK_INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"kind":"activity_start","activityId":"deploy-smoke-'"$(date +%s)"'",
       "ts":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'","schemaVersion":1,
       "label":"deploy smoke test","detail":{"synthetic":true}}'
# expect: 202
```

### Repairing accumulated bad state (#25)

The JSONL event log under `/data` is **append-only with no prune, no TTL, no
admin/delete route** — a card built from malformed or stale events (a fixed
emit-side bug, a fragmented campaign) stays broken forever; restarting the
service does not help, because `rebuild()` re-folds the **entire** log into a
fresh SQLite view on every boot. (Duplicate `promoted`/`close-issue` events
are NOT in this category as of #27 — the reducer dedups both, live and on
rebuild; a wipe buys nothing against that symptom specifically.)

**Wiping `/data/flightdeck.db` alone is a no-op.** It self-heals from the log
by design (see "State model" below) — the rebuilt view reproduces the exact
same bad cards. The file that actually needs to change is `events.jsonl`.

If the console is confusing in a way that traces to old events rather than a
live defect (check open issues for a currently-reproducing cause first — a
wipe throws away real campaign history and should not be the first thing you
reach for), the supported repair is a **backup-first log wipe**, done with no
campaign in flight (a live campaign's card would rebuild from post-wipe
events only and render starved — the exact symptom you're clearing).

**Find the node and the real volume name first — do not guess either.** The
named volume in the stack file is `flightdeck_data`, but Swarm namespaces a
non-external volume as `<stack>_<key>` on deploy, so the volume `docker run`
must mount is **`flightdeck_flightdeck_data`**, not the bare stack-file key —
and on a multi-node Swarm, `driver: local` (see the Volume durability SEAM
below) pins it to whichever node the service task actually ran on, which may
not be the manager you're typing on. Running the repair against the wrong
name or the wrong node produces the same silent failure either way: `docker
run -v <wrong-name>:/d` creates a **new, empty** volume, `cp` fails to find
`events.jsonl`, the `&&` chain stops before truncating anything, and you're
left with an orphan volume and the original bad state fully intact — while
the two `service scale` lines still print as if the repair worked.

```sh
# Resolve the node that owns the volume, and the volume's real name.
docker service ps flightdeck_flightdeck --format '{{.Node}}'
VOL=$(docker service inspect flightdeck_flightdeck \
  --format '{{range .Spec.TaskTemplate.ContainerSpec.Mounts}}{{.Source}}{{end}}')

# Run the following ON that node.
docker service scale flightdeck_flightdeck=0
docker run --rm -v "$VOL":/d alpine sh -c \
  'cp /d/events.jsonl /d/events.jsonl.bak-$(date +%Y%m%dT%H%M%S) && : > /d/events.jsonl && rm -f /d/flightdeck.db'
docker service scale flightdeck_flightdeck=1
```

The backup filename is second-granular, not day-granular — a same-day retry
must not silently overwrite it with an already-truncated log. Keep the
`.bak` file: it is the only surviving evidence of any bad events it
contained, and is the regression corpus for validating a fix aimed at
whatever caused them.

**No retention/cutoff policy exists yet.** A wipe is a one-time reset, not a
standing remedy — unbounded append with a full re-fold on every boot is also
an unbounded startup cost, and the log will accumulate again. This is a real
open design decision (a TTL? an event cap? an operator-triggered prune
route?), not yet made; tracked on flightdeck#25.

---

## SEAMS

Everything you MUST supply for your environment. The stack does not deploy until
these are resolved.

| Seam | Where | What to do |
| --- | --- | --- |
| **Image tag** | `IMAGE_TAG` env | Pin to a released **image** tag, e.g. `0.1.0` (git tag `v0.1.0` publishes image `0.1.0` — the `v` is stripped). The stack refuses to render without it. Never `latest` in prod. |
| **Ingest token secret** | `docker secret flightdeck_ingest_token` | Create it (step 2). Same value goes to the emitters. Required — the server fails closed without it. |
| **Ingress network + routing labels** | `services.flightdeck.networks` + `deploy.labels` in the stack | Attach your existing ingress overlay and add your proxy's route → port `8080` (step 4). Left commented — not guessed. |
| **Discord push** (optional) | `FLIGHTDECK_DISCORD_CHANNEL` env + `flightdeck_discord_token` secret | Set BOTH to enable phone alerts; leave blank to keep push inert. |
| **Volume durability** (multi-node) | `volumes.flightdeck_data.driver` | `local` pins state to one node. For multi-node, use a networked/backed driver **or** constrain the service to the volume's node so state isn't lost on reschedule. |
| **Watcher thresholds** (optional) | `FLIGHTDECK_WATCH_INTERVAL_MS`, `FLIGHTDECK_STALE_MS` | Defaults 60s / 15m. Override in the stack env if you want different staleness sensitivity. |

## Notes

- **No real secrets in this repo.** The stack references secrets by name only;
  `config/flightdeck.env.example` carries placeholders. Keep it that way.
- **The container is the sole Discord pusher.** Agent hosts stay outbound-only
  emitters; don't add ingress to them.
- **State model.** The JSONL event log under `/data` is the source of truth; the
  SQLite view rebuilds from it on boot, so a lost/corrupt `.db` self-heals — but
  the **log** must persist. Back up `/data` (or its volume) accordingly.
