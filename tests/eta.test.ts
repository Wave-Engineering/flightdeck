// S2.3 / #869 — metrics + split-ETA. Campaign burn-down narrows as steps land;
// machine-time and blocked-on-you are independent figures; float cord-band +
// converge/explore; honest null token stub.

import { describe, expect, test } from "bun:test";

import type { FlightDeckEvent } from "../src/events/contract.ts";
import { foldActivity } from "../src/fold.ts";
import { deriveMetrics } from "../src/metrics.ts";
import { computeEta, isConverging } from "../src/eta.ts";

const MIN = 60_000;
const iso = (h: number, m: number, s = 0): string =>
  `2026-07-07T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}Z`;

function etaOf(events: FlightDeckEvent[]) {
  return computeEta(foldActivity(events), deriveMetrics(events));
}

describe("campaign burn-down narrows as steps land (R-18)", () => {
  const start: FlightDeckEvent = {
    kind: "activity_start", activityId: "c", ts: iso(10, 0), activityType: "campaign", detail: { planTotal: 6 },
  };
  const early: FlightDeckEvent[] = [
    start,
    { kind: "step", activityId: "c", ts: iso(10, 10), label: "promoted", wave: "W1" },
  ];
  const later: FlightDeckEvent[] = [
    ...early,
    { kind: "step", activityId: "c", ts: iso(10, 20), label: "promoted", wave: "W2" },
    { kind: "step", activityId: "c", ts: iso(10, 30), label: "promoted", wave: "W3" },
  ];

  test("remaining machine-time shrinks with more completed waves", () => {
    const e = etaOf(early);
    const l = etaOf(later);
    expect(e.remaining).toBe(5);
    expect(l.remaining).toBe(3);
    expect(e.machineTimeRemainingMs).not.toBeNull();
    expect(l.machineTimeRemainingMs).not.toBeNull();
    expect(l.machineTimeRemainingMs!).toBeLessThan(e.machineTimeRemainingMs!);
    // both at the same 10-min/wave rate: 5*10 = 50 min vs 3*10 = 30 min
    expect(e.machineTimeRemainingMs).toBe(50 * MIN);
    expect(l.machineTimeRemainingMs).toBe(30 * MIN);
  });

  test("no completed waves ⇒ machine-time not yet estimable (null, not faked)", () => {
    expect(etaOf([start]).machineTimeRemainingMs).toBeNull();
  });
});

describe("machine-time vs blocked-on-you are independent (R-17)", () => {
  // machine 10min → promote → blocked on human 30min → promote.
  const events: FlightDeckEvent[] = [
    { kind: "activity_start", activityId: "c", ts: iso(10, 0), activityType: "campaign", detail: { planTotal: 6 } },
    { kind: "step", activityId: "c", ts: iso(10, 10), label: "promoted", wave: "W1" },
    { kind: "blocked_on_human", activityId: "c", ts: iso(10, 10), action: "waiting-on-meatbag" },
    { kind: "step", activityId: "c", ts: iso(10, 40), label: "promoted", wave: "W2" },
  ];

  test("blocked interval is attributed to you, not the machine", () => {
    const m = deriveMetrics(events);
    expect(m.wallMs).toBe(40 * MIN);
    expect(m.idleMs).toBe(30 * MIN);
    expect(m.machineMs).toBe(10 * MIN); // wall − idle
  });

  test("ETA reports the two figures separately", () => {
    const eta = etaOf(events);
    expect(eta.blockedOnYouMs).toBe(30 * MIN);
    // completed 2 over 10min machine → 5min/wave; remaining 4 → 20min machine.
    expect(eta.machineTimeRemainingMs).toBe(20 * MIN);
  });
});

describe("ci-wait is machine-side, reported separately", () => {
  const events: FlightDeckEvent[] = [
    { kind: "activity_start", activityId: "c", ts: iso(10, 0), activityType: "campaign", detail: { planTotal: 3 } },
    { kind: "ci_wait", activityId: "c", ts: iso(10, 5), action: "waiting-ci" },
    { kind: "step", activityId: "c", ts: iso(10, 20), label: "promoted", wave: "W1" },
  ];
  test("ci-wait counted, not subtracted from machine-time", () => {
    const m = deriveMetrics(events);
    expect(m.ciWaitMs).toBe(15 * MIN);
    expect(m.idleMs).toBe(0);
    expect(m.machineMs).toBe(20 * MIN); // ci-wait stays inside machine-time
  });
});

describe("float cord-band + converge/explore (R-18)", () => {
  const base: FlightDeckEvent[] = [
    { kind: "activity_start", activityId: "f", ts: iso(9, 0), activityType: "float", detail: { cord: 12 } },
    { kind: "step", activityId: "f", ts: iso(9, 5), label: "leg", detail: { leg: 1 } },
    { kind: "metric", activityId: "f", ts: iso(9, 5, 30), metric: "findings-velocity", value: 4 },
    { kind: "step", activityId: "f", ts: iso(9, 10), label: "leg", detail: { leg: 2 } },
    { kind: "metric", activityId: "f", ts: iso(9, 10, 30), metric: "findings-velocity", value: 1 },
    { kind: "step", activityId: "f", ts: iso(9, 15), label: "leg", detail: { leg: 3 } },
  ];

  test("converging when findings trend to zero", () => {
    const converged = [
      ...base,
      { kind: "metric", activityId: "f", ts: iso(9, 15, 30), metric: "findings-velocity", value: 0 } as FlightDeckEvent,
    ];
    const eta = etaOf(converged);
    expect(eta.kind).toBe("float");
    expect(eta.indicator).toBe("converging");
    expect(eta.legs).toBe(3);
    expect(eta.cord).toBe(12);
    expect(eta.legsRemainingBand).toEqual({ low: 0, high: 2 });
    expect(eta.machineTimeRemainingMs).not.toBeNull();
    expect(eta.blockedOnYouMs).toBe(0);
  });

  test("exploring while findings still arrive; band stays wide, cord-bounded", () => {
    const eta = etaOf(base); // last findings-velocity is 1
    expect(eta.indicator).toBe("exploring");
    expect(eta.legsRemainingBand).toEqual({ low: 1, high: 9 }); // cord 12 − 3 legs
  });

  test("isConverging helper", () => {
    expect(isConverging([])).toBe(false);
    expect(isConverging([3, 1, 0])).toBe(true);
    expect(isConverging([3, 1, 2])).toBe(false);
  });
});

describe("closed activity + honest token stub", () => {
  test("closed ⇒ machine-time remaining is 0; blocked-on-you stands", () => {
    const events: FlightDeckEvent[] = [
      { kind: "activity_start", activityId: "c", ts: iso(10, 0), activityType: "campaign", detail: { planTotal: 2 } },
      { kind: "step", activityId: "c", ts: iso(10, 10), label: "promoted", wave: "W1" },
      { kind: "blocked_on_human", activityId: "c", ts: iso(10, 10), action: "waiting-on-meatbag" },
      { kind: "step", activityId: "c", ts: iso(10, 15), label: "promoted", wave: "W2" },
      { kind: "activity_end", activityId: "c", ts: iso(10, 15) },
    ];
    const eta = etaOf(events);
    expect(eta.machineTimeRemainingMs).toBe(0);
    expect(eta.blockedOnYouMs).toBe(5 * MIN);
  });

  test("token metric is null until #853 (never fabricated)", () => {
    const events: FlightDeckEvent[] = [
      { kind: "activity_start", activityId: "c", ts: iso(10, 0), activityType: "campaign" },
      { kind: "metric", activityId: "c", ts: iso(10, 1), metric: "tokens", value: null },
      { kind: "metric", activityId: "c", ts: iso(10, 2), metric: "confidence", value: 0.8 },
      { kind: "metric", activityId: "c", ts: iso(10, 3), metric: "drift", value: 0.1 },
      { kind: "metric", activityId: "c", ts: iso(10, 4), metric: "collision", value: 2 },
    ];
    const m = deriveMetrics(events);
    expect(m.token).toBeNull();
    expect(m.confidence).toBe(0.8);
    expect(m.drift).toBe(0.1);
    expect(m.collision).toBe(2);
  });
});
