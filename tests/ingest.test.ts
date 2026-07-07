// S2.1 / #872 — authenticated ingest. IT-03: unauth → 401; valid → 202; malformed → 400.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FlightDeckEvent } from "../src/events/contract.ts";
import { EventLog } from "../src/log.ts";
import { handleRequest, type ServerConfig } from "../src/server.ts";

const TOKEN = "test-secret-token-abc123";

let dir: string;
let log: EventLog;
let cfg: ServerConfig;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "flightdeck-ingest-"));
  log = new EventLog(join(dir, "events.jsonl"));
  cfg = { port: 0, token: TOKEN, sink: log };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function ingestReq(body: unknown, token?: string, rawBody?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== undefined) headers["authorization"] = `Bearer ${token}`;
  return new Request("http://fd.local/ingest", {
    method: "POST",
    headers,
    body: rawBody ?? JSON.stringify(body),
  });
}

const validEvent: FlightDeckEvent = {
  kind: "activity_start",
  activityId: "campaign-42",
  ts: "2026-07-07T12:00:00Z",
  activityType: "campaign",
  label: "Blueshift Plan #56",
};

describe("POST /ingest auth", () => {
  test("no Authorization header → 401, not persisted", async () => {
    const res = await handleRequest(ingestReq(validEvent, undefined), cfg);
    expect(res.status).toBe(401);
    expect(log.count()).toBe(0);
  });

  test("wrong token → 401, not persisted", async () => {
    const res = await handleRequest(ingestReq(validEvent, "wrong-token"), cfg);
    expect(res.status).toBe(401);
    expect(log.count()).toBe(0);
  });

  test("empty configured token fails closed → 401", async () => {
    const res = await handleRequest(ingestReq(validEvent, ""), { ...cfg, token: "" });
    expect(res.status).toBe(401);
    expect(log.count()).toBe(0);
  });
});

describe("POST /ingest validation", () => {
  test("valid authenticated event → 202 and persisted", async () => {
    const res = await handleRequest(ingestReq(validEvent, TOKEN), cfg);
    expect(res.status).toBe(202);
    const persisted = log.readAll();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ kind: "activity_start", activityId: "campaign-42" });
  });

  test("malformed JSON → 400, not persisted", async () => {
    const res = await handleRequest(ingestReq(undefined, TOKEN, "{ not json "), cfg);
    expect(res.status).toBe(400);
    expect(log.count()).toBe(0);
  });

  test("schema-invalid event (unknown kind) → 400, not persisted", async () => {
    const bad = { kind: "not-a-kind", activityId: "x", ts: "2026-07-07T12:00:00Z" };
    const res = await handleRequest(ingestReq(bad, TOKEN), cfg);
    expect(res.status).toBe(400);
    expect(log.count()).toBe(0);
  });

  test("schema-invalid event (missing activityId) → 400", async () => {
    const bad = { kind: "step", ts: "2026-07-07T12:00:00Z" };
    const res = await handleRequest(ingestReq(bad, TOKEN), cfg);
    expect(res.status).toBe(400);
    expect(log.count()).toBe(0);
  });

  test("concern event missing concernKind/source → 400", async () => {
    const bad = { kind: "concern", activityId: "x", ts: "2026-07-07T12:00:00Z" };
    const res = await handleRequest(ingestReq(bad, TOKEN), cfg);
    expect(res.status).toBe(400);
    expect(log.count()).toBe(0);
  });

  test("valid concern event → 202", async () => {
    const concern: FlightDeckEvent = {
      kind: "concern",
      activityId: "campaign-42",
      ts: "2026-07-07T12:05:00Z",
      concernKind: "gate-override",
      source: "coded",
    };
    const res = await handleRequest(ingestReq(concern, TOKEN), cfg);
    expect(res.status).toBe(202);
    expect(log.count()).toBe(1);
  });
});

describe("routing", () => {
  test("GET /health → 200 {ok}", async () => {
    const res = await handleRequest(
      new Request("http://fd.local/health", { method: "GET" }),
      cfg,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("GET /ingest (wrong method) → 405", async () => {
    const res = await handleRequest(
      new Request("http://fd.local/ingest", { method: "GET" }),
      cfg,
    );
    expect(res.status).toBe(405);
  });

  test("unknown path → 404", async () => {
    const res = await handleRequest(
      new Request("http://fd.local/nope", { method: "GET" }),
      cfg,
    );
    expect(res.status).toBe(404);
  });

  test("log file only created on first append", async () => {
    expect(existsSync(join(dir, "events.jsonl"))).toBe(false);
    await handleRequest(ingestReq(validEvent, TOKEN), cfg);
    expect(existsSync(join(dir, "events.jsonl"))).toBe(true);
  });
});
