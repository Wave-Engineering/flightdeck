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

/** "session" (#7 / cc-workflow#947): agent presence, not work — rendered in the
 *  presence strip, never as a campaign/float card. */
export type ActivityType = "campaign" | "float" | "session";

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
  /** Granular action ("promoting"/"awaiting-verdict"/…) from the last event carrying
   *  one — the status the console shows instead of the coarse lifecycle (AC3, cc#1026). */
  currentAction: string | null;
  /** Emitting host (additive convention, #7) — distinct from `agent` (Dev-Name). */
  host: string | null;
  /** True iff any event carried `detail.synthetic === true` — test residue the
   *  board must be able to filter (#7, defect 3 of cc-workflow#947). */
  synthetic: boolean;
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
 * the group is COMPLETE — every event for that activity, not a suffix. The
 * promotion dedup (`step` case) keeps its state fold-locally rather than in the
 * view, which is only sound because every caller re-folds the whole group; a
 * partial-group caller would make the live view and a rebuild disagree.
 * `events` is non-empty and all share one `activityId`.
 */
export function foldActivity(events: FlightDeckEvent[]): ActivityView {
  const first = events[0] as FlightDeckEvent;
  // Waves whose promotion has already been counted — see the `step` case.
  const countedPromotions = new Set<string>();
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
    currentAction: null,
    host: null,
    synthetic: false,
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
  let isSession = false;

  for (const e of events) {
    v.lastEventTs = e.ts;

    // Scope tags accumulate last-write-wins (ignore null/absent).
    if (typeof e.phase === "string") v.currentPhase = e.phase;
    if (typeof e.wave === "string") v.currentWave = e.wave;
    if (e.flight !== null && e.flight !== undefined) v.currentFlight = e.flight;
    if (typeof e.agent === "string") v.agent = e.agent;
    // Granular action, last-write-wins (AC3): latch ONLY active-lane actions (step/phase
    // — "promoting"/"launching"/"awaiting-verdict"/"planning"/…). Block/ci actions
    // ("hold"/"waiting-on-meatbag"/"waiting-ci") arrive as blocked_on_human/ci_wait kinds
    // and already own the lifecycle status text; latching them would let a stale block
    // action surface on a later re-activated card (status flips back to active via an
    // action-less `promoted` step, but currentAction would still read "hold").
    if ((e.kind === "step" || e.kind === "phase") && typeof e.action === "string" && e.action.length > 0) {
      v.currentAction = e.action;
    }
    const host = e["host"];
    if (typeof host === "string") v.host = host;
    // NB: the display label comes ONLY from activity_start (below). `step` labels
    // like "promoted"/"leg" are structural markers, not the card's name.

    // Session classification (#7): declared `activityType: "session"` on ANY event
    // (the new emitter stamps every session event), or the legacy S1.7 shape
    // `phase: "session"` with no activityType — covers pre-fix log events, incl.
    // orphan steps whose activity_start predates the emitter. Checked on every
    // event (not just activity_start) so a re-fold reclassifies history.
    if (e.activityType === "session" || e.phase === "session") isSession = true;

    // Synthetic marker (#7): any event carrying `detail.synthetic === true` marks
    // the whole activity as test residue the board can filter.
    const detail = asRecord(e.detail);
    if (detail && detail["synthetic"] === true) v.synthetic = true;

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
        if (e.label === "promoted") {
          // DEDUP: the numerator must not trust its producer to be exactly-once.
          //
          // The promote emit is not a deterministic call — it is a line appended to
          // an agent's prompt asking it to run a command "ONCE" (cc-workflow#1138).
          // Plan #103 emitted 10 `promoted` rows for 3 waves (1/4/5), rendering
          // 10/3 on a correctly-keyed, current-emitter campaign. Fixing the emitter
          // is right and is tracked upstream; fixing it HERE is what makes the card
          // robust to any over-firing rather than to the one shape we measured.
          //
          // Fold-local by design: `foldActivity` always receives the COMPLETE event
          // group (store.ts re-folds `eventsFor(activityId)` on the live path and
          // everything on rebuild), so this Set sees full history on every path. No
          // view field, no persistence, and R-09 still holds — rebuild reproduces
          // the live view exactly.
          //
          // DEDUP REQUIRES IDENTITY, and the identity is the WAVE ALONE.
          //
          // NOT (wave, phase). There are exactly two producers of label:"promoted"
          // and they disagree on phase for the SAME promotion:
          //
          //   cc-workflow src/wave_status/state.py:1298
          //     _emit_event(root, "step", wave=target, action="complete", ...)   → no phase
          //   cc-workflow skills/nextwave/per-wave-workflow.js:476
          //     flightdeckTee({ phase: 'Promote', label: disposition })          → phase "Promote"
          //
          // They are not alternatives — the same terminal prompt instructs both, and
          // wavemachine/SKILL.md pins FLIGHTDECK_ACTIVITY_ID so both land on ONE
          // card by design. `phase` here is the emitting NODE's name, hard-coded at
          // the only node that emits this label; it identifies the PRODUCER, not the
          // promotion. Keying on it would leave a clean 3-wave campaign rendering
          // 6/3 — systematic rather than flaky, which is worse, because it looks
          // stable and nearly right.
          //
          // A `promoted` carrying no wave cannot be PROVEN a duplicate, so it still
          // counts: collapsing unidentifiable events would trade over-counting for
          // under-counting, and a card reading 1/3 when three waves landed is no
          // better than 10/3 — only harder to notice.
          const wave = typeof e.wave === "string" ? e.wave : null;
          if (wave === null || !countedPromotions.has(wave)) {
            if (wave !== null) countedPromotions.add(wave);
            v.completed += 1;
          }
        }
        // `leg` deliberately NOT deduped on the same key. A float leg is
        // `{label:"leg", detail:{leg:N}}` — legs legitimately repeat and identify
        // themselves by `detail.leg`, not by wave/phase. Keying them here would
        // collapse every leg into one, converting an inflation bug into a
        // suppression bug. If legs ever show the same duplication, `detail.leg` is
        // the right key and it is a separate change.
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

  // Started may be absent if no activity_start event was seen — fall back to first ts.
  if (v.startedAt === null) v.startedAt = first.ts;

  // A session marker anywhere wins over the campaign default (and over a declared
  // campaign/float — a session event stream is presence by definition).
  if (isSession) v.activityType = "session";

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
