// The ONE pure reducer (Dev Spec TC-3 / S2.2 / #866).
//
// `fold()` is the single code path that computes derived state ("closed", status,
// progress, ETA inputs). No other module recomputes any of this — that is the
// ENG-7 bug class ("the view disagrees with the engine") made structurally
// impossible. Both the live per-event update (store.applyOne) and a full
// `rebuild()` go through `foldActivity`, so rebuild ≡ live by construction.
//
// Purity: `fold` reads ONLY the event list, in log (append) order. No `Date.now()`,
// no I/O, no randomness — so a re-fold of the same log always yields the same view.
// (Wall-clock-relative staleness is deliberately NOT computed here; it belongs to
// the P4 watcher, which is allowed to read "now".)
//
// Emit-side conventions this reducer reads (documented so Phase 1 / S1.8 emitters
// and the ETA layer agree):
//   • activity_start may carry `activityType` ("campaign" | "float") and a
//     `detail` object with `planTotal` (campaign wave denominator) and/or `cord`
//     (float leg cap).
//   • a landed/promoted campaign wave  → `{ kind:"step", label:"promoted", wave }`.
//   • a lazyriver float leg            → `{ kind:"step", label:"leg", detail:{ leg:N } }`.
//   • metric events set the latest value per `metric` name; `findings-velocity`
//     history is retained (for the float converge/explore trend).

import type { FlightDeckEvent } from "./events/contract.ts";

export type ActivityType = "campaign" | "float";

/** Derived lifecycle state. `closed` is computed HERE and nowhere else. */
export type ActivityStatus = "active" | "blocked" | "ci-wait" | "closed";

export interface MetricSample {
  /** May be `null` — a seamed-absent metric (e.g. the #853-gated token stub). */
  value: number | string | boolean | null;
  unit: string | null;
  ts: string;
}

export interface Concern {
  concernKind: string;
  source: string;
  ts: string;
  label: string | null;
  logRef: string | null;
  scope: {
    phase: string | null;
    wave: string | null;
    flight: string | number | null;
    agent: string | null;
  };
}

/** One card in the UI. Every field is derived purely from the activity's events. */
export interface ActivityView {
  activityId: string;
  activityType: ActivityType;
  label: string | null;
  status: ActivityStatus;
  startedAt: string | null;
  endedAt: string | null;
  lastEventTs: string | null;
  eventCount: number;
  // scope (last-write-wins per tag)
  currentPhase: string | null;
  currentWave: string | null;
  currentFlight: string | number | null;
  agent: string | null;
  // progress
  planTotal: number | null; // campaign wave denominator
  completed: number; // landed/promoted campaign waves
  cord: number | null; // float leg cap
  legs: number; // float legs so far
  // metrics
  metrics: Record<string, MetricSample>;
  findingsVelocity: number[]; // float converge/explore trend
  // concerns (feeds the global queue in P3)
  concerns: Concern[];
  openConcerns: number;
}

const STATE_BEARING = new Set(["activity_start", "phase", "step", "blocked_on_human", "ci_wait"]);

function asRecord(detail: unknown): Record<string, unknown> | null {
  return typeof detail === "object" && detail !== null && !Array.isArray(detail)
    ? (detail as Record<string, unknown>)
    : null;
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Fold ONE activity's events (in log order) into its view. This is the single
 * reducer; `fold()` below just groups then delegates here. Caller guarantees
 * `events` is non-empty and all share one `activityId`.
 */
export function foldActivity(events: FlightDeckEvent[]): ActivityView {
  const first = events[0] as FlightDeckEvent;
  const v: ActivityView = {
    activityId: first.activityId,
    activityType: "campaign",
    label: null,
    status: "active",
    startedAt: null,
    endedAt: null,
    lastEventTs: null,
    eventCount: events.length,
    currentPhase: null,
    currentWave: null,
    currentFlight: null,
    agent: null,
    planTotal: null,
    completed: 0,
    cord: null,
    legs: 0,
    metrics: {},
    findingsVelocity: [],
    concerns: [],
    openConcerns: 0,
  };

  let lastStateBearingKind: string | null = null;
  let ended = false;

  for (const e of events) {
    v.lastEventTs = e.ts;

    // Scope tags accumulate last-write-wins (ignore null/absent).
    if (typeof e.phase === "string") v.currentPhase = e.phase;
    if (typeof e.wave === "string") v.currentWave = e.wave;
    if (e.flight !== null && e.flight !== undefined) v.currentFlight = e.flight;
    if (typeof e.agent === "string") v.agent = e.agent;
    // NB: the display label comes ONLY from activity_start (below). `step` labels
    // like "promoted"/"leg" are structural markers, not the card's name.

    if (STATE_BEARING.has(e.kind)) lastStateBearingKind = e.kind;

    switch (e.kind) {
      case "activity_start": {
        if (v.startedAt === null) v.startedAt = e.ts;
        if (typeof e.label === "string" && e.label.length > 0) v.label = e.label;
        if (e.activityType === "campaign" || e.activityType === "float") {
          v.activityType = e.activityType;
        }
        const d = asRecord(e.detail);
        if (d) {
          const pt = numOrNull(d["planTotal"]);
          if (pt !== null) v.planTotal = pt;
          const cord = numOrNull(d["cord"]);
          if (cord !== null) v.cord = cord;
        }
        break;
      }
      case "activity_end": {
        ended = true;
        if (v.endedAt === null) v.endedAt = e.ts;
        break;
      }
      case "step": {
        if (e.label === "promoted") v.completed += 1;
        if (e.label === "leg") v.legs += 1;
        break;
      }
      case "metric": {
        const name = typeof e.metric === "string" ? e.metric : null;
        if (name) {
          const value = (e.value ?? null) as MetricSample["value"];
          v.metrics[name] = {
            value,
            unit: typeof e.unit === "string" ? e.unit : null,
            ts: e.ts,
          };
          if (name === "findings-velocity" && typeof e.value === "number") {
            v.findingsVelocity.push(e.value);
          }
          // A metric may ALSO carry the plan denominator honestly.
          if (name === "plan-total" && typeof e.value === "number" && v.planTotal === null) {
            v.planTotal = e.value;
          }
        }
        break;
      }
      case "concern": {
        v.concerns.push({
          concernKind: typeof e.concernKind === "string" ? e.concernKind : "unresolved-todo",
          source: typeof e.source === "string" ? e.source : "declared",
          ts: e.ts,
          label: typeof e.label === "string" ? e.label : null,
          logRef: typeof e.logRef === "string" ? e.logRef : null,
          scope: {
            phase: typeof e.phase === "string" ? e.phase : null,
            wave: typeof e.wave === "string" ? e.wave : null,
            flight: e.flight ?? null,
            agent: typeof e.agent === "string" ? e.agent : null,
          },
        });
        break;
      }
      // phase / blocked_on_human / ci_wait only move status + scope (handled above).
      default:
        break;
    }
  }

  // Startedmay be absent if no activity_start event was seen — fall back to first ts.
  if (v.startedAt === null) v.startedAt = first.ts;

  // Status is derived HERE — the single code path that computes "closed".
  if (ended) {
    v.status = "closed";
  } else if (lastStateBearingKind === "blocked_on_human") {
    v.status = "blocked";
  } else if (lastStateBearingKind === "ci_wait") {
    v.status = "ci-wait";
  } else {
    v.status = "active";
  }

  v.openConcerns = v.concerns.length;
  return v;
}

/**
 * Group events by `activityId` (first-seen order preserved) and fold each group.
 * The returned map is the whole materialized view — a pure function of the log.
 */
export function fold(events: FlightDeckEvent[]): Map<string, ActivityView> {
  const groups = new Map<string, FlightDeckEvent[]>();
  for (const e of events) {
    const arr = groups.get(e.activityId);
    if (arr) arr.push(e);
    else groups.set(e.activityId, [e]);
  }
  const out = new Map<string, ActivityView>();
  for (const [id, group] of groups) {
    out.set(id, foldActivity(group));
  }
  return out;
}
