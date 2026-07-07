// S3.3 / #867 — global concern queue (centerpiece). R-20 (global + scope links),
// R-21 (stalled-with-open-concerns sorts to top).

import { describe, expect, test } from "bun:test";

import type { FlightDeckEvent } from "../src/events/contract.ts";
import { foldActivity } from "../src/fold.ts";
import type { ActivityView } from "../src/fold.ts";
import {
  buildConcernQueue,
  renderConcernQueue,
  scopeHref,
  scopeLabel,
} from "../src/ui/concern_queue.ts";

function ev(e: Partial<FlightDeckEvent> & { kind: FlightDeckEvent["kind"]; activityId: string; ts: string }): FlightDeckEvent {
  return e as FlightDeckEvent;
}

// Activity A: BLOCKED (stalled) with two concerns.
function viewA(): ActivityView {
  return foldActivity([
    ev({ kind: "activity_start", activityId: "A", ts: "2026-07-07T10:00:00Z", activityType: "campaign", label: "Blueshift", detail: { planTotal: 7 } }),
    ev({ kind: "concern", activityId: "A", ts: "2026-07-07T10:05:00Z", concernKind: "gate-override", source: "coded", phase: "3", wave: "3.1", flight: 2, agent: "marlor", logRef: "log/A#42", label: "skipped trust gate" }),
    ev({ kind: "concern", activityId: "A", ts: "2026-07-07T10:20:00Z", concernKind: "self-approval", source: "coded", phase: "3", wave: "3.2", logRef: "log/A#77", label: "self-approved MR" }),
    ev({ kind: "blocked_on_human", activityId: "A", ts: "2026-07-07T10:25:00Z" }),
  ]);
}

// Activity B: ACTIVE (not stalled) with one, more-recent concern.
function viewB(): ActivityView {
  return foldActivity([
    ev({ kind: "activity_start", activityId: "B", ts: "2026-07-07T09:00:00Z", activityType: "float", label: "Reseed", detail: { cord: 12 } }),
    ev({ kind: "step", activityId: "B", ts: "2026-07-07T09:10:00Z", label: "leg", detail: { leg: 1 } }),
    ev({ kind: "concern", activityId: "B", ts: "2026-07-07T11:00:00Z", concernKind: "workaround", source: "declared", flight: 1, logRef: "log/B#3", label: "hardcoded stub" }),
  ]);
}

describe("global aggregation (R-20)", () => {
  test("concerns from every activity fold into one queue", () => {
    const q = buildConcernQueue([viewA(), viewB()]);
    expect(q.length).toBe(3); // 2 from A + 1 from B
    const ids = new Set(q.map((e) => e.activityId));
    expect(ids.has("A")).toBe(true);
    expect(ids.has("B")).toBe(true);
  });

  test("each entry links to its exact Phase/Wave/Flight scope + logRef", () => {
    const q = buildConcernQueue([viewA()]);
    const gate = q.find((e) => e.concern.concernKind === "gate-override");
    expect(gate).toBeDefined();
    const href = scopeHref(gate!);
    expect(href).toContain("activityId=A");
    expect(href).toContain("phase=3");
    expect(href).toContain("wave=3.1");
    expect(href).toContain("flight=2");
    expect(href).toContain("logRef=log%2FA%2342"); // "log/A#42" url-encoded
    // float scope renders "Leg", campaign scope renders "Flight"
    expect(scopeLabel(gate!)).toContain("Flight 2");
  });

  test("a float concern labels its scope as a Leg", () => {
    const q = buildConcernQueue([viewB()]);
    expect(scopeLabel(q[0]!)).toContain("Leg 1");
  });
});

describe("stalled-with-open-concerns sorts to the top (R-21)", () => {
  test("A (blocked, has concerns) sorts above B (active), despite B's concern being newer", () => {
    const q = buildConcernQueue([viewB(), viewA()]); // pass B first on purpose
    // first two entries belong to the stalled activity A
    expect(q[0]!.activityId).toBe("A");
    expect(q[1]!.activityId).toBe("A");
    expect(q[2]!.activityId).toBe("B");
    expect(q[0]!.stalled).toBe(true);
    expect(q[2]!.stalled).toBe(false);
  });

  test("within the same stall-state, most-recent concern first", () => {
    const q = buildConcernQueue([viewA()]);
    // A's two concerns: 10:20 (self-approval) before 10:05 (gate-override)
    expect(q[0]!.concern.concernKind).toBe("self-approval");
    expect(q[1]!.concern.concernKind).toBe("gate-override");
  });

  test("custom isStalled predicate can inject P4 wall-clock staleness", () => {
    const q = buildConcernQueue([viewB()], { isStalled: () => true });
    expect(q[0]!.stalled).toBe(true);
  });
});

describe("render", () => {
  test("renders rows with scope links; stalled rows carry the is-stalled marker", () => {
    const html = renderConcernQueue(buildConcernQueue([viewA(), viewB()]));
    expect(html).toContain("Concern queue");
    expect(html).toContain("fd-scope-link");
    expect(html).toContain("is-stalled");
    expect((html.match(/fd-concern-row/g) ?? []).length).toBe(3);
  });

  test("empty queue shows an explicit empty state", () => {
    expect(renderConcernQueue([])).toContain("no open concerns");
  });
});
