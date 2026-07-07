// Derived metrics (Dev Spec §5.3 / R-16 / S2.3 / #869).
//
// Everything here is FREE from the event log — wall / idle(blocked-on-you) /
// ci-wait are integrated from event timestamps; collision / confidence / drift are
// the latest values of their respective `metric` events. The token metric is a
// seamed-absent stub: it is `null` until #853 surfaces per-node token usage, and is
// NEVER fabricated (R-19 / TC-7).
//
// Purity: a function of the event list only. Trailing OPEN intervals (e.g. an
// activity that is currently blocked, with no following event) contribute 0 here —
// they are deterministic over the log. The live, real-time "blocked-on-you" counter
// that keeps ticking is a UI concern (the P3 eta strip reads a wall clock); this
// module intentionally does not.

import type { FlightDeckEvent } from "./events/contract.ts";

export interface ActivityMetrics {
  /** Total wall-clock span first→last event, ms. */
  wallMs: number;
  /** Time blocked on the human (blocked_on_human intervals), ms. This is the "you" side. */
  idleMs: number;
  /** Time waiting on CI (ci_wait intervals), ms. Machine-side, reported separately. */
  ciWaitMs: number;
  /** Machine-time = wall − idle (ci-wait counts as machine-side, not blocked-on-you). */
  machineMs: number;
  /** Merge-collision count (latest `metric{collision}`), else 0. */
  collision: number;
  /** Latest `metric{confidence}` value, else null. */
  confidence: number | null;
  /** Latest `metric{drift}` value, else null. */
  drift: number | null;
  /** Latest `metric{tokens}` value — null until #853 lands (honest stub, never faked). */
  token: number | null;
}

function parseTs(ts: string): number {
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? 0 : ms;
}

/** Latest numeric value among `metric` events with the given name, else null. */
function latestMetric(events: FlightDeckEvent[], name: string): number | null {
  let out: number | null = null;
  for (const e of events) {
    if (e.kind === "metric" && e.metric === name && typeof e.value === "number") {
      out = e.value;
    }
  }
  return out;
}

/**
 * Integrate wall / blocked-on-you / ci-wait durations from timestamps and read the
 * latest collision/confidence/drift/token metrics. Pure over `events`.
 */
export function deriveMetrics(events: FlightDeckEvent[]): ActivityMetrics {
  const wallMs =
    events.length >= 2
      ? Math.max(0, parseTs(events[events.length - 1]!.ts) - parseTs(events[0]!.ts))
      : 0;

  // Attribute each inter-event gap to the state in force at the start of the gap.
  // State flips only on state-bearing events; metric/concern events keep the state.
  let idleMs = 0;
  let ciWaitMs = 0;
  let state: "machine" | "blocked" | "ci-wait" = "machine";

  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (e.kind === "blocked_on_human") state = "blocked";
    else if (e.kind === "ci_wait") state = "ci-wait";
    else if (e.kind === "activity_start" || e.kind === "phase" || e.kind === "step") {
      state = "machine";
    }
    // metric / concern / activity_end do not change the state.

    const next = events[i + 1];
    if (next) {
      const gap = parseTs(next.ts) - parseTs(e.ts);
      if (gap > 0) {
        if (state === "blocked") idleMs += gap;
        else if (state === "ci-wait") ciWaitMs += gap;
      }
    }
  }

  return {
    wallMs,
    idleMs,
    ciWaitMs,
    machineMs: Math.max(0, wallMs - idleMs),
    collision: latestMetric(events, "collision") ?? 0,
    confidence: latestMetric(events, "confidence"),
    drift: latestMetric(events, "drift"),
    token: latestMetric(events, "tokens"), // null until #853 — honest stub
  };
}
