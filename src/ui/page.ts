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
import { deriveMetrics } from "../metrics.ts";
import type { Store } from "../store.ts";
import { resolveStaleMs, stalenessPredicate } from "../watcher.ts";
import type { CardModel } from "./card.ts";
import { buildConcernQueue, renderConcernQueue } from "./concern_queue.ts";
import { DEFAULT_LAYOUT, type Lane, laneFor, renderGrid } from "./grid.ts";
import { escapeHtml } from "./format.ts";
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

const LANE_ORDER: Lane[] = ["active", "idle", "closed"];

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
 */
function renderLane(lane: Lane, models: CardModel[]): string {
  if (models.length === 0) return "";
  return (
    `<section class="fd-lane" data-lane="${lane}" data-layout="${DEFAULT_LAYOUT[lane]}">` +
    `<div class="fd-lane-head"><h2>${escapeHtml(lane)}</h2>` +
    `<span class="fd-lane-count">${models.length}</span>` +
    `<button class="fd-lane-toggle" data-action="toggle-layout" data-lane="${lane}">cards ⇄ table</button>` +
    `</div>` +
    `<div class="fd-lane-cards">${renderGrid(models)}</div>` +
    `<div class="fd-lane-table">${renderTable(models)}</div>` +
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
  const lanes = LANE_ORDER.map((lane) => renderLane(lane, byLane.get(lane) ?? [])).join("");
  return presence + concerns + lanes;
}

const STYLES = `
:root { color-scheme: light dark; --gap: 12px; --radius: 10px; --line: #8883; }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.45 ui-sans-serif, system-ui, sans-serif; }
.fd-topbar { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--line); }
.fd-topbar h1 { font-size: 15px; margin: 0; letter-spacing: .02em; }
.fd-live { font-size: 11px; opacity: .7; }
main { padding: 16px; }
.fd-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: var(--gap); }
.fd-grid-empty { opacity: .6; padding: 24px; }
.fd-card { border: 1px solid var(--line); border-radius: var(--radius); padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.fd-card-head { display: flex; align-items: center; gap: 8px; }
.fd-card-title { font-weight: 600; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fd-badge { font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--line); opacity: .85; }
.fd-badge-status[data-status="blocked"] { color: #d9822b; border-color: #d9822b; }
.fd-badge-status[data-status="ci-wait"] { color: #3b82f6; border-color: #3b82f6; }
.fd-badge-status[data-status="closed"] { opacity: .55; }
.fd-card-toggle { background: none; border: none; cursor: pointer; font-size: 14px; color: inherit; padding: 0 4px; }
.fd-vitals { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.fd-progress { font-variant-numeric: tabular-nums; }
.fd-estimator-label { opacity: .6; }
.fd-eta { display: inline-flex; gap: 10px; font-variant-numeric: tabular-nums; }
.fd-eta-blocked { color: #d9822b; }
.fd-chip { font-size: 11px; padding: 1px 7px; border-radius: 999px; }
.fd-chip-concern { color: #dc2626; border: 1px solid #dc2626; }
.fd-metrics-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; border-top: 1px solid var(--line); padding-top: 8px; }
.fd-card[data-expanded="false"] .fd-metrics-grid,
.fd-card[data-expanded="false"] .fd-eta-strip { display: none; }
.fd-metric { display: flex; flex-direction: column; }
.fd-metric-label { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; opacity: .55; }
.fd-metric-value { font-variant-numeric: tabular-nums; }
/* per-lane card/table switch (S3.2) */
.fd-lane { margin-bottom: 20px; }
.fd-lane-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.fd-lane-head h2 { font-size: 13px; margin: 0; text-transform: uppercase; letter-spacing: .05em; opacity: .7; }
/* Idle lane (P4 stale-but-open) reads distinct from Active/Closed — amber, like blocked. */
.fd-lane[data-lane="idle"] .fd-lane-head h2 { color: #d9822b; opacity: .9; }
.fd-lane[data-lane="idle"] .fd-lane-count { color: #d9822b; }
.fd-lane-toggle { font-size: 11px; cursor: pointer; background: none; border: 1px solid var(--line); border-radius: 6px; padding: 2px 8px; color: inherit; }
.fd-lane[data-layout="cards"] .fd-lane-table { display: none; }
.fd-lane[data-layout="table"] .fd-lane-cards { display: none; }
.fd-table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.fd-table th, .fd-table td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--line); font-weight: 400; }
.fd-table th { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; opacity: .55; }
/* global concern queue (S3.3) */
.fd-concerns { border: 1px solid #dc262655; border-radius: var(--radius); padding: 12px; margin-bottom: 20px; }
.fd-concerns h2 { font-size: 13px; margin: 0 0 8px; text-transform: uppercase; letter-spacing: .05em; }
.fd-concern-row { display: flex; align-items: baseline; gap: 10px; padding: 5px 0; border-top: 1px solid var(--line); }
.fd-concern-row.is-stalled { background: #dc26260f; }
.fd-concern-kind { font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--line); }
.fd-scope-link { font-size: 12px; opacity: .8; text-decoration: none; border-bottom: 1px dotted currentColor; }
.fd-empty { opacity: .55; }
/* agent-presence strip (#7): sessions are presence chips, not campaign cards */
.fd-presence { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--radius); margin-bottom: 20px; }
.fd-presence h2 { font-size: 13px; margin: 0; text-transform: uppercase; letter-spacing: .05em; opacity: .7; }
.fd-presence-chip { display: inline-flex; gap: 6px; align-items: baseline; font-size: 12px; border: 1px solid var(--line); border-radius: 999px; padding: 2px 10px; }
.fd-presence-chip[data-stale="true"] { color: #d9822b; border-color: #d9822b; }
.fd-presence-agent { font-weight: 600; }
.fd-presence-count { font-variant-numeric: tabular-nums; }
.fd-presence-stalecount { color: #d9822b; }
.fd-presence-host, .fd-presence-last { opacity: .6; }
/* split-ETA headline strip (S3.4) */
.fd-eta-strip { display: flex; gap: 24px; align-items: flex-end; padding: 12px 0; }
.fd-eta-figure { display: flex; flex-direction: column; }
.fd-eta-figure .fd-eta-cap { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; opacity: .55; }
.fd-eta-figure .fd-eta-big { font-size: 22px; font-variant-numeric: tabular-nums; }
.fd-eta-figure.blocked .fd-eta-big { color: #d9822b; }
/* scoped log viewer (S3.5) */
.fd-log { font-family: ui-monospace, monospace; font-size: 12px; }
.fd-log-line { padding: 2px 0; border-bottom: 1px solid var(--line); white-space: pre-wrap; }
.fd-log-line.is-anchored { background: #f59e0b22; border-left: 3px solid #d9822b; padding-left: 6px; scroll-margin-top: 40px; }
.fd-log-anchor-ref { font-size: 11px; opacity: .7; border: 1px solid #d9822b; border-radius: 6px; padding: 1px 6px; }
.fd-log-empty { opacity: .55; }
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
  }

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
      var txt = mins < 1 ? secs + 's' : (mins < 60 ? mins + 'm' : Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm');
      els[i].textContent = '⏳ ' + txt;
    }
  }, 1000);

  function onFrame(e) {
    try {
      var data = JSON.parse(e.data);
      if (data && typeof data.board === 'string') {
        board.innerHTML = data.board;
        loadedAt = Date.now();
        applyPrefs();
      }
    } catch (err) { /* ignore malformed frame */ }
  }
  var es = new EventSource('/events');
  es.addEventListener('board', onFrame);
  es.addEventListener('snapshot', onFrame);
  es.onmessage = onFrame;
})();
`;

/** The full standalone HTML document served at `/`. */
export function renderPage(store: Store): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>FlightDeck</title><style>${STYLES}</style></head><body>` +
    `<div class="fd-topbar"><h1>FlightDeck</h1><span class="fd-live">● live</span></div>` +
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
    `<div class="fd-topbar"><h1>FlightDeck</h1><a class="fd-scope-link" href="/">← board</a></div>` +
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
