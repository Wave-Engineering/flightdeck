// Split-ETA strip (Dev Spec R-17 / R-18 / S3.4 / #871).
//
// The ETA is presented as TWO structurally independent figures, never merged:
//   • machine-time remaining — how much longer the machine needs;
//   • blocked-on-you — the operator-side counter (live-ticking in the client).
// Merging them would hide the one thing the operator most needs: "am I the
// bottleneck?" This is the single ETA-render code path (both the card vitals and the
// headline strip come through here), consuming eta.ts's `EtaResult` — no re-derivation.

import type { EtaResult } from "../eta.ts";
import { escapeHtml, formatDuration } from "./format.ts";

/**
 * Render the split ETA as two independent figures.
 *   • `variant: "headline"` (default) — the big two-figure strip.
 *   • `variant: "inline"` — the compact form for the card vitals row.
 * The blocked figure carries `data-blocked-ms` so the client can tick it live while
 * an activity is blocked; the machine figure is refreshed on the next SSE frame.
 */
export function renderEtaStrip(eta: EtaResult, opts?: { variant?: "headline" | "inline" }): string {
  const variant = opts?.variant ?? "headline";
  const machine = formatDuration(eta.machineTimeRemainingMs);
  const blocked = formatDuration(eta.blockedOnYouMs);

  if (variant === "inline") {
    return (
      `<span class="fd-eta" data-eta-kind="${escapeHtml(eta.kind)}">` +
      `<span class="fd-eta-machine" title="machine-time remaining">⚙ ${escapeHtml(machine)}</span>` +
      `<span class="fd-eta-blocked" data-blocked-ms="${eta.blockedOnYouMs}" title="blocked on you">` +
      `⏳ ${escapeHtml(blocked)}</span>` +
      `</span>`
    );
  }

  return (
    `<div class="fd-eta-strip" data-eta-kind="${escapeHtml(eta.kind)}">` +
    `<div class="fd-eta-figure machine">` +
    `<span class="fd-eta-cap">machine time remaining</span>` +
    `<span class="fd-eta-big fd-eta-machine">${escapeHtml(machine)}</span>` +
    `</div>` +
    `<div class="fd-eta-figure blocked">` +
    `<span class="fd-eta-cap">blocked on you</span>` +
    `<span class="fd-eta-big fd-eta-blocked" data-blocked-ms="${eta.blockedOnYouMs}">${escapeHtml(blocked)}</span>` +
    `</div>` +
    `</div>`
  );
}
