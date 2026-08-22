// Shared, pure formatting helpers for the UI layer (Phase 3).
//
// These are the ONLY string-massaging primitives the renderers use. They are
// pure (no I/O, no Date) so every `render*` function stays a pure function of its
// model and is trivially unit-testable under CI (no DOM, no clock).

/** HTML-escape a string for safe interpolation into markup. */
export function escapeHtml(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Humanize a millisecond duration for display. `null` (not yet estimable) renders
 * as an em dash — the honest "unknown", never a fabricated 0. Negative clamps to 0.
 */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  const total = Math.max(0, Math.round(ms / 1000)); // seconds
  if (total < 60) return `${total}s`;
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  if (mins < 60) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
}

/**
 * The last path segment of a forge/project path (#10): "Wave-Engineering/flightdeck"
 * → "flightdeck". Non-path values pass through unchanged; trailing slashes are
 * tolerated; a value that reduces to nothing (e.g. "/") falls back to the input.
 */
/** What the agent slot shows, and whether it is a real attribution (AX-3). */
export interface Display {
  /** The text to render. For an unattributed activity this is still the id/label —
   *  it is how an operator finds the thing — but `attributed` says it is not a name. */
  text: string;
  /** True only when a Dev-Name was resolved from the event stream. */
  attributed: boolean;
}

/**
 * Resolve the agent slot for an activity (AX-3, #35).
 *
 * `view.agent ?? shortName(label ?? activityId)` used to be inlined at three call
 * sites, which put an ACTIVITY ID in the agent position with the same weight and
 * styling as a real Dev-Name. `P1W1`, `161`, `RTM-spike` and `flightdeck` then read
 * as agent names to anyone who does not already know the fleet roster — 34 of 56
 * activities on the live board. That is a guess presented as a fact, which AX-2
 * forbids, and it hides the size of the emit-side gap it stands in for.
 *
 * One resolver so the card, the table and the concern queue cannot drift.
 */
export function resolveDisplay(view: {
  agent: string | null;
  label: string | null;
  activityId: string;
}): Display {
  if (view.agent !== null && view.agent.length > 0) {
    return { text: view.agent, attributed: true };
  }
  return { text: shortName(view.label ?? view.activityId), attributed: false };
}

export function shortName(value: string): string {
  const trimmed = value.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  const short = idx === -1 ? trimmed : trimmed.slice(idx + 1);
  return short.length > 0 ? short : value;
}

/**
 * Render a derived-metric value for a metric cell. `null` is a *seamed-absent*
 * value (e.g. the #853-gated token stub) and shows as an em dash — never faked.
 */
export function formatMetricValue(value: number | string | boolean | null): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
  return escapeHtml(value);
}
