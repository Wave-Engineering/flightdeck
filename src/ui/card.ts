// One-anatomy activity card (Dev Spec R-10 / R-14 / S3.1 / #868).
//
// THE core P3 invariant: a campaign and a float render from ONE identical card
// anatomy — same header, same vitals row, same expandable metrics grid — differing
// ONLY in the estimator label ("waves" vs "legs"). `estimatorLabel()` is the single
// point of that difference; everything else is shared markup. This mirrors the
// single-fold invariant one layer up: one reducer for state, one anatomy for render.
//
// PURE CONSUMER: this module reads a pre-folded `ActivityView` (from fold.ts) plus
// the derived `ActivityMetrics`/`EtaResult` (metrics.ts/eta.ts). It NEVER recomputes
// status, progress, or ETA — a second status code path is the ENG-7 bug this whole
// system exists to kill. `render*` here is a pure function of its `CardModel`.

import type { ActivityMetrics } from "../metrics.ts";
import type { EtaResult } from "../eta.ts";
import type { ActivityStatus, ActivityType, ActivityView } from "../fold.ts";
import { renderEtaStrip } from "./eta_strip.ts";
import { escapeHtml, formatDuration, formatMetricValue, shortName } from "./format.ts";

/** Everything a card needs, assembled from the store's fold + derivations. */
export interface CardModel {
  view: ActivityView;
  metrics: ActivityMetrics;
  eta: EtaResult;
}

/**
 * The SINGLE campaign/float difference: the unit the estimator counts in. A campaign
 * burns down waves; a float burns down legs. Same anatomy, one different word.
 */
export function estimatorLabel(type: ActivityType): string {
  return type === "campaign" ? "waves" : "legs";
}

const STATUS_TEXT: Record<ActivityStatus, string> = {
  active: "active",
  blocked: "blocked on you",
  "ci-wait": "waiting on CI",
  closed: "closed",
};

/** Numerator / denominator for the progress readout, chosen by kind (same markup). */
function progress(view: ActivityView): { done: number; total: number | null } {
  return view.activityType === "campaign"
    ? { done: view.completed, total: view.planTotal }
    : { done: view.legs, total: view.cord };
}

function metricCell(label: string, value: string): string {
  return (
    `<div class="fd-metric"><span class="fd-metric-label">${escapeHtml(label)}</span>` +
    `<span class="fd-metric-value">${value}</span></div>`
  );
}

/** The full metrics grid, shown only when the card is expanded (R-14). */
function renderMetricsGrid(m: CardModel): string {
  const { metrics } = m;
  const cells = [
    metricCell("wall", formatDuration(metrics.wallMs)),
    metricCell("machine", formatDuration(metrics.machineMs)),
    metricCell("blocked-on-you", formatDuration(metrics.idleMs)),
    metricCell("ci-wait", formatDuration(metrics.ciWaitMs)),
    metricCell("collision", formatMetricValue(metrics.collision)),
    metricCell("confidence", formatMetricValue(metrics.confidence)),
    metricCell("drift", formatMetricValue(metrics.drift)),
    // token: seamed-absent stub until #853 — renders as an em dash, never faked.
    metricCell("tokens", formatMetricValue(metrics.token)),
  ];
  return `<div class="fd-metrics-grid">${cells.join("")}</div>`;
}

/**
 * Render one activity card. `opts.expanded` overrides the default (Active expanded,
 * Closed collapsed — R-14). The whole card is a pure function of `model`.
 */
export function renderCard(model: CardModel, opts?: { expanded?: boolean }): string {
  const { view, eta } = model;
  const expanded = opts?.expanded ?? view.status !== "closed";
  const label = estimatorLabel(view.activityType);
  const { done, total } = progress(view);
  const totalText = total === null ? "?" : String(total);
  const concernChip =
    view.openConcerns > 0
      ? `<span class="fd-chip fd-chip-concern" title="open concerns">⚑ ${view.openConcerns}</span>`
      : "";
  // Title precedence (#10): the working agent's Dev-Name when the activity has
  // one, else the SHORT project name (basename — never the full forge path).
  // The untouched full value stays on the hover title either way.
  const fullName = view.label ?? view.activityId;
  const displayName = view.agent ?? shortName(fullName);
  // Status text (AC3, cc#1026): while active, show the granular current action
  // ("promoting"/"awaiting-verdict"/…) rather than the coarse "active" badge; the
  // lifecycle text still speaks for blocked/ci-wait/closed. `data-status` below keeps
  // the raw lifecycle value untouched — the lane/client logic reads that, not the text.
  const statusText =
    view.status === "active" && view.currentAction
      ? view.currentAction.replace(/-/g, " ")
      : STATUS_TEXT[view.status];

  return (
    `<article class="fd-card" data-activity-id="${escapeHtml(view.activityId)}" ` +
    `data-type="${escapeHtml(view.activityType)}" data-status="${escapeHtml(view.status)}" ` +
    `data-expanded="${expanded ? "true" : "false"}">` +
    // header
    `<header class="fd-card-head">` +
    `<span class="fd-card-title" title="${escapeHtml(fullName)}">${escapeHtml(displayName)}</span>` +
    `<span class="fd-badge fd-badge-type">${escapeHtml(view.activityType)}</span>` +
    `<span class="fd-badge fd-badge-status" data-status="${escapeHtml(view.status)}">${escapeHtml(
      statusText,
    )}</span>` +
    `<button class="fd-card-toggle" data-action="toggle-expand" aria-label="expand or collapse">${
      expanded ? "▾" : "▸"
    }</button>` +
    `</header>` +
    // vitals row (always visible)
    `<div class="fd-vitals">` +
    `<span class="fd-progress" data-estimator="${escapeHtml(label)}">${done} / ${escapeHtml(
      totalText,
    )} <span class="fd-estimator-label">${escapeHtml(label)}</span></span>` +
    renderEtaStrip(eta, { variant: "inline" }) +
    concernChip +
    `</div>` +
    // expanded body: the split-ETA headline strip + the full metrics grid. Always in
    // the DOM; CSS reveals it only when expanded, so expand/collapse is pure
    // client-side (no server round-trip).
    renderEtaStrip(eta, { variant: "headline" }) +
    renderMetricsGrid(model) +
    `</article>`
  );
}
