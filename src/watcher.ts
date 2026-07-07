// Staleness watcher — the real wall-clock `isStalled` (Dev Spec R-22 / S4.1 / #873).
//
// P3 deliberately left `fold()` free of wall-clock (fold.ts L9-12) and shipped an
// injectable `isStalled` seam on the concern queue (concern_queue.ts). This module is
// that seam's real implementation: an activity is "idle-but-incomplete" (stale) when
// its last event is older than a configurable threshold AND it has not reached a
// terminal state. It is a PURE CONSUMER of the folded `ActivityView` — it never
// re-derives status or re-reads the log; it only adds the one thing the pure fold
// cannot: a comparison against the injected `now`.
//
// Purity/testability: `isStalled(view, now, staleMs)` is a pure function of its three
// inputs — the clock is injected, never `Date.now()` inside — so the boundary is
// exactly testable and `fold()` stays clock-free. `resolveStaleMs()` reads the env
// default only when a threshold is not injected (tests always inject, so no test ever
// touches process.env — CI-hermetic).

import type { ActivityView } from "./fold.ts";

/** Sane default staleness threshold: 15 minutes with no event ⇒ idle-but-incomplete. */
export const DEFAULT_STALE_MS = 15 * 60 * 1000;

/** Env var that overrides the default threshold (milliseconds). */
export const STALE_MS_ENV = "FLIGHTDECK_STALE_MS";

/**
 * The ONE terminal state. `fold()` computes exactly one lifecycle terminal —
 * `status === "closed"` (an `activity_end` was seen). blocked/ci-wait are NOT
 * terminal (still open), so they can go stale. Kept as a named predicate so the
 * "terminal" definition lives in one place.
 */
export function isTerminal(view: ActivityView): boolean {
  return view.status === "closed";
}

/**
 * Resolve the staleness threshold (ms). Injected `env` (defaults to `process.env`)
 * is read ONLY as the fallback when a caller doesn't pass an explicit `staleMs`.
 * A missing/blank/non-positive/non-numeric value falls back to {@link DEFAULT_STALE_MS}.
 */
export function resolveStaleMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env[STALE_MS_ENV];
  if (raw === undefined || raw.trim() === "") return DEFAULT_STALE_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STALE_MS;
}

/**
 * Age (ms) of an activity at `now` = `now - lastEventTs`. Falls back to `startedAt`
 * if no event timestamp folded, and returns `null` when neither is a parseable
 * timestamp (an activity with no clock reference can't be judged stale).
 */
export function ageMs(view: ActivityView, now: number): number | null {
  const ts = view.lastEventTs ?? view.startedAt;
  if (typeof ts !== "string" || ts.length === 0) return null;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? null : now - t;
}

/**
 * The real staleness predicate (R-22). True iff the activity is NOT terminal AND its
 * last event is at least `staleMs` old at `now`. The threshold boundary is inclusive
 * (`age >= staleMs` ⇒ stale) so "older than the threshold" fires exactly at the mark.
 * Pure over `(view, now, staleMs)`; `staleMs` defaults to the env-resolved threshold
 * but tests always pass it explicitly (no env read on the test path).
 */
export function isStalled(
  view: ActivityView,
  now: number,
  staleMs: number = resolveStaleMs(),
): boolean {
  if (isTerminal(view)) return false;
  const age = ageMs(view, now);
  if (age === null) return false;
  return age >= staleMs;
}

/**
 * Adapt {@link isStalled} to the concern queue's injected predicate shape
 * (`(view) => boolean`) by binding `now` + `staleMs`. This is what P4 feeds to
 * `buildConcernQueue(..., { isStalled })` and to the Idle-lane assignment, so the
 * concern queue's own default (blocked-on-human) is replaced by real wall-clock
 * staleness — WITHOUT the queue or the fold ever learning about the clock.
 */
export function stalenessPredicate(
  now: number,
  staleMs: number = resolveStaleMs(),
): (view: ActivityView) => boolean {
  return (view) => isStalled(view, now, staleMs);
}
