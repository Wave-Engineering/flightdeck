// Discord push — outbound alert when an activity goes idle-but-incomplete
// (Dev Spec R-23 / ConOps Flow D / S4.2 / #874).
//
// The container is the SOLE pusher (the agent-host regen path is retired at cutover).
// When the P4 watcher flags an activity as newly stale-but-incomplete, this module
// fires ONE outbound alert. Three disciplines, all load-bearing:
//
//   1. Fire-and-forget — the push NEVER blocks and NEVER throws into the caller
//      (mirrors the emit shipper / UiHub.broadcast: `void p.catch(() => {})`). A dead
//      or slow Discord must not stall the ingest/broadcast loop.
//   2. Configurable + inert-by-default — target channel + token come from the env
//      (FLIGHTDECK_DISCORD_CHANNEL / FLIGHTDECK_DISCORD_TOKEN). Unset ⇒ no transport ⇒
//      NO post at all. FlightDeck is silent until an operator wires the secrets.
//   3. De-duped — an activity is alerted ONCE on the transition into stale, not every
//      tick. Recovery (no longer stale) clears the memory so a later re-stall re-alerts.
//
// Transport seam (F-6 / deploy-topology): the exact container→Discord path (direct
// Discord REST vs. relaying through disc-server) is a Swarm decision. It is injected as
// a small `post(channel, text)` transport; the default is a direct Discord REST bearer
// POST, constructed only when configured. Tests inject a mock and NEVER hit the network.

import type { ActivityView } from "./fold.ts";
import { ageMs, isStalled, resolveStaleMs } from "./watcher.ts";

/** Target for outbound pushes. `null` on either field ⇒ unconfigured ⇒ inert. */
export interface DiscordConfig {
  channel: string | null;
  token: string | null;
}

/** The injectable transport: post `text` to `channel`. Returns a promise the notifier
 *  fires-and-forgets. The default (createDiscordTransport) is a direct Discord REST POST. */
export type PostFn = (channel: string, text: string) => Promise<void>;

export const DISCORD_CHANNEL_ENV = "FLIGHTDECK_DISCORD_CHANNEL";
export const DISCORD_TOKEN_ENV = "FLIGHTDECK_DISCORD_TOKEN";

/** Read the Discord target from the env (injected `env` for hermetic tests). */
export function resolveDiscordConfig(
  env: Record<string, string | undefined> = process.env,
): DiscordConfig {
  const channel = env[DISCORD_CHANNEL_ENV];
  const token = env[DISCORD_TOKEN_ENV];
  return {
    channel: channel && channel.trim() !== "" ? channel : null,
    token: token && token.trim() !== "" ? token : null,
  };
}

/** Configured iff BOTH a channel and a token are present — else inert (no post). */
export function isConfigured(cfg: DiscordConfig): boolean {
  return cfg.channel !== null && cfg.token !== null;
}

/**
 * Default transport: a direct Discord REST bearer POST to the channel's messages
 * endpoint. Built ONLY when configured (so the closure always has a real token).
 * The returned function resolves/rejects a promise; the notifier fires it
 * fire-and-forget and swallows any rejection — so a Discord outage never propagates.
 */
export function createDiscordTransport(cfg: DiscordConfig): PostFn {
  const token = cfg.token ?? "";
  return async (channel: string, text: string): Promise<void> => {
    const url = `https://discord.com/api/v10/channels/${encodeURIComponent(channel)}/messages`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ content: text }),
    });
    if (!res.ok) {
      // Surface to the caller's `.catch` (which swallows) — we do not retry here; the
      // watcher re-evaluates on the next tick and the activity stays flagged until it
      // recovers, so a transient failure is self-healing without a retry queue.
      throw new Error(`discord push failed: ${res.status}`);
    }
  };
}

function humanizeMs(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  const mins = Math.floor(secs / 60);
  if (mins < 1) return `${secs}s`;
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

/** The alert body for a newly-stale activity. Pure over (view, now). */
export function alertText(view: ActivityView, now: number): string {
  const name = view.label ?? view.activityId;
  const age = ageMs(view, now);
  const idleFor = age === null ? "a while" : humanizeMs(age);
  const scope = view.currentPhase
    ? ` at phase ${view.currentPhase}${view.currentWave ? ` / wave ${view.currentWave}` : ""}`
    : "";
  const concerns = view.openConcerns > 0 ? ` · ${view.openConcerns} open concern(s)` : "";
  return `⚠️ FlightDeck: **${name}** (${view.activityType}) is idle — no event for ${idleFor}${scope}, and it is not complete (status: ${view.status})${concerns}.`;
}

/** Options for {@link StalenessNotifier}. All injectable for hermetic tests. */
export interface NotifierOptions {
  /** Transport override. Default: the direct Discord REST POST IFF `config` is set. */
  post?: PostFn;
  /** Target override. Default: {@link resolveDiscordConfig} (env). */
  config?: DiscordConfig;
  /** Staleness threshold (ms). Default: {@link resolveStaleMs} (env / 15 min). */
  staleMs?: number;
}

/**
 * Reconciles the current view set against remembered stall-state and pushes ONE
 * outbound alert per activity on the transition INTO stale-but-incomplete. Owns the
 * de-dupe memory + the (inert-by-default) transport. `tick()` is safe to call as often
 * as you like — on every ingest and/or on a heartbeat — it only acts on transitions.
 */
export class StalenessNotifier {
  private readonly post: PostFn | null;
  private readonly channel: string | null;
  private readonly staleMs: number;
  /** activityIds already alerted (cleared on recovery so a re-stall re-alerts). */
  private readonly alerted = new Set<string>();

  constructor(opts?: NotifierOptions) {
    const cfg = opts?.config ?? resolveDiscordConfig();
    this.channel = cfg.channel;
    this.staleMs = opts?.staleMs ?? resolveStaleMs();
    // Inert-by-default: no transport unless one is injected OR the env is configured.
    this.post = opts?.post ?? (isConfigured(cfg) ? createDiscordTransport(cfg) : null);
  }

  /** True iff a push could actually go out (a transport AND a channel are present). */
  get active(): boolean {
    return this.post !== null && this.channel !== null;
  }

  /**
   * Evaluate every view at `now`; alert once on each entry into stale-but-incomplete,
   * and forget an activity once it is no longer stale (recovered or closed). Never
   * throws, never blocks — pushes are fired fire-and-forget.
   *
   * Sessions and synthetic activities are excluded HERE (#7, mirroring the board
   * partition): an idle session is presence, not an incomplete campaign — alerting
   * on it would relocate the cc-workflow#947 flood to the operator's phone — and
   * synthetic test residue (e.g. the deploy smoke test) must never page anyone.
   * Filtering inside tick() makes every caller safe, not just server.ts.
   */
  tick(views: ActivityView[], now: number): void {
    for (const view of views) {
      if (view.synthetic || view.activityType === "session") continue;
      const stale = isStalled(view, now, this.staleMs);
      const alreadyAlerted = this.alerted.has(view.activityId);
      if (stale && !alreadyAlerted) {
        this.alerted.add(view.activityId);
        this.fire(view, now);
      } else if (!stale && alreadyAlerted) {
        this.alerted.delete(view.activityId); // recovered → allow a future re-alert
      }
    }
  }

  /** Fire ONE alert, fire-and-forget. Inert (no-op) when unconfigured. */
  private fire(view: ActivityView, now: number): void {
    const post = this.post;
    const channel = this.channel;
    if (post === null || channel === null) return; // inert-by-default ⇒ no post
    // Mirror the emit shipper: kick the promise, never await, swallow every error so a
    // failing push can't throw into (or block) the caller.
    void Promise.resolve()
      .then(() => post(channel, alertText(view, now)))
      .catch(() => {
        /* fire-and-forget: a Discord failure never propagates to the caller */
      });
  }
}
