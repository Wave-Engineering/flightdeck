// S3.5 / #870 — scoped log viewer: resolve logRef + filter transcript by scope (R-15).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FlightDeckEvent } from "../src/events/contract.ts";
import { EventLog } from "../src/log.ts";
import { handleRequest, type ServerConfig } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { UiHub } from "../src/ui/page.ts";
import {
  filterByScope,
  parseScope,
  renderLogViewer,
  resolveLogRef,
} from "../src/ui/log_viewer.ts";

function ev(e: Partial<FlightDeckEvent> & { kind: FlightDeckEvent["kind"]; activityId: string; ts: string }): FlightDeckEvent {
  return e as FlightDeckEvent;
}

const EVENTS: FlightDeckEvent[] = [
  ev({ kind: "activity_start", activityId: "A", ts: "2026-07-07T10:00:00Z", activityType: "campaign", label: "Blueshift" }),
  ev({ kind: "step", activityId: "A", ts: "2026-07-07T10:05:00Z", label: "promoted", phase: "3", wave: "3.1", flight: 2 }),
  ev({ kind: "concern", activityId: "A", ts: "2026-07-07T10:06:00Z", concernKind: "gate-override", source: "coded", phase: "3", wave: "3.1", flight: 2, logRef: "log/A#42" }),
  ev({ kind: "step", activityId: "A", ts: "2026-07-07T10:20:00Z", label: "promoted", phase: "3", wave: "3.2" }),
  ev({ kind: "step", activityId: "B", ts: "2026-07-07T10:07:00Z", label: "promoted", phase: "3", wave: "3.1", agent: "marlor" }),
];

describe("filterByScope narrows the transcript (R-15)", () => {
  test("activity + wave narrows to just that scope", () => {
    const out = filterByScope(EVENTS, { activityId: "A", wave: "3.1" });
    expect(out.length).toBe(2); // A's step + concern at wave 3.1 (activity_start has no wave)
    expect(out.every((e) => e.activityId === "A" && e.wave === "3.1")).toBe(true);
  });

  test("wave alone spans activities (global narrowing, not per-activity)", () => {
    const out = filterByScope(EVENTS, { wave: "3.1" });
    expect(out.length).toBe(3); // A step + A concern + B step
    expect(new Set(out.map((e) => e.activityId))).toEqual(new Set(["A", "B"]));
  });

  test("flight tag matches numeric event.flight against the string scope", () => {
    const out = filterByScope(EVENTS, { flight: "2" });
    expect(out.length).toBe(2);
    expect(out.every((e) => String(e.flight) === "2")).toBe(true);
  });

  test("empty scope returns the full transcript", () => {
    expect(filterByScope(EVENTS, {}).length).toBe(EVENTS.length);
  });
});

describe("resolveLogRef", () => {
  test("resolves a logRef to the exact event(s) carrying it", () => {
    const out = resolveLogRef(EVENTS, "log/A#42");
    expect(out.length).toBe(1);
    expect(out[0]!.kind).toBe("concern");
  });

  test("unknown logRef resolves to nothing", () => {
    expect(resolveLogRef(EVENTS, "log/none").length).toBe(0);
  });
});

describe("parseScope (concern-queue link target)", () => {
  test("reads the present tags, ignores absent ones", () => {
    const scope = parseScope(new URLSearchParams("activityId=A&wave=3.1&flight=2&logRef=log/A%2342"));
    expect(scope).toEqual({ activityId: "A", wave: "3.1", flight: "2" }); // logRef not part of LogScope
  });

  test("empty query → empty scope", () => {
    expect(parseScope(new URLSearchParams(""))).toEqual({});
  });
});

describe("renderLogViewer", () => {
  test("selecting a scope renders exactly the narrowed lines", () => {
    const html = renderLogViewer(EVENTS, { activityId: "A", wave: "3.1" });
    expect((html.match(/fd-log-line/g) ?? []).length).toBe(2);
    expect(html).toContain("Wave 3.1");
  });

  test("empty result renders an explicit empty state", () => {
    const html = renderLogViewer(EVENTS, { activityId: "nope" });
    expect(html).toContain("no events for this scope");
  });
});

describe("/log route (end-to-end scope click-through)", () => {
  let dir: string;
  let store: Store;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fd-log-"));
    store = new Store({ log: new EventLog(join(dir, "events.jsonl")), dbPath: ":memory:" });
    for (const e of EVENTS) store.append(e);
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function cfg(ui: UiHub): ServerConfig {
    return { port: 0, token: "secret", sink: store, ui };
  }

  test("GET /log?activityId=A&wave=3.1 serves the narrowed transcript", async () => {
    const res = await handleRequest(new Request("http://x/log?activityId=A&wave=3.1"), cfg(new UiHub(store)));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    // match the div (not the .fd-log-line CSS selector in the embedded stylesheet)
    expect((body.match(/<div class="fd-log-line"/g) ?? []).length).toBe(2);
    expect(body).toContain("Wave 3.1");
  });

  test("POST /log is rejected (405)", async () => {
    const res = await handleRequest(new Request("http://x/log", { method: "POST" }), cfg(new UiHub(store)));
    expect(res.status).toBe(405);
  });
});
