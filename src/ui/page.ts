// Page assembly + SSE hub (Dev Spec R-11 / R-12 / S3.1 / #868).
//
// `renderPage()` is the full standalone HTML document served at `/`; `renderBoard()`
// is the swappable inner fragment pushed over SSE. The `UiHub` owns the set of
// connected Server-Sent-Events writers and broadcasts a freshly-rendered board after
// every ingest, so the console updates live with no manual refresh and no polling
// (prior art: cc scripts/wave-watcher/server.ts). Vanilla client, no framework, no
// bundler — the client is a ~50-line inline script that swaps `#board` innerHTML and
// re-applies the operator's toggle/expand prefs (handlers are event-delegated on
// `document`, so they survive each innerHTML swap).
//
// PURE CONSUMER: models are built from the store's fold + metrics/eta derivations;
// nothing here recomputes status.

import { computeEta } from "../eta.ts";
import type { ActivityView } from "../fold.ts";
import { LOGO_DATA_URI, ORG_NAME } from "./brand.ts";
import { BUILD_INFO } from "../version.ts";
import { deriveMetrics } from "../metrics.ts";
import type { Store } from "../store.ts";
import { ageMs, resolveStaleMs, stalenessPredicate } from "../watcher.ts";
import type { CardModel } from "./card.ts";
import { buildConcernQueue, renderConcernQueue } from "./concern_queue.ts";
import { DEFAULT_LAYOUT, type Lane, laneFor, renderGrid } from "./grid.ts";
import { escapeHtml, resolveDisplay } from "./format.ts";
import { LOG_ANCHOR_ID, type LogScope, renderLogViewer } from "./log_viewer.ts";
import { buildPresence, renderPresenceStrip } from "./presence.ts";
import { renderTable } from "./table.ts";

/** Build a CardModel per activity: folded view + its derived metrics + split ETA.
 *  `views` narrows which activities get models (#7: sessions/synthetic never need
 *  metrics or an ETA); default remains every activity in the store. */
export function buildCardModels(store: Store, views?: ActivityView[]): CardModel[] {
  const events = store.allEvents();
  return (views ?? store.getView()).map((view) => {
    const evs = events.filter((e) => e.activityId === view.activityId);
    const metrics = deriveMetrics(evs);
    const eta = computeEta(view, metrics);
    return { view, metrics, eta };
  });
}

/** Wall-clock inputs for the staleness watcher (S4.1). Injected in tests for a
 *  deterministic clock; the live UI defaults to the real clock + env threshold. */
export interface StalenessOpts {
  /** Epoch ms "now" the watcher compares against. Default: `Date.now()`. */
  now?: number;
  /** Staleness threshold (ms). Default: `resolveStaleMs()` (env / 15 min). */
  staleMs?: number;
}

/**
 * One lane: heading + independent card/table toggle. BOTH representations are in the
 * DOM; CSS keyed on `data-layout` shows exactly one, so the toggle is pure client-side
 * (R-13). `data-layout` starts at the lane's default (Active → cards, Closed → table).
 *
 * `clock` is the SAME injected `(now, isStalled)` pair `renderBoard` used for lane
 * ROUTING, threaded one layer further down so each card/row can report its own
 * staleness (AX-5) — the lane heading says the SECTION is stale-as-a-group; this is
 * the per-activity marker the axiom also requires ("look different at a glance",
 * not only "sits in a different section").
 */
function renderLane(
  lane: Lane,
  models: CardModel[],
  clock: { now: number; isStalled: (v: ActivityView) => boolean },
): string {
  if (models.length === 0) return "";
  // AX-2/AX-3 (#35): report how many of this lane's activities could not be
  // attributed to an agent. Without a tally the condition becomes invisible-normal
  // — 61% unattributed currently looks like a board full of named things.
  const unattributed = models.filter((m) => !resolveDisplay(m.view).attributed).length;
  // AX-2 (#31): same reasoning for headless — without a lane-visible tally, a card
  // missing its lifecycle head is indistinguishable from a normal one at a glance,
  // which is exactly the "check that can't fail" shape the axiom forbids.
  const headless = models.filter((m) => m.view.activityType === "headless").length;
  return (
    `<section class="fd-lane" data-lane="${lane}" data-layout="${DEFAULT_LAYOUT[lane]}">` +
    `<div class="fd-lane-head"><h2>${escapeHtml(lane)}</h2>` +
    `<span class="fd-lane-count">${models.length}</span>` +
    (unattributed > 0
      ? `<span class="fd-unattributed" title="no agent identified on any event for these activities">${unattributed} unattributed</span>`
      : "") +
    (headless > 0
      ? `<span class="fd-headless-count" title="no event on these activities has declared a campaign/float type">${headless} headless</span>`
      : "") +
    `<button class="fd-lane-toggle" data-action="toggle-layout" data-lane="${lane}">cards ⇄ table</button>` +
    `</div>` +
    `<div class="fd-lane-cards">${renderGrid(models, {
      clock: (m) => ({ stale: clock.isStalled(m.view), ageMs: ageMs(m.view, clock.now) }),
    })}</div>` +
    `<div class="fd-lane-table">${renderTable(models, {
      clock: (m) => ({ stale: clock.isStalled(m.view), ageMs: ageMs(m.view, clock.now) }),
    })}</div>` +
    `</section>`
  );
}

/**
 * The swappable board fragment (inner HTML of `#board`). Activities are grouped into
 * lanes (Active → cards, Idle/Closed → table by default), each independently toggled.
 * The P4 staleness watcher supplies the wall-clock "stale" signal used both to light
 * the Idle lane AND to sort stalled-with-open-concerns to the top of the global queue
 * (R-21/R-22) — one predicate, injected here, so the pure fold stays clock-free.
 */
export function renderBoard(store: Store, opts?: StalenessOpts): string {
  // Partition (#7): synthetic activities (test residue, `detail.synthetic`) are
  // filtered off the board entirely; session activities render as the agent-presence
  // strip, never as campaign cards; everything else goes to the lanes as before.
  const visible = store.getView().filter((v) => !v.synthetic);
  if (visible.length === 0) return `<div class="fd-empty">no activities</div>`;
  const sessionViews = visible.filter((v) => v.activityType === "session");
  const models = buildCardModels(store, visible.filter((v) => v.activityType !== "session"));
  const now = opts?.now ?? Date.now();
  const staleMs = opts?.staleMs ?? resolveStaleMs();
  const isStalled = stalenessPredicate(now, staleMs);
  const presence = renderPresenceStrip(buildPresence(sessionViews, { now, staleMs }));
  // Global concern queue (centerpiece) folds concerns across all LANE activities —
  // sessions and synthetic are deliberately excluded by the partition above (#7):
  // sessions carry no concerns by construction, and synthetic residue must never
  // surface in the queue. The P4 predicate replaces the queue's default (blocked)
  // with real wall-clock staleness.
  const concerns = renderConcernQueue(
    buildConcernQueue(models.map((m) => m.view), { isStalled }),
  );
  const byLane = new Map<Lane, CardModel[]>();
  for (const m of models) {
    const lane = laneFor(m.view, { stale: isStalled(m.view) });
    const arr = byLane.get(lane);
    if (arr) arr.push(m);
    else byLane.set(lane, [m]);
  }
  const lane = (l: Lane) => renderLane(l, byLane.get(l) ?? [], { now, isStalled });
  // Board order (#10): presence, Active, THEN the concern queue, then Idle/Closed —
  // the queue sits between what is moving and what has stalled.
  return presence + lane("active") + concerns + lane("idle") + lane("closed");
}

// Cyberpunk theme (#10): committed dark, neon status accents. Text-contrast of
// every accent vs the surface computed at ≥4.5:1 (WCAG AA small text); status is
// never color-alone (badges/chips always carry words). Layout rules unchanged.
const STYLES = `
:root { color-scheme: dark; --gap: 12px; --radius: 10px;
  --bg: #0b0e1a; --panel: #101426; --line: #2a3152;
  --ink: #e6ecff; --muted: #97a0c0;
  --cyan: #00e5ff; --magenta: #ff2d95; --violet: #7aa2ff;
  --amber: #ffb200; --red: #ff3860; --dim: #8892b0; }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.45 ui-sans-serif, system-ui, sans-serif; background: var(--bg); color: var(--ink); }
.fd-topbar { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--line); background: linear-gradient(180deg, #10142688, transparent); }
.fd-topbar h1 { font-size: 15px; margin: 0; letter-spacing: .08em; text-transform: uppercase; color: var(--cyan); text-shadow: 0 0 10px #00e5ff55; }
/* Oak & Wave branding (#14): logo + gradient wordmark echoing the badge's cyan→magenta */
.fd-logo { height: 32px; width: auto; display: block; filter: drop-shadow(0 0 6px #00e5ff33); }
.fd-brand { font-size: 13px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--cyan); }
@supports ((background-clip: text) or (-webkit-background-clip: text)) {
  .fd-brand { background: linear-gradient(90deg, var(--cyan), var(--magenta)); -webkit-background-clip: text; background-clip: text; color: transparent; }
}
.fd-brand-sep { color: var(--muted); opacity: .5; }
/* Build badge (#24): the deployed version, always visible so an operator can
   report what they are looking at without shell access to the Swarm manager.
   margin-left:auto pins it right; it is deliberately quiet — this is
   reference data, not a status signal competing with the live dot. */
.fd-build { margin-left: auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; letter-spacing: .04em; color: var(--muted); white-space: nowrap; }
.fd-build .fd-build-sha { opacity: .65; }
.fd-live { font-size: 11px; color: var(--cyan); text-shadow: 0 0 6px #00e5ff77; }
main { padding: 16px; }
.fd-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: var(--gap); }
.fd-grid-empty { color: var(--muted); padding: 24px; }
.fd-card { border: 1px solid var(--line); border-radius: var(--radius); padding: 12px; display: flex; flex-direction: column; gap: 8px; background: var(--panel); }
.fd-card[data-status="active"] { border-color: #00e5ff44; box-shadow: 0 0 12px #00e5ff14; }
.fd-card[data-status="blocked"] { border-color: #ff2d9566; box-shadow: 0 0 12px #ff2d9522; }
/* Staleness (AX-5) is reported ON THE CARD, not just by which lane it lands in.
   Rides outline — a property none of the data-status rules above touch — so it
   genuinely layers rather than overwriting a blocked/active card's own border-color
   (review finding: border-color/box-shadow both collide with the status rules
   above and would silently erase the higher-priority "blocked on you" signal the
   moment that same card also goes stale). */
.fd-card[data-stale="true"] { outline: 2px solid var(--amber); outline-offset: 2px; }
.fd-card-age { font-size: 11px; color: var(--muted); white-space: nowrap; }
.fd-card-age[data-stale="true"] { color: var(--amber); }
/* AX-2: the age chip's own named holes (unparseable timestamp / clock skew) — same
   de-emphasised-italic treatment as .fd-progress-headless. */
.fd-card-age-hole, .fd-row-lastevent-hole { font-style: italic; color: var(--muted); }
.fd-row[data-stale="true"] { background: #ffb20014; }
.fd-row-lastevent[data-stale="true"] { color: var(--amber); }
.fd-card-head { display: flex; align-items: center; gap: 8px; }
.fd-card-title { font-weight: 600; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* AX-3 (#35): an id standing in for an agent name is NOT a name. De-emphasised,
   italic, and dotted-underlined so it reads as a placeholder at a glance — the
   text stays visible because it is how an operator finds the activity. */
.fd-card-title[data-attributed="false"],
.fd-row-title[data-attributed="false"],
.fd-presence-agent[data-attributed="false"] {
  font-weight: 400; font-style: italic; color: var(--muted);
  text-decoration: underline dotted var(--line); text-underline-offset: 3px;
}
/* Never colour-alone: the house rule for status is that it carries a word. The
   title attribute itself is spoken for by #10 untouched-full-value contract,
   so the word rides a marker element instead. */
.fd-card-title[data-attributed="false"]::after,
.fd-row-title[data-attributed="false"]::after,
.fd-presence-agent[data-attributed="false"]::after {
  content: " · unattributed"; font-style: normal; font-size: 10px;
  color: var(--amber); letter-spacing: 0.04em;
}
.fd-concern-agent { font-size: 11px; color: var(--muted); }
.fd-concern-agent[data-attributed="false"] { font-style: italic; opacity: 0.75; }
/* The unattributed tally. AX-2: a hole nothing counts is a hole nobody fixes. */
.fd-unattributed { font-size: 11px; color: var(--amber); margin-left: 8px; }
/* The headless tally (#31) and its per-card progress hole — same AX-2 treatment. */
.fd-headless-count { font-size: 11px; color: var(--amber); margin-left: 8px; }
.fd-progress-headless { font-style: italic; color: var(--muted); }
.fd-badge { font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); }
.fd-badge-status[data-status="active"] { color: var(--cyan); border-color: var(--cyan); text-shadow: 0 0 6px #00e5ff55; }
.fd-badge-status[data-status="blocked"] { color: var(--magenta); border-color: var(--magenta); text-shadow: 0 0 6px #ff2d9555; }
.fd-badge-status[data-status="ci-wait"] { color: var(--violet); border-color: var(--violet); }
.fd-badge-status[data-status="closed"] { color: var(--dim); border-color: var(--line); }
.fd-card-toggle { background: none; border: none; cursor: pointer; font-size: 14px; color: inherit; padding: 0 4px; }
.fd-vitals { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.fd-progress { font-variant-numeric: tabular-nums; }
.fd-estimator-label { color: var(--muted); }
.fd-eta { display: inline-flex; gap: 10px; font-variant-numeric: tabular-nums; }
.fd-eta-blocked { color: var(--magenta); }
.fd-chip { font-size: 11px; padding: 1px 7px; border-radius: 999px; }
.fd-chip-concern { color: var(--red); border: 1px solid var(--red); text-shadow: 0 0 6px #ff386055; }
.fd-metrics-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; border-top: 1px solid var(--line); padding-top: 8px; }
.fd-card[data-expanded="false"] .fd-metrics-grid,
.fd-card[data-expanded="false"] .fd-eta-strip { display: none; }
.fd-metric { display: flex; flex-direction: column; }
.fd-metric-label { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
.fd-metric-value { font-variant-numeric: tabular-nums; }
/* per-lane card/table switch (S3.2) */
.fd-lane { margin-bottom: 20px; }
.fd-lane-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.fd-lane-head h2 { font-size: 13px; margin: 0; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
.fd-lane[data-lane="active"] .fd-lane-head h2 { color: var(--cyan); text-shadow: 0 0 8px #00e5ff44; }
/* Idle lane (P4 stale-but-open) reads distinct — neon amber. */
.fd-lane[data-lane="idle"] .fd-lane-head h2 { color: var(--amber); text-shadow: 0 0 8px #ffb20044; }
.fd-lane[data-lane="idle"] .fd-lane-count { color: var(--amber); }
.fd-lane-toggle { font-size: 11px; cursor: pointer; background: none; border: 1px solid var(--line); border-radius: 6px; padding: 2px 8px; color: inherit; }
.fd-lane-toggle:hover { border-color: var(--cyan); color: var(--cyan); }
.fd-lane[data-layout="cards"] .fd-lane-table { display: none; }
.fd-lane[data-layout="table"] .fd-lane-cards { display: none; }
.fd-table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.fd-table th, .fd-table td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--line); font-weight: 400; }
.fd-table th { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
/* global concern queue (S3.3) — sits between Active and Idle (#10) */
.fd-concerns { border: 1px solid #ff386066; border-radius: var(--radius); padding: 12px; margin-bottom: 20px; background: #ff38600a; box-shadow: 0 0 14px #ff386011; }
.fd-concerns h2 { font-size: 13px; margin: 0 0 8px; text-transform: uppercase; letter-spacing: .05em; color: var(--red); text-shadow: 0 0 8px #ff386044; }
/* clear-all seen-watermark (#12): header row + dimmed seen rows (client-only state) */
.fd-concerns-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.fd-concerns-head h2 { margin: 0; }
.fd-concern-clear:hover { border-color: var(--red); color: var(--red); }
.fd-concern-row.is-seen { opacity: .35; }
/* scrollable rows container (#10): ~6 rows visible (row ≈ 31px), scroll — never truncate */
.fd-concern-rows { max-height: 188px; overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--line) transparent; }
.fd-concern-rows::-webkit-scrollbar { width: 8px; }
.fd-concern-rows::-webkit-scrollbar-thumb { background: var(--line); border-radius: 4px; }
.fd-concern-row { display: flex; align-items: baseline; gap: 10px; padding: 5px 0; border-top: 1px solid var(--line); }
.fd-concern-row.is-stalled { background: #ff38601a; }
.fd-concern-kind { font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--line); }
.fd-scope-link { font-size: 12px; color: var(--violet); text-decoration: none; border-bottom: 1px dotted currentColor; }
.fd-empty { color: var(--muted); }
/* agent-presence strip (#7): sessions are presence chips, not campaign cards */
.fd-presence { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 10px 12px; border: 1px solid #00e5ff33; border-radius: var(--radius); margin-bottom: 20px; background: #00e5ff08; }
.fd-presence h2 { font-size: 13px; margin: 0; text-transform: uppercase; letter-spacing: .05em; color: var(--cyan); text-shadow: 0 0 8px #00e5ff44; }
.fd-presence-chip { display: inline-flex; gap: 6px; align-items: baseline; font-size: 12px; border: 1px solid var(--line); border-radius: 999px; padding: 2px 10px; background: var(--panel); }
.fd-presence-chip[data-stale="true"] { color: var(--amber); border-color: var(--amber); }
.fd-presence-agent { font-weight: 600; }
/* The presence roster's own unattributed tally (#38) — same AX-2 treatment as
   .fd-unattributed / .fd-headless-count. */
.fd-presence-unattributed { font-size: 11px; color: var(--amber); }
.fd-presence-count { font-variant-numeric: tabular-nums; color: var(--cyan); }
.fd-presence-stalecount { color: var(--amber); }
.fd-presence-host, .fd-presence-last { color: var(--muted); }
.fd-presence-last[data-stale="true"] { color: var(--amber); }
/* #51: the presence chip's own named holes (unparseable timestamp / clock
   skew), same de-emphasised-italic treatment as .fd-card-age-hole /
   .fd-row-lastevent-hole. */
.fd-presence-last-hole { font-style: italic; }
/* split-ETA headline strip (S3.4) */
.fd-eta-strip { display: flex; gap: 24px; align-items: flex-end; padding: 12px 0; }
.fd-eta-figure { display: flex; flex-direction: column; }
.fd-eta-figure .fd-eta-cap { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
.fd-eta-figure .fd-eta-big { font-size: 22px; font-variant-numeric: tabular-nums; }
.fd-eta-figure.blocked .fd-eta-big { color: var(--magenta); text-shadow: 0 0 8px #ff2d9544; }
/* scoped log viewer (S3.5) */
.fd-log { font-family: ui-monospace, monospace; font-size: 12px; }
.fd-log-line { padding: 2px 0; border-bottom: 1px solid var(--line); white-space: pre-wrap; }
.fd-log-line.is-anchored { background: #ffb20026; border-left: 3px solid var(--amber); padding-left: 6px; scroll-margin-top: 40px; }
.fd-log-anchor-ref { font-size: 11px; color: var(--muted); border: 1px solid var(--amber); border-radius: 6px; padding: 1px 6px; }
.fd-log-empty { color: var(--muted); }
`;

// Scroll the logRef-anchored line into view on the scoped log page. No framework —
// a one-liner that no-ops when nothing is anchored (matches the vanilla-client rule).
const LOG_SCROLL_SCRIPT =
  `var a=document.getElementById('${LOG_ANCHOR_ID}');` +
  `if(a){a.scrollIntoView({block:'center'});}`;

// Framework-free live client. No backticks / no ${...} inside, so it embeds safely
// in the template literal below. Handlers are delegated on `document` and prefs are
// re-applied after each SSE swap so toggle/expand state survives live updates.
const CLIENT_SCRIPT = `
(function () {
  var board = document.getElementById('board');
  if (!board) return;
  var expandOverride = {}; // activityId -> 'true' | 'false'
  var laneLayout = {};     // lane -> 'cards' | 'table'
  // Concern seen-watermark (#12): an ISO ts in localStorage. Rows at-or-before it
  // dim (.is-seen); newer concerns render bright. Client-only presentation state —
  // nothing is deleted, other viewers are unaffected. localStorage (not the
  // in-memory prefs) so a clear survives reloads; a clear that forgets on refresh
  // would be useless.
  var CONCERN_SEEN_KEY = 'fd-concern-seen-watermark';

  function applyConcernWatermark() {
    var wm = '';
    try { wm = localStorage.getItem(CONCERN_SEEN_KEY) || ''; } catch (e) { /* storage blocked ⇒ no-op */ }
    if (!wm) return;
    var rows = board.querySelectorAll('.fd-concern-row[data-ts]');
    for (var i = 0; i < rows.length; i++) {
      var ts = rows[i].getAttribute('data-ts') || '';
      if (ts && ts <= wm) rows[i].classList.add('is-seen');
      else rows[i].classList.remove('is-seen');
    }
  }

  function applyPrefs() {
    var cards = board.querySelectorAll('.fd-card');
    for (var i = 0; i < cards.length; i++) {
      var id = cards[i].getAttribute('data-activity-id');
      if (Object.prototype.hasOwnProperty.call(expandOverride, id)) {
        cards[i].setAttribute('data-expanded', expandOverride[id]);
      }
    }
    var lanes = board.querySelectorAll('.fd-lane');
    for (var j = 0; j < lanes.length; j++) {
      var lane = lanes[j].getAttribute('data-lane');
      if (Object.prototype.hasOwnProperty.call(laneLayout, lane)) {
        lanes[j].setAttribute('data-layout', laneLayout[lane]);
      }
    }
    applyConcernWatermark(); // re-dim after every SSE swap (#12)
  }
  applyConcernWatermark(); // and once on the initial server render

  document.addEventListener('click', function (ev) {
    var t = ev.target;
    if (!t || !t.closest) return;
    var expBtn = t.closest('[data-action="toggle-expand"]');
    if (expBtn) {
      var card = expBtn.closest('.fd-card');
      if (card) {
        var id = card.getAttribute('data-activity-id');
        var next = card.getAttribute('data-expanded') === 'true' ? 'false' : 'true';
        card.setAttribute('data-expanded', next);
        expandOverride[id] = next;
      }
      return;
    }
    var layBtn = t.closest('[data-action="toggle-layout"]');
    if (layBtn) {
      var laneEl = layBtn.closest('.fd-lane');
      if (laneEl) {
        var lane = laneEl.getAttribute('data-lane');
        var nl = laneEl.getAttribute('data-layout') === 'cards' ? 'table' : 'cards';
        laneEl.setAttribute('data-layout', nl);
        laneLayout[lane] = nl;
      }
      return;
    }
    var clearBtn = t.closest('[data-action="clear-concerns"]');
    if (clearBtn) {
      // Watermark = the newest concern currently rendered (ISO strings compare
      // lexicographically). Everything at-or-before it dims; new arrivals pop.
      var rows = board.querySelectorAll('.fd-concern-row[data-ts]');
      var max = '';
      for (var k = 0; k < rows.length; k++) {
        var rts = rows[k].getAttribute('data-ts') || '';
        if (rts > max) max = rts;
      }
      // Monotonic (review): a stale tab (dropped SSE, replayed log) renders an
      // older max — never let its click move the stored watermark backwards.
      var stored = '';
      try { stored = localStorage.getItem(CONCERN_SEEN_KEY) || ''; } catch (e) { /* storage blocked */ }
      if (max && max > stored) {
        try { localStorage.setItem(CONCERN_SEEN_KEY, max); } catch (e) { /* storage blocked ⇒ session-only no-op */ }
        applyConcernWatermark();
      }
      return;
    }
  });

  // Live blocked-on-you tick: cards currently blocked accrue wall time since load.
  // Match BOTH ETA variants — the inline card figure (.fd-eta .fd-eta-blocked) AND the
  // headline strip figure (.fd-eta-strip .fd-eta-blocked) — via the data-blocked-ms
  // marker both carry, so the big headline figure ticks live too (eta_strip.ts).
  var loadedAt = Date.now();
  setInterval(function () {
    var els = board.querySelectorAll('.fd-card[data-status="blocked"] .fd-eta-blocked[data-blocked-ms]');
    for (var i = 0; i < els.length; i++) {
      var base = parseInt(els[i].getAttribute('data-blocked-ms') || '0', 10);
      var live = base + (Date.now() - loadedAt);
      var secs = Math.floor(live / 1000);
      var mins = Math.floor(secs / 60);
      var hrs = Math.floor(mins / 60);
      // Day tier mirrors format.ts's formatDuration (code review: a blocked-on-you
      // card left open past 24h used to render the server's "1d 6h" on load, then
      // silently rewrite to an hour-pile like "30h 12m" one second later — the exact
      // unreadable shape the server-side day tier exists to avoid).
      var txt = mins < 1 ? secs + 's' : (mins < 60 ? mins + 'm' : (hrs < 24 ? hrs + 'h ' + (mins % 60) + 'm' : Math.floor(hrs / 24) + 'd ' + (hrs % 24) + 'h'));
      els[i].textContent = '⏳ ' + txt;
    }
  }, 1000);

  function onFrame(e) {
    try {
      var data = JSON.parse(e.data);
      if (data && typeof data.board === 'string') {
        // Preserve concern-queue scroll across the swap (#10): innerHTML recreates
        // the .fd-concern-rows container, which would reset scrollTop to 0 on every
        // ingest — precisely when >6 concerns make the queue scrollable. Same
        // capture/re-apply pattern as expandOverride/laneLayout above.
        var rowsEl = board.querySelector('.fd-concern-rows');
        var rowsScroll = rowsEl ? rowsEl.scrollTop : 0;
        board.innerHTML = data.board;
        loadedAt = Date.now();
        applyPrefs();
        rowsEl = board.querySelector('.fd-concern-rows');
        if (rowsEl && rowsScroll > 0) rowsEl.scrollTop = rowsScroll;
      }
    } catch (err) { /* ignore malformed frame */ }
  }
  var es = new EventSource('/events');
  es.addEventListener('board', onFrame);
  es.addEventListener('snapshot', onFrame);
  es.onmessage = onFrame;
})();
`;

/** Build badge (#24) — which build is this?
 *
 *  Rendered into the topbar, which sits OUTSIDE `#board`, so it survives SSE
 *  frame swaps and ships once per page load. The `title` carries the full SHA
 *  and process start for anyone reporting a problem; the visible text stays
 *  short so it never crowds the live dot on a narrow viewport. */
function renderBuildBadge(): string {
  const { version, gitSha, shortSha, startedAt } = BUILD_INFO;
  const detail = `build ${version} · commit ${gitSha} · up since ${startedAt}`;
  // Only prefix "v" when the value actually looks like a version. An image built
  // outside the release workflow reports the literal "dev" (Dockerfile ARG
  // default), and "vdev" reads like a typo rather than the honest signal it is.
  const label = /^\d/.test(version) ? `v${version}` : version;
  return (
    `<span class="fd-build" title="${escapeHtml(detail)}">` +
    `${escapeHtml(label)}` +
    `<span class="fd-build-sha"> ${escapeHtml(shortSha)}</span>` +
    `</span>`
  );
}

/** Shared branded topbar (#14): O&W logo + wordmark + the FlightDeck product
 *  title, then a page-specific tail (live dot / back link). Sits OUTSIDE `#board`,
 *  so SSE swaps never resend the inlined logo bytes. */
function renderTopbar(tail: string): string {
  return (
    `<div class="fd-topbar">` +
    // alt="" — decorative: the wordmark span right after it carries the name, so
    // assistive tech reads "Oak & Wave" once, not "Oak & Wave logo, Oak & Wave".
    `<img class="fd-logo" src="${LOGO_DATA_URI}" alt="">` +
    `<span class="fd-brand">${escapeHtml(ORG_NAME)}</span>` +
    `<span class="fd-brand-sep">//</span>` +
    `<h1>FlightDeck</h1>` +
    renderBuildBadge() +
    tail +
    `</div>`
  );
}

/** The full standalone HTML document served at `/`. */
export function renderPage(store: Store): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>FlightDeck</title><style>${STYLES}</style></head><body>` +
    renderTopbar(`<span class="fd-live">● live</span>`) +
    `<main id="board">${renderBoard(store)}</main>` +
    `<script>${CLIENT_SCRIPT}</script>` +
    `</body></html>`
  );
}

/**
 * The scoped log-viewer page served at `/log` (concern-queue click-through target).
 * `logRef` (carried in the link alongside the scope tags) pins/highlights the exact
 * referenced event within the scoped transcript and scrolls it into view (R-15).
 */
export function renderLogPage(store: Store, scope: LogScope, logRef?: string | null): string {
  const viewer = renderLogViewer(store.allEvents(), scope, logRef);
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>FlightDeck — log</title><style>${STYLES}</style></head><body>` +
    renderTopbar(`<a class="fd-scope-link" href="/">← board</a>`) +
    `<main>${viewer}</main>` +
    `<script>${LOG_SCROLL_SCRIPT}</script>` +
    `</body></html>`
  );
}

/**
 * Owns the connected SSE writers and broadcasts the board after every ingest.
 * Kept out of `handleRequest` (which stays pure over its config) so the socket set
 * is a single long-lived object created by `createServer`.
 */
export class UiHub {
  readonly store: Store;
  readonly clients = new Set<WritableStreamDefaultWriter<Uint8Array>>();
  private readonly encoder = new TextEncoder();

  constructor(store: Store) {
    this.store = store;
  }

  /** SSE frame carrying the freshly-rendered board, JSON-encoded onto one line. */
  boardFrame(eventName: "board" | "snapshot" = "board"): string {
    return `event: ${eventName}\ndata: ${JSON.stringify({ board: renderBoard(this.store) })}\n\n`;
  }

  /** Register a new client: flush headers, then hand it a snapshot immediately. */
  addClient(writer: WritableStreamDefaultWriter<Uint8Array>): void {
    this.clients.add(writer);
    // Prune (don't leak an unhandled rejection) if the client drops mid-snapshot —
    // same defensive pattern as broadcast()/removeClient().
    const prune = () => {
      this.clients.delete(writer);
    };
    void writer.write(this.encoder.encode(": hello\n\n")).catch(prune);
    void writer.write(this.encoder.encode(this.boardFrame("snapshot"))).catch(prune);
  }

  removeClient(writer: WritableStreamDefaultWriter<Uint8Array>): void {
    this.clients.delete(writer);
    void writer.close().catch(() => {});
  }

  /** Push the current board to every connected client (called after each ingest). */
  broadcast(): void {
    const payload = this.encoder.encode(this.boardFrame("board"));
    for (const client of this.clients) {
      void client.write(payload).catch(() => {
        this.clients.delete(client);
      });
    }
  }
}
