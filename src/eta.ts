// Split ETA (Dev Spec R-17/R-18 / S2.3 / #869).
//
// The ETA is TWO independent figures, never merged:
//   • machineTimeRemainingMs — how much longer the machine needs to finish;
//   • blockedOnYouMs         — time the run has spent blocked on the operator.
// Merging them hides the thing the operator most needs to see (am I the bottleneck?).
//
// Campaign estimator = plan-denominator burn-down: remaining waves ÷ the measured
// promote rate (waves per machine-ms). It NARROWS as steps land — more completed
// ⇒ fewer remaining ⇒ smaller ETA (R-18).
//
// Float estimator = a cord-bounded band (you cannot exceed the leg cap) plus a
// converging/exploring indicator read from the findings-velocity trend: once new
// findings trend to zero (zeroNewFindings), the float is converging and expected to
// close within a leg or two; while findings still arrive, it is exploring and the
// band stays wide (R-18).

import type { ActivityView } from "./fold.ts";
import type { ActivityMetrics } from "./metrics.ts";

const DEFAULT_CORD = 12;

export type FloatIndicator = "converging" | "exploring";

export interface EtaResult {
  kind: ActivityView["activityType"];
  /** Machine-time still needed, ms. null when not yet estimable (no progress signal). */
  machineTimeRemainingMs: number | null;
  /** Accumulated blocked-on-you time so far, ms — the separate operator-side figure. */
  blockedOnYouMs: number;
  // campaign fields
  completed?: number;
  planTotal?: number | null;
  remaining?: number | null;
  // float fields
  cord?: number;
  legs?: number;
  legsRemainingBand?: { low: number; high: number };
  indicator?: FloatIndicator;
}

/**
 * Is the float converging? True once new findings have trended to zero — the last
 * observed findings-velocity is 0 (and we have at least one observation). An empty
 * trend is treated as "exploring" (no evidence of convergence yet).
 */
export function isConverging(findingsVelocity: number[]): boolean {
  if (findingsVelocity.length === 0) return false;
  return findingsVelocity[findingsVelocity.length - 1] === 0;
}

function campaignEta(view: ActivityView, metrics: ActivityMetrics): EtaResult {
  const planTotal = view.planTotal;
  const completed = view.completed;
  const remaining = planTotal === null ? null : Math.max(0, planTotal - completed);

  // rate = completed waves per machine-ms; remaining ÷ rate = remaining machine-time.
  let machineTimeRemainingMs: number | null = null;
  if (remaining !== null && completed > 0 && metrics.machineMs > 0) {
    const msPerWave = metrics.machineMs / completed;
    machineTimeRemainingMs = remaining * msPerWave;
  } else if (remaining === 0) {
    machineTimeRemainingMs = 0;
  }

  return {
    kind: "campaign",
    machineTimeRemainingMs,
    blockedOnYouMs: metrics.idleMs,
    completed,
    planTotal,
    remaining,
  };
}

function floatEta(view: ActivityView, metrics: ActivityMetrics): EtaResult {
  const cord = view.cord ?? DEFAULT_CORD;
  const legs = view.legs;
  const highLegs = Math.max(0, cord - legs);
  const converging = isConverging(view.findingsVelocity);

  // Converging → expected to close within ~2 legs; exploring → anywhere up to the cord.
  const band = converging
    ? { low: 0, high: Math.min(2, highLegs) }
    : { low: highLegs > 0 ? 1 : 0, high: highLegs };

  let machineTimeRemainingMs: number | null = null;
  if (legs > 0 && metrics.machineMs > 0) {
    const msPerLeg = metrics.machineMs / legs;
    machineTimeRemainingMs = msPerLeg * ((band.low + band.high) / 2);
  } else if (highLegs === 0) {
    machineTimeRemainingMs = 0;
  }

  return {
    kind: "float",
    machineTimeRemainingMs,
    blockedOnYouMs: metrics.idleMs,
    cord,
    legs,
    legsRemainingBand: band,
    indicator: converging ? "converging" : "exploring",
  };
}

/** Compute the split ETA for an activity from its view + derived metrics. */
export function computeEta(view: ActivityView, metrics: ActivityMetrics): EtaResult {
  // A closed activity has no remaining machine-time; its blocked-on-you total stands.
  if (view.status === "closed") {
    const base = view.activityType === "campaign" ? campaignEta(view, metrics) : floatEta(view, metrics);
    return { ...base, machineTimeRemainingMs: 0 };
  }
  return view.activityType === "campaign" ? campaignEta(view, metrics) : floatEta(view, metrics);
}
