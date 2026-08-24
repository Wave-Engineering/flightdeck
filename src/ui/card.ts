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
import { escapeHtml, formatDuration, formatMetricValue, resolveDisplay } from "./format.ts";

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

/** Numerator / denominator for the progress readout, chosen by kind (same markup).
 *  `null` for a headless activity (#31, AX-2): with no lifecycle head there is no
 *  known estimator to report a numerator against — not even a "0 / ?" placeholder. */
function progress(view: ActivityView): { done: number; total: number | null } | null {
  if (view.activityType === "headless") return null;
  return view.activityType === "campaign"
    ? { done: view.completed, total: view.planTotal }
    : { done: view.legs, total: view.cord };
}

/** The vitals-row progress readout: the estimator fraction, or an explicit
 *  "no declared type" hole for a headless activity (#31, AX-2). */
function renderProgress(view: ActivityView): string {
  const prog = progress(view);
  if (!prog) {
    // AX-1: say exactly what was checked, no more. "Headless" covers TWO shapes —
    // no activity_start at all, AND an activity_start that never named a type
    // (the live producer shape, cc-workflow state.py:664) — so the copy must not
    // claim "no activity_start seen"; that is false for the second shape.
    return `<span class="fd-progress fd-progress-headless" title="no event on this activity has declared a campaign/float type">no declared type</span>`;
  }
  const label = estimatorLabel(view.activityType);
  const totalText = prog.total === null ? "?" : String(prog.total);
  return (
    `<span class="fd-progress" data-estimator="${escapeHtml(label)}">${prog.done} / ${escapeHtml(
      totalText,
    )} <span class="fd-estimator-label">${escapeHtml(label)}</span></span>`
  );
}

function metricCell(label: string, value: string): string {
  return (
    `<div class="fd-metric"><span class="fd-metric-label">${escapeHtml(label)}</span>` +
    `<span class="fd-metric-value">${value}</span></div>`
  );
}

/** Shared work-items done/total cell renderer (cc-workflow#1146 step 4 —
 *  campaign scope #1154, wave scope #1157). Both scopes hit the same AX-2
 *  discipline: the pair is atomic, so an unknown denominator suppresses the
 *  numerator too — "?" alone, never "0 / ?" (AX-2 names that exact shape as
 *  the failure this axiom exists to prevent). Deliberately NOT the same
 *  numerator-shown-regardless-of-denominator convention `renderProgress`
 *  above uses — that pattern predates this cell, and inheriting it here
 *  would just be a second instance of the same violation, not a reason to
 *  keep it. *holeTitle* names WHICH kind of gap it is (an un-shipped
 *  denominator vs. no current wave, e.g.) — a bare "?" with no explanation
 *  is a second hole (AX-2). */
function renderWorkItemsFractionCell(
  label: string,
  done: number,
  total: number | null,
  holeTitle: string,
): string {
  if (total === null) {
    const hole = `<span class="fd-metric-hole" title="${escapeHtml(holeTitle)}">?</span>`;
    return metricCell(label, hole);
  }
  return metricCell(label, `${done} / ${total}`);
}

/** Campaign-scope work-items cell. Campaign-only: a float's estimator is
 *  legs/cord, and neither work-items denominator is ever shipped for a
 *  float — rendering either cell there would read as "not tracked yet"
 *  rather than the true "not applicable" (AX-2's hole-naming distinguishes
 *  the two). `null` (omit the cell) covers that. */
function renderWorkItemsCell(view: ActivityView): string | null {
  if (view.activityType !== "campaign") return null;
  return renderWorkItemsFractionCell(
    "work items (campaign)",
    view.workItemsDone,
    view.workItemsTotal,
    "no activity_start on this campaign has shipped a workItemsTotal denominator",
  );
}

/** Wave-scope work-items cell (cc-workflow#1157). Campaign-only, same
 *  reasoning as the campaign-scope cell. THREE distinct causes of a null
 *  denominator, not two — code review caught the first draft collapsing
 *  "no head has shipped a waveWorkItems map at all" into the "map exists,
 *  no entry for this wave" copy, which is false for every card built from
 *  a pre-#1157 campaign head (the dominant shape while this convention is
 *  new). AX-2: a wrong explanation is a second hole.
 *
 *  The label itself carries the wave id (`work items (wave-2)`, not a bare
 *  `work items (wave)`) for a second reason, also from review: `currentWave`
 *  is last-write-wins over the position-bearing events that set it
 *  (`activity_start`/`phase`/non-close-issue `step`s — close-issue's own
 *  `wave` tag was EXCLUDED from that latch in review round 3, precisely
 *  because it names the closed issue's plan wave, not the campaign's
 *  position), so a genuinely late/reordered POSITION event (a stale tee
 *  re-fire, a resumed replay — both real shapes this reducer already has
 *  to dedup elsewhere, see the promotion-dedup tests) can still make
 *  `currentWave` read an EARLIER wave than the campaign has actually
 *  reached. Naming the wave in the label makes that residual staleness
 *  visible and auditable against what the operator otherwise knows about
 *  the campaign, rather than silently attributing a done/total fraction to
 *  the wrong wave under a generic label — AX-1's "display only what the
 *  data says" cuts both ways: show the wave id, don't hide it. */
function renderWaveWorkItemsCell(view: ActivityView): string | null {
  if (view.activityType !== "campaign") return null;
  const label = view.currentWave === null ? "work items (wave)" : `work items (${view.currentWave})`;
  const holeTitle =
    view.currentWave === null
      ? "no wave is current on this campaign yet"
      : view.waveWorkItems === null
        ? "no activity_start on this campaign has shipped a waveWorkItems map"
        : "the campaign head's waveWorkItems map has no entry for the current wave";
  return renderWorkItemsFractionCell(
    label,
    view.waveWorkItemsDone,
    view.waveWorkItemsTotal,
    holeTitle,
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
  const workItems = renderWorkItemsCell(m.view);
  if (workItems !== null) cells.push(workItems);
  const waveWorkItems = renderWaveWorkItemsCell(m.view);
  if (waveWorkItems !== null) cells.push(waveWorkItems);
  return `<div class="fd-metrics-grid">${cells.join("")}</div>`;
}

/**
 * Render one activity card. `opts.expanded` overrides the default (Active expanded,
 * Closed collapsed — R-14). The whole card is a pure function of `model`.
 */
export function renderCard(model: CardModel, opts?: { expanded?: boolean }): string {
  const { view, eta } = model;
  const expanded = opts?.expanded ?? view.status !== "closed";
  const concernChip =
    view.openConcerns > 0
      ? `<span class="fd-chip fd-chip-concern" title="open concerns">⚑ ${view.openConcerns}</span>`
      : "";
  // Title precedence (#10): the working agent's Dev-Name when the activity has
  // one, else the SHORT project name (basename — never the full forge path).
  // The untouched full value stays on the hover title either way.
  const fullName = view.label ?? view.activityId;
  const display = resolveDisplay(view);
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
    `<span class="fd-card-title" data-attributed="${display.attributed}" title="${escapeHtml(
      fullName,
    )}">${escapeHtml(display.text)}</span>` +
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
    renderProgress(view) +
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
