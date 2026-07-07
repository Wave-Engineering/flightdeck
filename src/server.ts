// FlightDeck container service — authenticated ingest (S2.1 / #872).
//
// Bun HTTP service. The one write surface is `POST /ingest`:
//   • guarded by a shared bearer token (F-6; matches the emit.py/emit.ts shipper,
//     which POSTs `Authorization: Bearer $FLIGHTDECK_INGEST_TOKEN`);
//   • validates the body against the vendored event contract (schema, not shared
//     code — F-7 / TC-4);
//   • appends the event to the append-only log (source of truth) via an IngestSink.
//
// Ingest is the ONLY ingress; agent hosts are outbound-only emitters (NG-3). The
// SQLite materialized view + fold arrive in S2.2 (store.ts) as a drop-in IngestSink.
//
// Responses: 401 (missing/invalid token), 400 (malformed JSON or schema-invalid),
// 202 (accepted + persisted), 405 (wrong method), 404 (unknown path).

import { EventValidationError, validateEvent } from "./events/contract.ts";
import { EventLog, type IngestSink } from "./log.ts";
import { Store } from "./store.ts";

export interface ServerConfig {
  port: number;
  host?: string;
  /** Shared bearer token required on `POST /ingest`. Empty ⇒ fail-closed (all 401). */
  token: string;
  /** Where valid events are appended (log or store). */
  sink: IngestSink;
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/**
 * Extract the bearer token from an `Authorization: Bearer <token>` header.
 * Returns `null` when the header is absent or not a Bearer credential.
 */
function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? (match[1] as string).trim() : null;
}

/**
 * Constant-time-ish token comparison. Bails fast on length mismatch (token length
 * is not secret); otherwise compares every char so a match doesn't short-circuit.
 */
function tokenMatches(configured: string, presented: string | null): boolean {
  if (!configured || presented === null) return false;
  if (configured.length !== presented.length) return false;
  let diff = 0;
  for (let i = 0; i < configured.length; i++) {
    diff |= configured.charCodeAt(i) ^ presented.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Handle one request. Exported (pure over `cfg`) so tests can drive it directly
 * without binding a port.
 */
export async function handleRequest(req: Request, cfg: ServerConfig): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/health") {
    if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
    return json({ ok: true }, 200);
  }

  if (url.pathname === "/ingest") {
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

    // Auth first — never read/persist the body of an unauthenticated request (R-06).
    if (!tokenMatches(cfg.token, bearerToken(req))) {
      return json({ error: "unauthorized" }, 401);
    }

    // Body must be valid JSON.
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: "malformed JSON body" }, 400);
    }

    // Body must satisfy the event contract (R-07).
    try {
      validateEvent(body);
    } catch (err) {
      const message =
        err instanceof EventValidationError ? err.message : "schema validation failed";
      return json({ error: message }, 400);
    }

    // Persist to the append-only log (R-08). validateEvent asserted the type.
    cfg.sink.append(body);
    return json({ ok: true, accepted: true }, 202);
  }

  return json({ error: "not found" }, 404);
}

/** Bind a Bun HTTP server for the given config. */
export function createServer(cfg: ServerConfig) {
  return Bun.serve({
    port: cfg.port,
    hostname: cfg.host ?? "0.0.0.0",
    fetch: (req) => handleRequest(req, cfg),
  });
}

// Entry point: `bun run src/server.ts`. Config from the environment (Swarm secret
// for the token, a persistent volume path for the log). No deploy here — the
// service only listens; the operator deploys it (NG-1 / PC-1).
if (import.meta.main) {
  const token = process.env["FLIGHTDECK_INGEST_TOKEN"] ?? "";
  if (!token) {
    console.error(
      "[flightdeck] FATAL: FLIGHTDECK_INGEST_TOKEN is not set — ingest would fail-closed. Refusing to start.",
    );
    process.exit(1);
  }
  const logPath = process.env["FLIGHTDECK_LOG_PATH"] ?? "data/events.jsonl";
  const dbPath = process.env["FLIGHTDECK_DB_PATH"] ?? "data/flightdeck.db";
  const port = Number(process.env["PORT"] ?? "8080");
  // Store = append-only log (source of truth) + SQLite materialized view; the view
  // is rebuilt from the log on boot, so a lost/corrupt db self-heals (R-09).
  const sink = new Store({ log: new EventLog(logPath), dbPath });
  const server = createServer({ port, token, sink });
  console.error(
    `[flightdeck] listening on http://${server.hostname}:${server.port} (log: ${logPath}, view: ${dbPath})`,
  );
}
