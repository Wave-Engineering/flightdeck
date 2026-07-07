// Card grid — the default multi-activity view (Dev Spec R-12 / S3.1 / #868).
//
// When several activities run at once the console presents them as a grid of the
// one-anatomy cards (grid = default; the dense table is the per-lane toggle in S3.2).
// Pure: a function of the CardModel list. Lane assignment is derived from the folded
// `status` only — no re-derivation.

import type { ActivityView } from "../fold.ts";
import { type CardModel, renderCard } from "./card.ts";

/** The three lanes. "Idle" (stale-but-open) is a P4 wall-clock concern supplied by
 *  the watcher; a closed activity is `closed`, an open+stale one is `idle`, and any
 *  other open one is `active`. */
export type Lane = "active" | "idle" | "closed";

/**
 * Which lane an activity belongs to. Terminal (folded `status === "closed"`) always
 * wins → `closed`. Otherwise, if the watcher flags it stale (`opts.stale`, a
 * wall-clock signal the pure fold can't produce) → `idle`; else `active`. Lane is a
 * partition (each activity is in exactly one lane); staleness is layered ON TOP of the
 * folded status, never a second status code path.
 */
export function laneFor(view: ActivityView, opts?: { stale?: boolean }): Lane {
  if (view.status === "closed") return "closed";
  if (opts?.stale) return "idle";
  return "active";
}

/** Default layout per lane: Active → cards, Closed/Idle → table (R-13). */
export const DEFAULT_LAYOUT: Record<Lane, "cards" | "table"> = {
  active: "cards",
  idle: "table",
  closed: "table",
};

/**
 * Render a grid of cards. `opts.expanded(model)` decides each card's default
 * expansion (defaults to: expanded iff not closed). Empty list → an empty-state note.
 */
export function renderGrid(
  models: CardModel[],
  opts?: { expanded?: (m: CardModel) => boolean },
): string {
  if (models.length === 0) {
    return `<div class="fd-grid fd-grid-empty">no activities</div>`;
  }
  const cards = models
    .map((m) => renderCard(m, { expanded: opts?.expanded ? opts.expanded(m) : m.view.status !== "closed" }))
    .join("");
  return `<div class="fd-grid">${cards}</div>`;
}
