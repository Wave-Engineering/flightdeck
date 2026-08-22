// Agent-presence strip (#7 / cc-workflow#947 defect 1).
//
// Sessions are PRESENCE, not work: a session activity (the cc-workflow S1.7 hook,
// `activityType: "session"`) renders as one chip in a per-agent roster — never as a
// campaign card. A session has no waves/confidence/drift/tokens, so the card anatomy
// could only ever render `0 / ? waves` noise; the roster shows the one thing a
// session HAS: who is here, on which host, and how fresh. Closed sessions drop off
// the strip entirely (presence shows who is around now; history lives in the log).
//
// PURE CONSUMER: renders from folded ActivityViews plus the injected wall-clock
// (`now`/`staleMs` — the same seam the P4 watcher uses). No `Date.now()`, no
// re-derivation of status; staleness comes from the one `isStalled` predicate.

import type { ActivityView } from "../fold.ts";
import { isStalled } from "../watcher.ts";
import { escapeHtml, formatDuration, resolveDisplay } from "./format.ts";

/** One roster row: an agent identity with its open sessions summarized. */
export interface PresenceModel {
  /** Dev-Name when resolved; else the visible degradation (host, or the session's
   *  own id as a last resort) — resolved via the SAME shared resolver as the card,
   *  table, and concern queue (#38, AX-3), not a second `agent ?? host ?? "unknown"`. */
  agent: string;
  /** True only when `agent` is a real Dev-Name — mirrors `resolveDisplay`'s
   *  contract so the roster can reuse the board's unattributed marking (#38). */
  attributed: boolean;
  /** Distinct hosts seen across the agent's open sessions. */
  hosts: string[];
  /** Open sessions with a fresh event (not stale). */
  active: number;
  /** Open but stale sessions (no event within `staleMs`). */
  stale: number;
  /** Milliseconds since the agent's most recent event, or null if unparseable. */
  lastSeenMs: number | null;
}

/**
 * Group open session views into per-agent presence rows. Closed sessions are
 * dropped; each open one counts as active or stale via the injected clock.
 * Sorted by agent name for a deterministic render.
 */
export function buildPresence(
  views: ActivityView[],
  opts: { now: number; staleMs: number },
): PresenceModel[] {
  const byAgent = new Map<
    string,
    { text: string; hosts: Set<string>; active: number; stale: number; lastTs: number | null; attributed: boolean }
  >();
  for (const v of views) {
    if (v.activityType !== "session" || v.status === "closed") continue;
    // AX-3/#38: resolve through the SAME shared resolver as card/table/concern-queue
    // (#35) instead of reinventing `agent ?? host ?? "unknown"` a second time — that
    // inline duplication is exactly what #35 exists to prevent. Presence's visible
    // degradation is the HOST (the next most identifying fact about a session when no
    // Dev-Name is known), so it rides `resolveDisplay`'s `label` slot; the resolver's
    // own last resort (the session's activityId) covers "neither agent nor host".
    //
    // #38 code review, finding 1: the ONLY session emitter
    // (claudecode-workflow scripts/flightdeck-session-emit.sh:56) does not leave
    // `agent` null when no Dev-Name resolves — it sets `agent="$host"`, the
    // documented (FLIGHTDECK_AXIOMS.md AX-4) pre-#38 degradation. On live data
    // `v.agent` is therefore almost never null, and a resolver keyed only on
    // "is agent null" would fire on essentially nothing. `agent === host` (both
    // present, equal) is that emitter's own signature for "no real identity" — a
    // documented contract read, not a guess (AX-1) — so it is treated exactly like
    // a null agent here. A host-guarded length check (`v.host` may be `""`, #38
    // finding 4) keeps an empty string from masquerading as a match.
    const emitterDegraded = v.agent !== null && v.host !== null && v.host.length > 0 && v.agent === v.host;
    const label = v.host && v.host.length > 0 ? v.host : null;
    const display = resolveDisplay({
      agent: emitterDegraded ? null : v.agent,
      label,
      activityId: v.activityId,
    });
    // #38 code review, finding 2: key on (attributed, text), not text alone. Two
    // DIFFERENT identities can resolve to the same text — a real agent literally
    // named the same as a host, or (post the emitter fix this finding recommends
    // separately) an attributed "malory" and a degraded-to-host "malory" — and
    // keying on text alone would merge them into one row, silently promoting the
    // degraded one or demoting the real one. Exactly AX-4's "no identity fallback
    // may collide."
    const key = `${display.attributed ? "attr" : "anon"}:${display.text}`;
    let g = byAgent.get(key);
    if (!g) {
      g = { text: display.text, hosts: new Set(), active: 0, stale: 0, lastTs: null, attributed: display.attributed };
      byAgent.set(key, g);
    }
    if (v.host) g.hosts.add(v.host);
    if (isStalled(v, opts.now, opts.staleMs)) g.stale += 1;
    else g.active += 1;
    const ts = v.lastEventTs === null ? Number.NaN : Date.parse(v.lastEventTs);
    if (!Number.isNaN(ts)) g.lastTs = g.lastTs === null ? ts : Math.max(g.lastTs, ts);
  }
  return [...byAgent.values()]
    .map((g) => ({
      agent: g.text,
      attributed: g.attributed,
      hosts: [...g.hosts].sort(),
      active: g.active,
      stale: g.stale,
      lastSeenMs: g.lastTs === null ? null : Math.max(0, opts.now - g.lastTs),
    }))
    .sort((a, b) => a.agent.localeCompare(b.agent));
}

/** One chip: `agent · N (+ M stale) @ host · 42s ago`.
 *
 *  Hosts are ALWAYS shown (#38, AX-4) — previously suppressed whenever a host
 *  equaled the displayed agent text (`h !== m.agent`), which meant the ONE case
 *  that filter ever fired was exactly the degraded one (agent falls back to host):
 *  the single visual cue that would reveal the substitution was removed precisely
 *  when it was needed. A real attributed agent's name never coincides with its
 *  host in practice, so this costs nothing in the normal case.
 */
function renderChip(m: PresenceModel): string {
  const sessions = m.active + m.stale;
  const allStale = m.stale > 0 && m.active === 0;
  return (
    `<span class="fd-presence-chip" data-agent="${escapeHtml(m.agent)}" ` +
    `data-attributed="${m.attributed}" data-stale="${allStale}">` +
    `<span class="fd-presence-agent" data-attributed="${m.attributed}">${escapeHtml(m.agent)}</span>` +
    `<span class="fd-presence-count">${sessions}</span>` +
    (m.stale > 0 ? `<span class="fd-presence-stalecount">${m.stale} stale</span>` : "") +
    (m.hosts.length > 0
      ? `<span class="fd-presence-host">@ ${escapeHtml(m.hosts.join(", "))}</span>`
      : "") +
    (m.lastSeenMs !== null
      ? `<span class="fd-presence-last">${escapeHtml(formatDuration(m.lastSeenMs))} ago</span>`
      : "") +
    `</span>`
  );
}

/** The strip. Empty roster → empty string (the section simply isn't there). */
export function renderPresenceStrip(models: PresenceModel[]): string {
  if (models.length === 0) return "";
  // AX-2 (#38): the roster's own unattributed tally. #35's per-lane `N unattributed`
  // (page.ts) structurally cannot see sessions — they are partitioned out of `models`
  // before that tally is computed — so without this the board could report a small
  // unattributed count while the "agents" strip is majority hostnames. A counter that
  // cannot reach a population is worse than no counter, because it reads as complete.
  //
  // #38 code review, finding 3: sum SESSIONS, not roster ROWS. This same fix
  // deliberately aggregates N agent-less sessions on one host into one row, so
  // counting rows understates the population by exactly that aggregation factor —
  // 40 anonymous sessions across two hosts would read "2 unattributed" if this
  // counted rows.
  const unattributed = models
    .filter((m) => !m.attributed)
    .reduce((n, m) => n + m.active + m.stale, 0);
  return (
    `<section class="fd-presence"><h2>agents</h2>` +
    (unattributed > 0
      ? `<span class="fd-presence-unattributed" title="no Dev-Name resolved for these sessions">${unattributed} unattributed</span>`
      : "") +
    models.map(renderChip).join("") +
    `</section>`
  );
}
