// S2.2 / #866 — rebuild ≡ live (IT-05 / R-09). The load-bearing property: the
// materialized view is a pure projection of the log. Drop it, re-fold the whole
// log, and the result is byte-identical to the live view.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FlightDeckEvent } from "../src/events/contract.ts";
import { type ActivityView, fold } from "../src/fold.ts";
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

  test("R-09 survives DUPLICATE promotions (#27)", () => {
    // The dedup added in #27 is fold-local — a Set inside foldActivity, not a
    // persisted field. That is only sound because BOTH paths hand the fold a
    // complete event group: the live path re-folds `eventsFor(activityId)` on
    // every append, and rebuild re-folds everything. If either ever became
    // incremental, the live view would count duplicates the rebuild suppressed
    // (or vice versa) and this test is what would notice.
    const dupStream: FlightDeckEvent[] = [
      { kind: "activity_start", activityId: "dup-1", ts: "t00", activityType: "campaign", label: "D", detail: { planTotal: 3 } },
      { kind: "step", activityId: "dup-1", ts: "t01", label: "promoted", wave: "W1" },
      { kind: "step", activityId: "dup-1", ts: "t02", label: "promoted", wave: "W2" },
      { kind: "step", activityId: "dup-1", ts: "t03", label: "promoted", wave: "W2" },
      { kind: "step", activityId: "dup-1", ts: "t04", label: "promoted", wave: "W2" },
      { kind: "step", activityId: "dup-1", ts: "t05", label: "promoted", wave: "W3" },
      { kind: "step", activityId: "dup-1", ts: "t06", label: "promoted", wave: "W3" },
    ];
    const store = new Store({ log: new EventLog(logPath), dbPath: ":memory:" });
    for (const e of dupStream) store.append(e);

    const live = store.getView();
    expect(live.find((v: ActivityView) => v.activityId === "dup-1")?.completed).toBe(3);

    store.rebuild();
    expect(store.getView()).toEqual(live);
    store.close();
  });

  test("a DUPLICATE appended after a rebuild does not double-count (#27)", () => {
    // The fold-local Set stakes its soundness on every caller re-folding the whole
    // group. The existing post-rebuild test appends a NEW wave; this appends a
    // duplicate of an already-counted one, which is the precise case where a
    // stale or partial fold would let live and rebuilt views disagree.
    const store = new Store({ log: new EventLog(logPath), dbPath: ":memory:" });
    store.append({ kind: "activity_start", activityId: "post-1", ts: "t00", activityType: "campaign", label: "P", detail: { planTotal: 2 } } as FlightDeckEvent);
    store.append({ kind: "step", activityId: "post-1", ts: "t01", label: "promoted", wave: "W1" } as FlightDeckEvent);
    store.rebuild();

    store.append({ kind: "step", activityId: "post-1", ts: "t02", label: "promoted", wave: "W1", phase: "Promote" } as FlightDeckEvent);
    const live = store.getView();
    expect(live.find((v: ActivityView) => v.activityId === "post-1")?.completed).toBe(1);

    store.rebuild();
    expect(store.getView()).toEqual(live);
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

describe("corrupt view self-heals from the log (file-backed, I1)", () => {
  // Populate the append-only log (source of truth) with the mixed stream, and
  // return the view a clean rebuild from that log should produce.
  function seedLogAndExpected(): ActivityView[] {
    const log = new EventLog(logPath);
    for (const e of stream) log.append(e);
    const clean = new Store({ log: new EventLog(logPath), dbPath: ":memory:" });
    const expected = clean.getView();
    clean.close();
    return expected;
  }

  test("a SQLite-corrupt db file is discarded and rebuilt from the log on boot", () => {
    const expected = seedLogAndExpected();

    // Corrupt the on-disk view: SQLite magic header then garbage → the file opens
    // (open is lazy) but fails on first page read ("file is not a database").
    const dbPath = join(dir, "view.db");
    const garbage = Buffer.alloc(4096);
    garbage.write("SQLite format 3\0", 0, "latin1");
    for (let i = 16; i < garbage.length; i++) garbage[i] = (i * 37) & 0xff;
    writeFileSync(dbPath, garbage);

    // Booting a Store on the corrupt file must NOT throw: it unlinks the bad file
    // and re-folds the whole log into a fresh db, recovering the correct view.
    const store = new Store({ log: new EventLog(logPath), dbPath });
    expect(store.getView()).toEqual(expected);
    store.close();

    // The bad bytes were truly replaced: the file is now a sound SQLite db that
    // opens without recovery (a raw read of sqlite_master no longer throws).
    const check = new Database(dbPath);
    expect(() => check.query("SELECT count(*) FROM sqlite_master").get()).not.toThrow();
    check.close();
  });

  test("pure-garbage (non-database) view file also self-heals", () => {
    const expected = seedLogAndExpected();
    const dbPath = join(dir, "view2.db");
    writeFileSync(dbPath, "not a sqlite database — total garbage\x00\x01\x02".repeat(64));

    const store = new Store({ log: new EventLog(logPath), dbPath });
    expect(store.getView()).toEqual(expected);
    store.close();
  });

  test("a lost/empty (never-created) view file rebuilds from the log", () => {
    const expected = seedLogAndExpected();
    const dbPath = join(dir, "fresh.db"); // does not exist yet
    const store = new Store({ log: new EventLog(logPath), dbPath });
    expect(store.getView()).toEqual(expected);
    store.close();
  });
});
