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
import { escapeHtml, formatDuration } from "./format.ts";

/** One roster row: an agent identity with its open sessions summarized. */
export interface PresenceModel {
  /** Dev-Name (once cc-workflow#947's emitter fix is installed); host as the
   *  visible degradation when identity is absent; "unknown" when neither exists. */
  agent: string;
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
    { hosts: Set<string>; active: number; stale: number; lastTs: number | null }
  >();
  for (const v of views) {
    if (v.activityType !== "session" || v.status === "closed") continue;
    const agent = v.agent ?? v.host ?? "unknown";
    let g = byAgent.get(agent);
    if (!g) {
      g = { hosts: new Set(), active: 0, stale: 0, lastTs: null };
      byAgent.set(agent, g);
    }
    if (v.host) g.hosts.add(v.host);
    if (isStalled(v, opts.now, opts.staleMs)) g.stale += 1;
    else g.active += 1;
    const ts = v.lastEventTs === null ? Number.NaN : Date.parse(v.lastEventTs);
    if (!Number.isNaN(ts)) g.lastTs = g.lastTs === null ? ts : Math.max(g.lastTs, ts);
  }
  return [...byAgent.entries()]
    .map(([agent, g]) => ({
      agent,
      hosts: [...g.hosts].sort(),
      active: g.active,
      stale: g.stale,
      lastSeenMs: g.lastTs === null ? null : Math.max(0, opts.now - g.lastTs),
    }))
    .sort((a, b) => a.agent.localeCompare(b.agent));
}

/** One chip: `agent · N (+ M stale) @ host · 42s ago`. Host is shown only when it
 *  adds information (differs from the agent name, i.e. identity resolved). */
function renderChip(m: PresenceModel): string {
  const sessions = m.active + m.stale;
  const hostsShown = m.hosts.filter((h) => h !== m.agent);
  const allStale = m.stale > 0 && m.active === 0;
  return (
    `<span class="fd-presence-chip" data-agent="${escapeHtml(m.agent)}" data-stale="${allStale}">` +
    `<span class="fd-presence-agent">${escapeHtml(m.agent)}</span>` +
    `<span class="fd-presence-count">${sessions}</span>` +
    (m.stale > 0 ? `<span class="fd-presence-stalecount">${m.stale} stale</span>` : "") +
    (hostsShown.length > 0
      ? `<span class="fd-presence-host">@ ${escapeHtml(hostsShown.join(", "))}</span>`
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
  return (
    `<section class="fd-presence"><h2>agents</h2>` +
    models.map(renderChip).join("") +
    `</section>`
  );
}
