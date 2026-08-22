// Dense one-line-per-activity table (Dev Spec R-13 / S3.2 / #864).
//
// The per-lane alternative to the card grid: one compact row per activity. The
// operator toggles a lane between cards and this table independently (Active → cards,
// Closed/Idle → table by default); the toggle is pure client-side CSS driven by the
// lane's `data-layout` (see page.ts / STYLES), so the same server-rendered markup
// carries BOTH representations and switching costs no round-trip.
//
// PURE CONSUMER: renders from the same `CardModel` (folded view + derived metrics/eta)
// the card uses. N models → N rows, by construction.

import { type CardModel, estimatorLabel } from "./card.ts";
import { escapeHtml, formatDuration, resolveDisplay } from "./format.ts";

const STATUS_TEXT: Record<CardModel["view"]["status"], string> = {
  active: "active",
  blocked: "blocked",
  "ci-wait": "ci-wait",
  closed: "closed",
};

/** Same "no declared type" hole as the card (#31, AX-2) — no estimator for
 *  something that never declared a campaign/float type. */
function progressCell(view: CardModel["view"]): string {
  if (view.activityType === "headless") return "no declared type";
  const label = estimatorLabel(view.activityType);
  const done = view.activityType === "campaign" ? view.completed : view.legs;
  const total = view.activityType === "campaign" ? view.planTotal : view.cord;
  const totalText = total === null ? "?" : String(total);
  return `${done} / ${escapeHtml(totalText)} ${escapeHtml(label)}`;
}

function row(m: CardModel): string {
  const { view, metrics, eta } = m;
  // Same title precedence as the card (#10): agent Dev-Name > short project name.
  const fullName = view.label ?? view.activityId;
  const display = resolveDisplay(view);
  return (
    `<tr class="fd-row" data-activity-id="${escapeHtml(view.activityId)}" data-status="${escapeHtml(view.status)}">` +
    `<td class="fd-row-title" data-attributed="${display.attributed}" title="${escapeHtml(
      fullName,
    )}">${escapeHtml(display.text)}</td>` +
    `<td>${escapeHtml(view.activityType)}</td>` +
    `<td>${escapeHtml(STATUS_TEXT[view.status])}</td>` +
    `<td class="fd-row-progress">${progressCell(view)}</td>` +
    `<td class="fd-row-machine">${escapeHtml(formatDuration(eta.machineTimeRemainingMs))}</td>` +
    `<td class="fd-row-blocked" data-blocked-ms="${metrics.idleMs}">${escapeHtml(formatDuration(metrics.idleMs))}</td>` +
    `<td class="fd-row-concerns">${view.openConcerns > 0 ? `⚑ ${view.openConcerns}` : ""}</td>` +
    `</tr>`
  );
}

/** Render a dense table — exactly one `<tr>` in the tbody per model. */
export function renderTable(models: CardModel[]): string {
  if (models.length === 0) {
    return `<table class="fd-table"><tbody></tbody></table>`;
  }
  const head =
    `<thead><tr><th>activity</th><th>kind</th><th>status</th>` +
    `<th>progress</th><th>machine</th><th>blocked-on-you</th><th>concerns</th></tr></thead>`;
  const body = `<tbody>${models.map(row).join("")}</tbody>`;
  return `<table class="fd-table">${head}${body}</table>`;
}
