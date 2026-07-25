// S2.2 / #866 — deterministic fold (IT-04). Canned streams → expected card state.

import { describe, expect, test } from "bun:test";

import type { FlightDeckEvent } from "../src/events/contract.ts";
import { fold, foldActivity } from "../src/fold.ts";

// A canned campaign stream: start (planTotal 5) → planning phase → two promoted
// waves → a coded concern → a confidence metric → blocked on the human.
const campaign: FlightDeckEvent[] = [
  {
    kind: "activity_start",
    activityId: "camp-1",
    ts: "2026-07-07T10:00:00Z",
    activityType: "campaign",
    label: "Blueshift #56",
    detail: { planTotal: 5 },
  },
  { kind: "phase", activityId: "camp-1", ts: "2026-07-07T10:01:00Z", phase: "P1", action: "planning" },
  { kind: "step", activityId: "camp-1", ts: "2026-07-07T10:10:00Z", label: "promoted", wave: "W1" },
  { kind: "step", activityId: "camp-1", ts: "2026-07-07T10:20:00Z", label: "promoted", wave: "W2" },
  {
    kind: "concern",
    activityId: "camp-1",
    ts: "2026-07-07T10:21:00Z",
    concernKind: "gate-override",
    source: "coded",
    wave: "W2",
    logRef: "log://camp-1/W2",
  },
  { kind: "metric", activityId: "camp-1", ts: "2026-07-07T10:22:00Z", metric: "confidence", value: 0.9 },
  { kind: "blocked_on_human", activityId: "camp-1", ts: "2026-07-07T10:25:00Z", action: "waiting-on-meatbag" },
];

describe("foldActivity — campaign", () => {
  const v = foldActivity(campaign);

  test("identity + type + label", () => {
    expect(v.activityId).toBe("camp-1");
    expect(v.activityType).toBe("campaign");
    // last non-empty label wins; here it is the start label (later events carry none).
    expect(v.label).toBe("Blueshift #56");
  });

  test("progress: planTotal + completed waves", () => {
    expect(v.planTotal).toBe(5);
    expect(v.completed).toBe(2);
  });

  test("scope: last-write-wins wave", () => {
    expect(v.currentWave).toBe("W2");
    expect(v.currentPhase).toBe("P1");
  });

  test("status derived from last state-bearing event", () => {
    expect(v.status).toBe("blocked");
  });

  test("currentAction latches the last ACTIVE-lane action; block/ci actions don't (AC3, cc#1026)", () => {
    // The only active-lane (step/phase) action in the stream is the "planning" phase;
    // the trailing blocked_on_human ("waiting-on-meatbag") owns the lifecycle status
    // instead, so it must NOT latch into currentAction (that would show a block action
    // on a card that later re-activates). Metrics/concerns carry no action either.
    expect(v.currentAction).toBe("planning");
    expect(v.status).toBe("blocked");
  });

  test("a re-activated card shows the last active action, not a stale block (AC3, cc#1026)", () => {
    // promoting (active) → hold (block) → action-less promoted step re-activates the card.
    // status returns to active; currentAction must still read "promoting", never "hold".
    const w = foldActivity([
      { kind: "activity_start", activityId: "s", ts: "2026-07-07T10:00:00Z", activityType: "campaign", detail: { planTotal: 3 } },
      { kind: "step", activityId: "s", ts: "2026-07-07T10:01:00Z", action: "promoting", wave: "1" },
      { kind: "blocked_on_human", activityId: "s", ts: "2026-07-07T10:02:00Z", action: "hold" },
      { kind: "step", activityId: "s", ts: "2026-07-07T10:03:00Z", label: "promoted", wave: "1" },
    ] as FlightDeckEvent[]);
    expect(w.status).toBe("active");
    expect(w.currentAction).toBe("promoting");
  });

  test("currentAction is null when no event carries an active-lane action (AC3, cc#1026)", () => {
    const bare = foldActivity([
      { kind: "activity_start", activityId: "x", ts: "2026-07-07T10:00:00Z", activityType: "campaign", detail: { planTotal: 3 } },
      { kind: "step", activityId: "x", ts: "2026-07-07T10:05:00Z", label: "promoted", wave: "1" },
    ] as FlightDeckEvent[]);
    expect(bare.currentAction).toBeNull();
  });

  test("timestamps", () => {
    expect(v.startedAt).toBe("2026-07-07T10:00:00Z");
    expect(v.endedAt).toBeNull();
    expect(v.lastEventTs).toBe("2026-07-07T10:25:00Z");
    expect(v.eventCount).toBe(7);
  });

  test("concerns collected with scope + logRef", () => {
    expect(v.concerns).toHaveLength(1);
    expect(v.openConcerns).toBe(1);
    expect(v.concerns[0]).toMatchObject({
      concernKind: "gate-override",
      source: "coded",
      logRef: "log://camp-1/W2",
      scope: { wave: "W2" },
    });
  });

  test("metrics: latest value by name", () => {
    expect(v.metrics["confidence"]).toMatchObject({ value: 0.9 });
  });
});

describe("foldActivity — status + determinism", () => {
  test("activity_end ⇒ closed (the single 'closed' code path)", () => {
    const closed = foldActivity([
      ...campaign,
      { kind: "activity_end", activityId: "camp-1", ts: "2026-07-07T11:00:00Z" },
    ]);
    expect(closed.status).toBe("closed");
    expect(closed.endedAt).toBe("2026-07-07T11:00:00Z");
  });

  test("ci_wait last ⇒ ci-wait status", () => {
    const v = foldActivity([
      { kind: "activity_start", activityId: "c", ts: "t0", activityType: "campaign" },
      { kind: "ci_wait", activityId: "c", ts: "t1", action: "waiting-ci" },
    ]);
    expect(v.status).toBe("ci-wait");
  });

  test("fold is deterministic (same input ⇒ deep-equal output)", () => {
    expect(foldActivity(campaign)).toEqual(foldActivity(campaign));
    expect(JSON.stringify(foldActivity(campaign))).toBe(JSON.stringify(foldActivity(campaign)));
  });
});

describe("foldActivity — float", () => {
  const float: FlightDeckEvent[] = [
    {
      kind: "activity_start",
      activityId: "float-9",
      ts: "2026-07-07T09:00:00Z",
      activityType: "float",
      detail: { cord: 12 },
    },
    { kind: "step", activityId: "float-9", ts: "2026-07-07T09:05:00Z", label: "leg", detail: { leg: 1 } },
    { kind: "metric", activityId: "float-9", ts: "2026-07-07T09:05:30Z", metric: "findings-velocity", value: 4 },
    { kind: "step", activityId: "float-9", ts: "2026-07-07T09:10:00Z", label: "leg", detail: { leg: 2 } },
    { kind: "metric", activityId: "float-9", ts: "2026-07-07T09:10:30Z", metric: "findings-velocity", value: 1 },
    { kind: "step", activityId: "float-9", ts: "2026-07-07T09:15:00Z", label: "leg", detail: { leg: 3 } },
    { kind: "metric", activityId: "float-9", ts: "2026-07-07T09:15:30Z", metric: "findings-velocity", value: 0 },
  ];
  const v = foldActivity(float);

  test("type + cord + legs", () => {
    expect(v.activityType).toBe("float");
    expect(v.cord).toBe(12);
    expect(v.legs).toBe(3);
  });

  test("findings-velocity trend retained in order", () => {
    expect(v.findingsVelocity).toEqual([4, 1, 0]);
  });

  test("no promoted waves ⇒ completed 0, status active", () => {
    expect(v.completed).toBe(0);
    expect(v.status).toBe("active");
  });
});

describe("foldActivity — session classification (#7 / cc-workflow#947)", () => {
  test("legacy shape: phase 'session' with no activityType classifies as session", () => {
    // EXACTLY the production shape flooding the deck (cc-workflow#947): the S1.7
    // hook emits phase:"session" and no activityType. Assertion-liveness probe
    // (#922): before the fix this folded to "campaign" (the default) — verified
    // failing against unmodified fold.ts before implementing.
    const v = foldActivity([
      { kind: "activity_start", activityId: "session:aaa", ts: "2026-07-22T10:00:00Z", phase: "session", agent: "malory", label: "session-open" },
      { kind: "step", activityId: "session:aaa", ts: "2026-07-22T10:05:00Z", phase: "session", agent: "malory", label: "session-idle" },
    ]);
    expect(v.activityType).toBe("session");
  });

  test("declared shape: activityType 'session' (new emitter) classifies as session", () => {
    const v = foldActivity([
      { kind: "activity_start", activityId: "session:bbb", ts: "2026-07-22T10:00:00Z", activityType: "session", phase: "session", agent: "babelfish", host: "malory", label: "session-open" },
    ]);
    expect(v.activityType).toBe("session");
  });

  test("orphan steps (no activity_start) with phase 'session' classify as session", () => {
    // A session opened before the emitter installed has steps but no start event.
    const v = foldActivity([
      { kind: "step", activityId: "session:ccc", ts: "2026-07-22T10:05:00Z", phase: "session", agent: "malory", label: "session-idle" },
    ]);
    expect(v.activityType).toBe("session");
  });

  test("campaign/float classification is unchanged by a non-session phase", () => {
    const v = foldActivity([
      { kind: "activity_start", activityId: "f", ts: "t0", activityType: "float", detail: { cord: 3 } },
      { kind: "phase", activityId: "f", ts: "t1", phase: "P1" },
    ]);
    expect(v.activityType).toBe("float");
  });

  test("host folds last-write-wins; absent host ⇒ null", () => {
    const v = foldActivity([
      { kind: "activity_start", activityId: "session:ddd", ts: "t0", activityType: "session", host: "malory" },
      { kind: "step", activityId: "session:ddd", ts: "t1", host: "sterling" },
    ]);
    expect(v.host).toBe("sterling");
    const bare = foldActivity([
      { kind: "activity_start", activityId: "c", ts: "t0", activityType: "campaign" },
    ]);
    expect(bare.host).toBeNull();
  });
});

describe("foldActivity — synthetic marker (#7)", () => {
  test("detail.synthetic true on any event marks the activity synthetic", () => {
    const v = foldActivity([
      { kind: "activity_start", activityId: "e2e-smoke", ts: "t0", activityType: "campaign", detail: { synthetic: true } },
      { kind: "step", activityId: "e2e-smoke", ts: "t1", label: "promoted", wave: "W1" },
    ]);
    expect(v.synthetic).toBe(true);
    // marker on a later event (not just activity_start) also marks it
    const late = foldActivity([
      { kind: "activity_start", activityId: "smoke-2", ts: "t0", activityType: "campaign" },
      { kind: "step", activityId: "smoke-2", ts: "t1", detail: { synthetic: true } },
    ]);
    expect(late.synthetic).toBe(true);
  });

  test("no marker ⇒ synthetic false (real activities unaffected)", () => {
    expect(foldActivity(campaign).synthetic).toBe(false);
  });
});

describe("foldActivity — honest token stub", () => {
  test("metric value null is preserved (never fabricated, #853 gate)", () => {
    const v = foldActivity([
      { kind: "activity_start", activityId: "c", ts: "t0", activityType: "campaign" },
      { kind: "metric", activityId: "c", ts: "t1", metric: "tokens", value: null },
    ]);
    expect(v.metrics["tokens"]).toEqual({ value: null, unit: null, ts: "t1" });
  });
});

describe("fold — multiple independent activities", () => {
  test("groups by activityId, folds each independently", () => {
    const mixed: FlightDeckEvent[] = [
      { kind: "activity_start", activityId: "a", ts: "t0", activityType: "campaign", detail: { planTotal: 3 } },
      { kind: "activity_start", activityId: "b", ts: "t0", activityType: "float", detail: { cord: 8 } },
      { kind: "step", activityId: "a", ts: "t1", label: "promoted", wave: "W1" },
      { kind: "step", activityId: "b", ts: "t1", label: "leg", detail: { leg: 1 } },
    ];
    const m = fold(mixed);
    expect(m.size).toBe(2);
    expect(m.get("a")?.completed).toBe(1);
    expect(m.get("a")?.legs).toBe(0);
    expect(m.get("b")?.legs).toBe(1);
    expect(m.get("b")?.completed).toBe(0);
  });
});
