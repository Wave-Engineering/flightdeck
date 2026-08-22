// #31 / AX-2 — a headless activity (no event has ever declared a campaign/float
// type — whether because there was no activity_start at all, OR because there was
// one but it named no type) must not render as a phantom campaign, and the board
// must make the condition countable rather than indistinguishable from a normal
// card. See FLIGHTDECK_AXIOMS.md AX-2: "if it can return its happy answer when its
// input is empty, it is not a metric yet" — a lane with headless cards in it must
// say so.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FlightDeckEvent } from "../src/events/contract.ts";
import { EventLog } from "../src/log.ts";
import { Store } from "../src/store.ts";
import { renderBoard } from "../src/ui/page.ts";

function step(activityId: string, ts: string): FlightDeckEvent {
  return { kind: "step", activityId, ts, label: "some-step" } as FlightDeckEvent;
}

function ciWait(activityId: string, ts: string): FlightDeckEvent {
  return { kind: "ci_wait", activityId, ts, action: "waiting-ci" } as FlightDeckEvent;
}

// The ACTUAL live producer shape (cc-workflow src/wave_status/state.py:664):
// `_emit_event(root, "activity_start", wave=first_wave, label=plan_data.get("project"))`
// — a real activity_start, but with no `--activity-type`. This is the dominant
// #31 corpus (repo-named phantoms), distinct from a stream with no activity_start
// at all — both must classify headless, and the copy must not claim "no
// activity_start seen" for this one (that was code review finding #1).
function bareActivityStart(activityId: string, ts: string): FlightDeckEvent {
  return { kind: "activity_start", activityId, ts, label: activityId } as FlightDeckEvent;
}

describe("the board tallies headless activities per lane (#31, AX-2)", () => {
  let dir: string;
  let store: Store;
  const NOW = Date.parse("2026-08-22T10:10:00Z");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "flightdeck-headless-"));
    store = new Store({ log: new EventLog(join(dir, "events.jsonl")), dbPath: ":memory:" });
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("the tally equals the number of activities with no declared type, on a mixed fixture", () => {
    // Mirrors the live #31 corpus: real campaigns alongside headless work streams.
    store.append({
      kind: "activity_start",
      activityId: "real-campaign",
      ts: "2026-08-22T10:00:00Z",
      activityType: "campaign",
      detail: { planTotal: 3 },
    } as FlightDeckEvent);
    store.append(ciWait("RTM-spike", "2026-08-22T10:01:00Z"));
    store.append(step("blueshift-quartermaster", "2026-08-22T10:02:00Z"));
    store.append(step("deep-blue", "2026-08-22T10:03:00Z"));

    const html = renderBoard(store, { now: NOW, staleMs: 15 * 60 * 1000 });
    expect(html).toContain("3 headless");
  });

  test("no tally is shown when every activity has a declared type", () => {
    store.append({
      kind: "activity_start",
      activityId: "real-campaign",
      ts: "2026-08-22T10:00:00Z",
      activityType: "campaign",
      detail: { planTotal: 3 },
    } as FlightDeckEvent);
    const html = renderBoard(store, { now: NOW, staleMs: 15 * 60 * 1000 });
    expect(html).toContain("real-campaign");
    expect(html).not.toContain("headless");
  });

  test("phantom campaigns from #31's live corpus no longer render as campaign cards", () => {
    // The five repo-named phantom ids from the issue's evidence table, reproduced
    // with the REAL producer shape: a bare activity_start (state.py:664), not a
    // headless stream of work events with no head at all. This is the case code
    // review finding #5 said the original fixture missed.
    for (const id of ["RTM-spike", "blueshift-quartermaster", "deep-blue", "ruthless", "flightdeck"]) {
      store.append(bareActivityStart(id, "2026-08-22T10:00:00Z"));
      store.append(ciWait(id, "2026-08-22T10:01:00Z"));
    }
    const html = renderBoard(store, { now: NOW, staleMs: 15 * 60 * 1000 });
    expect(html).not.toContain('data-type="campaign"');
    expect(html).toContain('data-type="headless"');
    expect(html).toContain("5 headless");
  });

  test("a bare activity_start with no activityType classifies headless too (not just a headless stream, #31 finding 1)", () => {
    store.append(bareActivityStart("deploy-smoke", "2026-08-22T10:00:00Z"));
    const html = renderBoard(store, { now: NOW, staleMs: 15 * 60 * 1000 });
    expect(html).toContain('data-type="headless"');
    expect(html).toContain("1 headless");
    // AX-1: the copy must not claim an activity_start was never seen — it WAS seen,
    // it just never named a type. The old wording made exactly this false claim.
    expect(html).not.toContain("no activity_start seen");
  });
});
