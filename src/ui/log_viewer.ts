// Scoped log viewer (Dev Spec R-15 / MV-03 / S3.5 / #870).
//
// Resolves a `logRef` and/or filters the raw event transcript by scope tag
// (Phase / Wave / Flight / Leg / agent), so a concern-queue click-through lands on
// exactly the events for that scope. This reads the append-only LOG (the source of
// truth) — a transcript, not a re-derivation of status; the single fold is untouched.

import type { FlightDeckEvent } from "../events/contract.ts";
import { escapeHtml } from "./format.ts";

/** A scope selector. Every present key must match; absent keys don't constrain. */
export interface LogScope {
  activityId?: string;
  phase?: string;
  wave?: string;
  flight?: string;
  agent?: string;
}

function tagEquals(eventValue: unknown, wanted: string): boolean {
  if (eventValue === null || eventValue === undefined) return false;
  return String(eventValue) === wanted;
}

/** Filter events to those matching ALL provided scope tags (narrowing, R-15). */
export function filterByScope(events: FlightDeckEvent[], scope: LogScope): FlightDeckEvent[] {
  return events.filter((e) => {
    if (scope.activityId !== undefined && e.activityId !== scope.activityId) return false;
    if (scope.phase !== undefined && !tagEquals(e.phase, scope.phase)) return false;
    if (scope.wave !== undefined && !tagEquals(e.wave, scope.wave)) return false;
    if (scope.flight !== undefined && !tagEquals(e.flight, scope.flight)) return false;
    if (scope.agent !== undefined && !tagEquals(e.agent, scope.agent)) return false;
    return true;
  });
}

/** Resolve a `logRef` to the event(s) that carry it. */
export function resolveLogRef(events: FlightDeckEvent[], logRef: string): FlightDeckEvent[] {
  return events.filter((e) => e.logRef === logRef);
}

/** Parse a scope from a URL query (the concern-queue scope link target). */
export function parseScope(params: URLSearchParams): LogScope {
  const scope: LogScope = {};
  for (const key of ["activityId", "phase", "wave", "flight", "agent"] as const) {
    const v = params.get(key);
    if (v !== null && v.length > 0) scope[key] = v;
  }
  return scope;
}

/** A one-line human scope summary for the viewer header. */
function scopeSummary(scope: LogScope): string {
  const parts: string[] = [];
  if (scope.activityId) parts.push(scope.activityId);
  if (scope.phase) parts.push(`Phase ${scope.phase}`);
  if (scope.wave) parts.push(`Wave ${scope.wave}`);
  if (scope.flight) parts.push(`Flight/Leg ${scope.flight}`);
  if (scope.agent) parts.push(scope.agent);
  return parts.length > 0 ? parts.join(" › ") : "all events";
}

function logLine(e: FlightDeckEvent): string {
  const scopeBits = [
    e.phase ? `P${e.phase}` : "",
    e.wave ? `W${e.wave}` : "",
    e.flight !== null && e.flight !== undefined ? `F${e.flight}` : "",
    e.agent ? `@${e.agent}` : "",
  ]
    .filter((s) => s.length > 0)
    .join(" ");
  const detail =
    e.kind === "metric"
      ? `${e.metric ?? ""}=${e.value ?? "—"}`
      : e.kind === "concern"
        ? `${e.concernKind ?? ""} (${e.source ?? ""})`
        : (e.label ?? "");
  return (
    `<div class="fd-log-line" data-kind="${escapeHtml(e.kind)}">` +
    `<span class="fd-log-ts">${escapeHtml(e.ts)}</span> ` +
    `<span class="fd-log-kind">${escapeHtml(e.kind)}</span> ` +
    (scopeBits ? `<span class="fd-log-scope">${escapeHtml(scopeBits)}</span> ` : "") +
    (detail ? `<span class="fd-log-detail">${escapeHtml(detail)}</span>` : "") +
    `</div>`
  );
}

/**
 * Render the scoped transcript: a header naming the active scope, then one line per
 * event narrowed to that scope (in log order). Empty scope → the full transcript.
 */
export function renderLogViewer(events: FlightDeckEvent[], scope: LogScope): string {
  const filtered = filterByScope(events, scope);
  const header =
    `<div class="fd-log-head"><h2>Log</h2>` +
    `<span class="fd-log-scope-summary">${escapeHtml(scopeSummary(scope))}</span>` +
    `<span class="fd-log-count">${filtered.length}</span></div>`;
  if (filtered.length === 0) {
    return `<section class="fd-log">${header}<div class="fd-log-empty">no events for this scope</div></section>`;
  }
  return `<section class="fd-log">${header}${filtered.map(logLine).join("")}</section>`;
}
