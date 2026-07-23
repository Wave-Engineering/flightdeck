// #12 — concern-queue clear-all: a per-operator SEEN WATERMARK (dim, never delete).
// The queue is the audit centerpiece (R-20/R-21): no event is removed; the clear
// is client-side presentation state keyed off each row's data-ts.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FlightDeckEvent } from "../src/events/contract.ts";
import { foldActivity } from "../src/fold.ts";
import { EventLog } from "../src/log.ts";
import { Store } from "../src/store.ts";
import { buildConcernQueue, renderConcernQueue } from "../src/ui/concern_queue.ts";
import { renderPage } from "../src/ui/page.ts";

function ev(
  e: Partial<FlightDeckEvent> & { kind: FlightDeckEvent["kind"]; activityId: string; ts: string },
): FlightDeckEvent {
  return e as FlightDeckEvent;
}

const stream: FlightDeckEvent[] = [
  ev({ kind: "activity_start", activityId: "c", ts: "2026-07-23T10:00:00Z", activityType: "campaign", label: "C" }),
  ev({ kind: "concern", activityId: "c", ts: "2026-07-23T10:05:00Z", concernKind: "workaround", source: "coded", label: "one" }),
  ev({ kind: "concern", activityId: "c", ts: "2026-07-23T10:07:00Z", concernKind: "self-approval", source: "declared", label: "two" }),
];

describe("queue markup (#12)", () => {
  test("rows carry data-ts with each concern's ts", () => {
    const html = renderConcernQueue(buildConcernQueue([foldActivity(stream)]));
    expect(html).toContain('data-ts="2026-07-23T10:05:00Z"');
    expect(html).toContain('data-ts="2026-07-23T10:07:00Z"');
  });

  test("non-empty queue carries the clear button; empty queue does not", () => {
    const html = renderConcernQueue(buildConcernQueue([foldActivity(stream)]));
    expect(html).toContain('data-action="clear-concerns"');
    expect(renderConcernQueue([])).not.toContain("clear-concerns");
  });

  test("server render never pre-marks rows seen — watermark is client-only", () => {
    const html = renderConcernQueue(buildConcernQueue([foldActivity(stream)]));
    expect(html).not.toContain("is-seen");
  });
});

describe("client script wiring (#12)", () => {
  // String pins (no DOM rig in this repo): the handler, the storage key, and the
  // re-apply inside the prefs path must all survive in the shipped client.
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "flightdeck-clear-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("page ships the clear handler + persistent watermark + swap re-apply", () => {
    const store = new Store({ log: new EventLog(join(dir, "e.jsonl")), dbPath: ":memory:" });
    const html = renderPage(store);
    store.close();
    expect(html).toContain("clear-concerns");
    expect(html).toContain("fd-concern-seen-watermark"); // localStorage key
    expect(html).toContain("applyConcernWatermark(); // re-dim after every SSE swap");
  });
});
