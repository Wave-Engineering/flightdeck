// flightdeck#25 — a fold-since watermark excludes pre-fix garbage from the
// materialized view without touching the append-only log. The log stays the
// complete, untouched source of truth; only the projection is bounded, and
// bounding it is reversible (lower the watermark, or unset it, and everything
// that was excluded reappears exactly as it was — nothing was ever deleted).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FlightDeckEvent } from "../src/events/contract.ts";
import { EventLog } from "../src/log.ts";
import { Store } from "../src/store.ts";

const OLD: FlightDeckEvent = {
  kind: "activity_start",
  activityId: "pre-fix-1",
  ts: "2026-01-01T00:00:00.000Z",
  activityType: "campaign",
  label: "Old broken card",
  detail: { planTotal: 1 },
};
const NEW: FlightDeckEvent = {
  kind: "activity_start",
  activityId: "post-fix-1",
  ts: "2026-06-01T00:00:00.000Z",
  activityType: "campaign",
  label: "New correct card",
  detail: { planTotal: 1 },
};
const WATERMARK = "2026-03-01T00:00:00.000Z"; // between OLD and NEW

let dir: string;
let logPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "flightdeck-fold-since-"));
  logPath = join(dir, "events.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("fold-since watermark (flightdeck#25)", () => {
  test("no watermark set: both events render, unchanged behavior", () => {
    const store = new Store({ log: new EventLog(logPath), dbPath: ":memory:" });
    store.append(OLD);
    store.append(NEW);
    const ids = store.getView().map((v) => v.activityId).sort();
    expect(ids).toEqual(["post-fix-1", "pre-fix-1"]);
    store.close();
  });

  test("an event before the watermark is excluded from the view on append", () => {
    const store = new Store({ log: new EventLog(logPath), dbPath: ":memory:", foldSince: WATERMARK });
    store.append(OLD);
    store.append(NEW);
    const ids = store.getView().map((v) => v.activityId);
    expect(ids).toEqual(["post-fix-1"]);
    expect(store.getActivity("pre-fix-1")).toBeNull();
    store.close();
  });

  test("the log itself is untouched — the excluded event is still on disk", () => {
    const store = new Store({ log: new EventLog(logPath), dbPath: ":memory:", foldSince: WATERMARK });
    store.append(OLD);
    store.append(NEW);
    store.close();

    // A fresh, unwatermarked read of the log proves nothing was deleted.
    const raw = new EventLog(logPath).readAll();
    expect(raw.map((e) => e.activityId).sort()).toEqual(["post-fix-1", "pre-fix-1"]);
  });

  test("rebuild() re-applies the watermark — excluded events don't reappear", () => {
    const store = new Store({ log: new EventLog(logPath), dbPath: ":memory:", foldSince: WATERMARK });
    store.append(OLD);
    store.append(NEW);
    store.rebuild();
    const ids = store.getView().map((v) => v.activityId);
    expect(ids).toEqual(["post-fix-1"]);
    store.close();
  });

  test("lowering the watermark on a fresh boot brings an excluded event back", () => {
    // Write both events under a watermark that excludes OLD, close, then boot a
    // NEW store (same log, no watermark) — proves the exclusion is reversible
    // and never touched the log, not merely that this one process forgot about it.
    const writer = new Store({ log: new EventLog(logPath), dbPath: ":memory:", foldSince: WATERMARK });
    writer.append(OLD);
    writer.append(NEW);
    writer.close();

    const reread = new Store({ log: new EventLog(logPath), dbPath: ":memory:" });
    const ids = reread.getView().map((v) => v.activityId).sort();
    expect(ids).toEqual(["post-fix-1", "pre-fix-1"]);
    reread.close();
  });

  test("an event exactly AT the watermark is included (inclusive boundary)", () => {
    const atWatermark: FlightDeckEvent = { ...OLD, activityId: "at-watermark-1", ts: WATERMARK };
    const store = new Store({ log: new EventLog(logPath), dbPath: ":memory:", foldSince: WATERMARK });
    store.append(atWatermark);
    expect(store.getActivity("at-watermark-1")).not.toBeNull();
    store.close();
  });

  test("watermarked rebuild() ≡ watermarked live view (R-09 holds under a watermark)", () => {
    // The repo's load-bearing invariant (tests/rebuild.test.ts) extended to the
    // watermarked case — this is what would catch a future incremental
    // optimization on either the append or rebuild path disagreeing about which
    // events survive the filter.
    const store = new Store({ log: new EventLog(logPath), dbPath: ":memory:", foldSince: WATERMARK });
    store.append(OLD);
    store.append(NEW);
    const live = store.getView();
    store.rebuild();
    expect(store.getView()).toEqual(live);
    store.close();
  });

  test("a watermark landing after a live activity's head degrades it, not deletes it", () => {
    // Code review: deploy/README.md's caution made concrete. Excluding an
    // activity_start does not remove the card — it degrades to headless, per
    // fold.ts's own "no declared type" default, same as never having a head at
    // all. This pins the trade-off as an executable statement, not just prose.
    const started: FlightDeckEvent = {
      kind: "activity_start",
      activityId: "mid-campaign-1",
      ts: "2026-01-01T00:00:00Z", // before the watermark below — gets excluded
      activityType: "campaign",
      label: "Live campaign",
      detail: { planTotal: 3 },
    };
    const step: FlightDeckEvent = {
      kind: "step",
      activityId: "mid-campaign-1",
      ts: "2026-02-01T00:00:00Z", // after the watermark — survives
      label: "promoted",
      wave: "W1",
    };
    const midCampaignWatermark = "2026-01-15T00:00:00Z"; // between started and step

    const store = new Store({ log: new EventLog(logPath), dbPath: ":memory:", foldSince: midCampaignWatermark });
    store.append(started);
    store.append(step);

    const view = store.getActivity("mid-campaign-1");
    expect(view).not.toBeNull();
    // The card survives (the "step" event is enough for foldActivity to produce
    // a view row) but degrades exactly as the README warns: no declared type,
    // no label, no plan total — the head event that carried them was excluded.
    expect(view?.activityType).toBe("headless");
    expect(view?.label).toBeNull();
    expect(view?.planTotal).toBeNull();
    store.close();
  });

  test("mixed timestamp precision (real emitter shape vs a fractional-second watermark) compares safely", () => {
    // The real emitter (cc-workflow wave_status now_iso()) never emits fractional
    // seconds — only "%Y-%m-%dT%H:%M:%SZ". An operator might still paste a
    // fractional-second watermark (this repo's own earlier example did). Pin
    // that the mixture is safe at the boundary: a real-shape event at exactly
    // the watermark's second is INCLUDED (lexically >= a watermark with ".000").
    const realShapeEvent: FlightDeckEvent = {
      kind: "activity_start",
      activityId: "real-shape-1",
      ts: "2026-03-01T00:00:00Z", // no fractional seconds — the real emitter's shape
      activityType: "campaign",
      label: "Real shape",
      detail: { planTotal: 1 },
    };
    const fractionalWatermark = "2026-03-01T00:00:00.000Z";
    const store = new Store({ log: new EventLog(logPath), dbPath: ":memory:", foldSince: fractionalWatermark });
    store.append(realShapeEvent);
    // "2026-03-01T00:00:00Z" > "2026-03-01T00:00:00.000Z" lexically — 'Z'
    // (0x5A) sorts after '.' (0x2E), so a Z-suffixed real-shape event at the
    // SAME wall-clock second as a ".000Z" watermark sorts as strictly LATER
    // and is therefore INCLUDED, not excluded. Verified with node directly
    // before writing this assertion — the direction is easy to get backwards
    // by eye. Pinned here so a future change to either format doesn't
    // silently flip it without a test noticing.
    expect(store.getActivity("real-shape-1")).not.toBeNull();
    store.close();
  });
});
