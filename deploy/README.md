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

The service is healthy when `GET /health` returns `{"ok":true}` (the image's
`HEALTHCHECK` polls it). Point the emitters' `FLIGHTDECK_INGEST_URL` at the
ingress host and confirm events land (`POST /ingest` → `202`).

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
