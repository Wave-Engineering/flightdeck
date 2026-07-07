// Global concern queue — THE centerpiece (Dev Spec R-20 / R-21 / PC-6 / S3.3 / #867).
//
// Every `concern` event, from EVERY activity, folds into ONE global queue so the
// operator has a single place to cycle back on papered-over decisions. Each entry
// links to its exact Phase / Wave / Flight / Leg scope (via the concern's own scope
// tags + logRef), and activities that are stalled with open concerns sort to the top
// (R-21) — the thing most likely to need a human is surfaced first.
//
// PURE CONSUMER: reads the concerns already folded onto each `ActivityView` (fold.ts).
// It does NOT re-scan the raw log or re-derive status — the queue is a re-projection
// of the single fold.

import type { ActivityStatus, ActivityType, ActivityView, Concern } from "../fold.ts";
import { escapeHtml } from "./format.ts";

export interface ConcernQueueEntry {
  activityId: string;
  activityType: ActivityType;
  activityLabel: string | null;
  activityStatus: ActivityStatus;
  /** The activity is stalled AND carries open concerns → this entry sorts to the top. */
  stalled: boolean;
  concern: Concern;
}

/** Default stall predicate: blocked on the human is the clearest "stalled on you". */
function defaultIsStalled(view: ActivityView): boolean {
  return view.status === "blocked";
}

/**
 * Fold ALL concerns across ALL activities into one global, ordered queue.
 * Order: stalled-with-open-concerns first, then most-recent concern first.
 * `opts.isStalled` lets the P4 staleness watcher inject wall-clock staleness later;
 * default is "blocked on human".
 */
export function buildConcernQueue(
  views: ActivityView[],
  opts?: { isStalled?: (view: ActivityView) => boolean },
): ConcernQueueEntry[] {
  const isStalled = opts?.isStalled ?? defaultIsStalled;
  const entries: ConcernQueueEntry[] = [];
  for (const view of views) {
    const stalled = isStalled(view) && view.openConcerns > 0;
    for (const concern of view.concerns) {
      entries.push({
        activityId: view.activityId,
        activityType: view.activityType,
        activityLabel: view.label,
        activityStatus: view.status,
        stalled,
        concern,
      });
    }
  }
  entries.sort((a, b) => {
    if (a.stalled !== b.stalled) return a.stalled ? -1 : 1; // stalled to the top
    return b.concern.ts.localeCompare(a.concern.ts); // then most-recent first
  });
  return entries;
}

/** A human-readable scope trail: Phase › Wave › Flight › agent (only present parts). */
export function scopeLabel(entry: ConcernQueueEntry): string {
  const s = entry.concern.scope;
  const parts: string[] = [];
  if (s.phase) parts.push(`Phase ${s.phase}`);
  if (s.wave) parts.push(`Wave ${s.wave}`);
  if (s.flight !== null && s.flight !== undefined) {
    parts.push(`${entry.activityType === "float" ? "Leg" : "Flight"} ${s.flight}`);
  }
  if (s.agent) parts.push(s.agent);
  return parts.length > 0 ? parts.join(" › ") : "(campaign-level)";
}

/** A link into the scoped log viewer (S3.5) resolving this concern's exact scope. */
export function scopeHref(entry: ConcernQueueEntry): string {
  const s = entry.concern.scope;
  const q = new URLSearchParams();
  q.set("activityId", entry.activityId);
  if (s.phase) q.set("phase", s.phase);
  if (s.wave) q.set("wave", s.wave);
  if (s.flight !== null && s.flight !== undefined) q.set("flight", String(s.flight));
  if (s.agent) q.set("agent", s.agent);
  if (entry.concern.logRef) q.set("logRef", entry.concern.logRef);
  return `/log?${q.toString()}`;
}

function entryRow(entry: ConcernQueueEntry): string {
  const c = entry.concern;
  const title = entry.activityLabel ?? entry.activityId;
  return (
    `<div class="fd-concern-row${entry.stalled ? " is-stalled" : ""}" data-activity-id="${escapeHtml(
      entry.activityId,
    )}">` +
    `<span class="fd-concern-kind" data-kind="${escapeHtml(c.concernKind)}">${escapeHtml(c.concernKind)}</span>` +
    `<span class="fd-concern-source">${escapeHtml(c.source)}</span>` +
    (entry.stalled ? `<span class="fd-concern-stalled" title="stalled with open concerns">⏳ stalled</span>` : "") +
    `<span class="fd-concern-activity">${escapeHtml(title)}</span>` +
    (c.label ? `<span class="fd-concern-label">${escapeHtml(c.label)}</span>` : "") +
    `<a class="fd-scope-link" href="${escapeHtml(scopeHref(entry))}">${escapeHtml(scopeLabel(entry))}</a>` +
    `</div>`
  );
}

/** Render the global concern queue. Empty → an explicit empty state. */
export function renderConcernQueue(entries: ConcernQueueEntry[]): string {
  if (entries.length === 0) {
    return `<section class="fd-concerns fd-concerns-empty"><h2>Concern queue</h2><div class="fd-empty">no open concerns</div></section>`;
  }
  return (
    `<section class="fd-concerns">` +
    `<h2>Concern queue <span class="fd-concern-count">${entries.length}</span></h2>` +
    entries.map(entryRow).join("") +
    `</section>`
  );
}
