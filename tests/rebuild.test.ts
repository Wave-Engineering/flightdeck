// S2.2 / #866 — rebuild ≡ live (IT-05 / R-09). The load-bearing property: the
// materialized view is a pure projection of the log. Drop it, re-fold the whole
// log, and the result is byte-identical to the live view.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FlightDeckEvent } from "../src/events/contract.ts";
import { fold } from "../src/fold.ts";
import { EventLog } from "../src/log.ts";
import { Store } from "../src/store.ts";

// A mixed stream: a campaign (with concerns + a blocked leg) and a converging float.
const stream: FlightDeckEvent[] = [
  { kind: "activity_start", activityId: "camp-1", ts: "t00", activityType: "campaign", label: "C", detail: { planTotal: 4 } },
  { kind: "activity_start", activityId: "float-1", ts: "t01", activityType: "float", label: "F", detail: { cord: 12 } },
  { kind: "phase", activityId: "camp-1", ts: "t02", phase: "P1", action: "planning" },
  { kind: "step", activityId: "camp-1", ts: "t03", label: "promoted", wave: "W1" },
  { kind: "step", activityId: "float-1", ts: "t04", label: "leg", detail: { leg: 1 } },
  { kind: "metric", activityId: "float-1", ts: "t05", metric: "findings-velocity", value: 3 },
  { kind: "concern", activityId: "camp-1", ts: "t06", concernKind: "self-approval", source: "coded", wave: "W1" },
  { kind: "step", activityId: "camp-1", ts: "t07", label: "promoted", wave: "W2" },
  { kind: "metric", activityId: "camp-1", ts: "t08", metric: "tokens", value: null },
  { kind: "ci_wait", activityId: "camp-1", ts: "t09", action: "waiting-ci" },
  { kind: "step", activityId: "float-1", ts: "t10", label: "leg", detail: { leg: 2 } },
  { kind: "metric", activityId: "float-1", ts: "t11", metric: "findings-velocity", value: 0 },
  { kind: "activity_end", activityId: "float-1", ts: "t12" },
];

let dir: string;
let logPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "flightdeck-rebuild-"));
  logPath = join(dir, "events.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function liveStore(): Store {
  const store = new Store({ log: new EventLog(logPath), dbPath: ":memory:" });
  for (const e of stream) store.append(e);
  return store;
}

describe("rebuild ≡ live", () => {
  test("dropping the view and re-folding the log reproduces the live view", () => {
    const store = liveStore();
    const live = store.getView();
    store.rebuild();
    const rebuilt = store.getView();
    expect(rebuilt).toEqual(live);
    store.close();
  });

  test("a brand-new store hydrating from the same log matches the live view", () => {
    const store = liveStore();
    const live = store.getView();
    // Fresh store, fresh (empty) in-memory db, same on-disk log → view built on boot.
    const fresh = new Store({ log: new EventLog(logPath), dbPath: ":memory:" });
    expect(fresh.getView()).toEqual(live);
    store.close();
    fresh.close();
  });

  test("the SQLite view equals a pure fold() of the log", () => {
    const store = liveStore();
    const pure = [...fold(new EventLog(logPath).readAll()).values()].sort((a, b) =>
      a.activityId.localeCompare(b.activityId),
    );
    expect(store.getView()).toEqual(pure);
    store.close();
  });

  test("appends after a rebuild stay consistent", () => {
    const store = liveStore();
    store.rebuild();
    store.append({ kind: "step", activityId: "camp-1", ts: "t13", label: "promoted", wave: "W3" });
    const afterAppend = store.getView();
    store.rebuild();
    expect(store.getView()).toEqual(afterAppend);
    expect(store.getActivity("camp-1")?.completed).toBe(3);
    store.close();
  });
});

describe("derived state through the view", () => {
  test("float ended ⇒ closed; campaign in ci-wait; counts correct", () => {
    const store = liveStore();
    expect(store.getActivity("float-1")?.status).toBe("closed");
    expect(store.getActivity("float-1")?.legs).toBe(2);
    expect(store.getActivity("camp-1")?.status).toBe("ci-wait");
    expect(store.getActivity("camp-1")?.completed).toBe(2);
    expect(store.getActivity("camp-1")?.openConcerns).toBe(1);
    // honest token stub survived the round-trip through SQLite
    expect(store.getActivity("camp-1")?.metrics["tokens"]).toEqual({ value: null, unit: null, ts: "t08" });
    store.close();
  });
});
