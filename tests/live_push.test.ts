// S3.1 / #868 — SSE live push (R-11).
//
// The console updates live: every ingest broadcasts a freshly-rendered board frame
// to connected clients, and a new client gets a snapshot immediately. Hermetic: each
// test uses a per-test temp log (mkdtempSync) + an in-memory view db; no shared env.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FlightDeckEvent } from "../src/events/contract.ts";
import { EventLog } from "../src/log.ts";
import { handleRequest, type ServerConfig } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { UiHub } from "../src/ui/page.ts";

let dir: string;
let store: Store;

function ev(e: Partial<FlightDeckEvent> & { kind: FlightDeckEvent["kind"]; activityId: string; ts: string }): FlightDeckEvent {
  return e as FlightDeckEvent;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fd-sse-"));
  store = new Store({ log: new EventLog(join(dir, "events.jsonl")), dbPath: ":memory:" });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("UiHub board frames", () => {
  test("boardFrame is a well-formed SSE frame carrying the rendered board", () => {
    store.append(ev({ kind: "activity_start", activityId: "camp1", ts: "2026-07-07T10:00:00Z", activityType: "campaign", label: "Blueshift", detail: { planTotal: 5 } }));
    const hub = new UiHub(store);
    const frame = hub.boardFrame("board");
    expect(frame).toStartWith("event: board\ndata: ");
    expect(frame).toEndWith("\n\n");
    const payload = JSON.parse(frame.slice(frame.indexOf("data: ") + 6, frame.length - 2)) as { board: string };
    expect(payload.board).toContain("Blueshift");
    expect(payload.board).toContain("fd-card");
  });

  test("a new client gets a hello flush then a snapshot frame; broadcast pushes updates", async () => {
    store.append(ev({ kind: "activity_start", activityId: "camp1", ts: "2026-07-07T10:00:00Z", activityType: "campaign", label: "Blueshift", detail: { planTotal: 5 } }));
    const hub = new UiHub(store);

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    hub.addClient(writer);
    expect(hub.clients.size).toBe(1);

    const reader = readable.getReader();
    const dec = new TextDecoder();
    const hello = dec.decode((await reader.read()).value);
    expect(hello).toContain(": hello");
    const snapshot = dec.decode((await reader.read()).value);
    expect(snapshot).toStartWith("event: snapshot\ndata: ");
    expect(snapshot).toContain("Blueshift");

    // A second activity ingested + broadcast → the next frame reflects it.
    store.append(ev({ kind: "activity_start", activityId: "float1", ts: "2026-07-07T10:01:00Z", activityType: "float", label: "Reseed", detail: { cord: 12 } }));
    hub.broadcast();
    const live = dec.decode((await reader.read()).value);
    expect(live).toStartWith("event: board\ndata: ");
    expect(live).toContain("Reseed");
    expect(live).toContain("Blueshift");
  });

  test("broadcast to a dead client drops it from the set", async () => {
    const hub = new UiHub(store);
    // A stub writer whose write() rejects — models a disconnected client without the
    // real-stream backpressure that would hang an unread TransformStream.
    const dead = {
      write: () => Promise.reject(new Error("dead client")),
      close: () => Promise.resolve(),
    } as unknown as WritableStreamDefaultWriter<Uint8Array>;
    hub.clients.add(dead);
    expect(hub.clients.size).toBe(1);
    hub.broadcast();
    // give the failed write a microtask/tick to reject and prune.
    await new Promise((r) => setTimeout(r, 5));
    expect(hub.clients.size).toBe(0);
  });
});

describe("server UI routes (only when a UiHub is configured)", () => {
  function cfg(ui?: UiHub, onEvent?: (e: FlightDeckEvent) => void): ServerConfig {
    return { port: 0, token: "secret", sink: store, ui, onEvent };
  }

  test("GET / serves the console HTML page", async () => {
    const hub = new UiHub(store);
    const res = await handleRequest(new Request("http://x/"), cfg(hub));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("<title>FlightDeck</title>");
    expect(body).toContain("EventSource('/events')");
  });

  test("GET /events opens an SSE stream", async () => {
    const hub = new UiHub(store);
    const res = await handleRequest(new Request("http://x/events"), cfg(hub));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
  });

  test("without a UiHub the UI routes 404 (ingest-only P2 service)", async () => {
    const res = await handleRequest(new Request("http://x/"), cfg(undefined));
    expect(res.status).toBe(404);
  });

  test("a valid ingest fires the onEvent broadcast hook", async () => {
    const hub = new UiHub(store);
    let fired: FlightDeckEvent | null = null;
    const res = await handleRequest(
      new Request("http://x/ingest", {
        method: "POST",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        body: JSON.stringify(ev({ kind: "activity_start", activityId: "camp9", ts: "2026-07-07T10:00:00Z", activityType: "campaign", detail: { planTotal: 2 } })),
      }),
      cfg(hub, (e) => {
        fired = e;
      }),
    );
    expect(res.status).toBe(202);
    expect(fired).not.toBeNull();
    expect((fired as unknown as FlightDeckEvent).activityId).toBe("camp9");
  });
});
