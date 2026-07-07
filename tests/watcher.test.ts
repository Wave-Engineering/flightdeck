// S4.1 / #873 — staleness watcher. R-22 (last event past threshold AND not terminal
// ⇒ idle-but-incomplete) + R-21 (stalled-with-open-concerns sorts to top) + the Idle
// lane wiring. Hermetic: injected clock + explicit threshold (never touches
// process.env), per-test temp log + :memory: view db.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FlightDeckEvent } from "../src/events/contract.ts";
import { type ActivityView, foldActivity } from "../src/fold.ts";
import { EventLog } from "../src/log.ts";
import { Store } from "../src/store.ts";
import { buildConcernQueue } from "../src/ui/concern_queue.ts";
import { renderBoard } from "../src/ui/page.ts";
import {
  DEFAULT_STALE_MS,
  ageMs,
  isStalled,
  isTerminal,
  resolveStaleMs,
  stalenessPredicate,
} from "../src/watcher.ts";

function ev(
  e: Partial<FlightDeckEvent> & { kind: FlightDeckEvent["kind"]; activityId: string; ts: string },
): FlightDeckEvent {
  return e as FlightDeckEvent;
}

const T0 = "2026-07-07T10:00:00Z";
const NOW = Date.parse(T0); // clock pinned to the activity's start for boundary math
const THRESHOLD = 15 * 60 * 1000; // 15 min

/** An open activity whose last event is at `lastTs`. */
function openView(lastTs: string): ActivityView {
  return foldActivity([
    ev({ kind: "activity_start", activityId: "a", ts: T0, activityType: "campaign", label: "Camp", detail: { planTotal: 5 } }),
    ev({ kind: "step", activityId: "a", ts: lastTs, label: "promoted", wave: "1" }),
  ]);
}

/** A terminal (closed) activity whose last event is `endTs`. */
function closedView(endTs: string): ActivityView {
  return foldActivity([
    ev({ kind: "activity_start", activityId: "z", ts: T0, activityType: "campaign", detail: { planTotal: 2 } }),
    ev({ kind: "activity_end", activityId: "z", ts: endTs }),
  ]);
}

describe("isStalled — threshold boundary (R-22)", () => {
  test("just under threshold ⇒ NOT stale", () => {
    const view = openView(T0); // last event at T0
    const now = NOW + THRESHOLD - 1; // 1 ms short of the threshold
    expect(isStalled(view, now, THRESHOLD)).toBe(false);
  });

  test("exactly at threshold ⇒ stale (inclusive boundary)", () => {
    const view = openView(T0);
    const now = NOW + THRESHOLD; // exactly the threshold
    expect(isStalled(view, now, THRESHOLD)).toBe(true);
  });

  test("well past threshold ⇒ stale", () => {
    const view = openView(T0);
    const now = NOW + THRESHOLD * 4;
    expect(isStalled(view, now, THRESHOLD)).toBe(true);
  });

  test("recent event ⇒ NOT stale even far past the activity start", () => {
    // last event only 1 min before now, though the activity started hours ago
    const recent = new Date(NOW + THRESHOLD * 10 - 60_000).toISOString();
    const view = openView(recent);
    expect(isStalled(view, NOW + THRESHOLD * 10, THRESHOLD)).toBe(false);
  });
});

describe("isStalled — terminal state excluded (R-22)", () => {
  test("a closed activity is NEVER stale, however old its last event", () => {
    const view = closedView(T0);
    expect(isTerminal(view)).toBe(true);
    expect(isStalled(view, NOW + THRESHOLD * 100, THRESHOLD)).toBe(false);
  });

  test("blocked / ci-wait are NOT terminal ⇒ can go stale", () => {
    const blocked = foldActivity([
      ev({ kind: "activity_start", activityId: "b", ts: T0, activityType: "campaign", detail: { planTotal: 3 } }),
      ev({ kind: "blocked_on_human", activityId: "b", ts: T0 }),
    ]);
    expect(isTerminal(blocked)).toBe(false);
    expect(isStalled(blocked, NOW + THRESHOLD + 1, THRESHOLD)).toBe(true);
  });
});

describe("ageMs / resolveStaleMs helpers", () => {
  test("ageMs = now - lastEventTs; null when no parseable timestamp", () => {
    expect(ageMs(openView(T0), NOW + 60_000)).toBe(60_000);
    const bogus = { lastEventTs: "not-a-date", startedAt: null } as unknown as ActivityView;
    expect(ageMs(bogus, NOW)).toBeNull();
  });

  test("resolveStaleMs falls back to the default when env is unset/blank/bad", () => {
    expect(resolveStaleMs({})).toBe(DEFAULT_STALE_MS);
    expect(resolveStaleMs({ FLIGHTDECK_STALE_MS: "" })).toBe(DEFAULT_STALE_MS);
    expect(resolveStaleMs({ FLIGHTDECK_STALE_MS: "nope" })).toBe(DEFAULT_STALE_MS);
    expect(resolveStaleMs({ FLIGHTDECK_STALE_MS: "0" })).toBe(DEFAULT_STALE_MS);
    expect(resolveStaleMs({ FLIGHTDECK_STALE_MS: "1000" })).toBe(1000);
  });
});

describe("stalenessPredicate feeds the concern queue (R-21)", () => {
  test("a stale activity with open concerns sorts to the top", () => {
    // A: open, last event old, has a concern. B: open, fresh, has a concern.
    const a = foldActivity([
      ev({ kind: "activity_start", activityId: "A", ts: T0, activityType: "campaign", label: "Old", detail: { planTotal: 4 } }),
      ev({ kind: "concern", activityId: "A", ts: T0, concernKind: "gate-override", source: "coded", label: "skipped gate" }),
    ]);
    const freshTs = new Date(NOW + THRESHOLD * 5 - 60_000).toISOString();
    const b = foldActivity([
      ev({ kind: "activity_start", activityId: "B", ts: freshTs, activityType: "float", label: "Fresh", detail: { cord: 8 } }),
      ev({ kind: "concern", activityId: "B", ts: freshTs, concernKind: "workaround", source: "declared", label: "stub" }),
    ]);
    const now = NOW + THRESHOLD * 5;
    const q = buildConcernQueue([b, a], { isStalled: stalenessPredicate(now, THRESHOLD) });
    expect(q[0]!.activityId).toBe("A"); // stale-with-concern to the top
    expect(q[0]!.stalled).toBe(true);
    expect(q.find((e) => e.activityId === "B")!.stalled).toBe(false);
  });
});

describe("Idle lane wiring (renderBoard)", () => {
  let dir: string;
  let store: Store;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fd-watcher-"));
    store = new Store({ log: new EventLog(join(dir, "events.jsonl")), dbPath: ":memory:" });
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a stale-but-open activity lights the Idle lane; a fresh one stays Active", () => {
    // stale: last event at T0. fresh: last event 1 min before now.
    const now = NOW + THRESHOLD * 3;
    const freshTs = new Date(now - 60_000).toISOString();
    store.append(ev({ kind: "activity_start", activityId: "stale1", ts: T0, activityType: "campaign", label: "Stale", detail: { planTotal: 3 } }));
    store.append(ev({ kind: "activity_start", activityId: "fresh1", ts: freshTs, activityType: "campaign", label: "Fresh", detail: { planTotal: 3 } }));

    const board = renderBoard(store, { now, staleMs: THRESHOLD });
    // Idle lane present (stale-but-open), defaulting to table layout (R-13).
    expect(board).toContain('data-lane="idle" data-layout="table"');
    expect(board).toContain('data-lane="active" data-layout="cards"');
    // No Idle lane at all when the clock is early enough that neither is stale
    // (stale1's T0 event is only 1 min old; fresh1's event is still in the future).
    const early = renderBoard(store, { now: NOW + 60_000, staleMs: THRESHOLD });
    expect(early).not.toContain('data-lane="idle"');
  });

  test("a closed activity never goes to Idle even when ancient", () => {
    store.append(ev({ kind: "activity_start", activityId: "c1", ts: T0, activityType: "campaign", detail: { planTotal: 2 } }));
    store.append(ev({ kind: "activity_end", activityId: "c1", ts: T0 }));
    const board = renderBoard(store, { now: NOW + THRESHOLD * 100, staleMs: THRESHOLD });
    expect(board).toContain('data-lane="closed"');
    expect(board).not.toContain('data-lane="idle"');
  });
});
