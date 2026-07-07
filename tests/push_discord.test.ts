// S4.2 / #874 — Discord push. R-23 (alert on idle-but-incomplete) + the three
// disciplines: fire-and-forget/never-throws, inert-by-default (unconfigured ⇒ no-op),
// de-dupe (one alert per stale transition). The transport is MOCKED — NO real Discord
// post ever happens here. Hermetic: no process.env reads/mutations (config + clock +
// transport are all injected).

import { describe, expect, test } from "bun:test";

import type { FlightDeckEvent } from "../src/events/contract.ts";
import { type ActivityView, foldActivity } from "../src/fold.ts";
import {
  type DiscordConfig,
  type PostFn,
  StalenessNotifier,
  alertText,
  createDiscordTransport,
  isConfigured,
  resolveDiscordConfig,
} from "../src/push_discord.ts";

function ev(
  e: Partial<FlightDeckEvent> & { kind: FlightDeckEvent["kind"]; activityId: string; ts: string },
): FlightDeckEvent {
  return e as FlightDeckEvent;
}

const T0 = "2026-07-07T10:00:00Z";
const NOW = Date.parse(T0);
const THRESHOLD = 15 * 60 * 1000;
const CONFIGURED: DiscordConfig = { channel: "chan-123", token: "tok-abc" };

/** An open (non-terminal) activity whose last event is at `lastTs`. */
function openView(id: string, lastTs: string, extra?: Partial<FlightDeckEvent>): ActivityView {
  return foldActivity([
    ev({ kind: "activity_start", activityId: id, ts: T0, activityType: "campaign", label: id, detail: { planTotal: 4 } }),
    ev({ kind: "step", activityId: id, ts: lastTs, label: "promoted", wave: "1", ...extra }),
  ]);
}

/** A spying transport + the calls it recorded. */
function spyTransport(): { post: PostFn; calls: Array<{ channel: string; text: string }> } {
  const calls: Array<{ channel: string; text: string }> = [];
  const post: PostFn = async (channel, text) => {
    calls.push({ channel, text });
  };
  return { post, calls };
}

/** Let queued microtasks (the fire-and-forget promise) run. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("config resolution", () => {
  test("resolveDiscordConfig reads the injected env; blanks ⇒ null (inert)", () => {
    expect(resolveDiscordConfig({})).toEqual({ channel: null, token: null });
    expect(resolveDiscordConfig({ FLIGHTDECK_DISCORD_CHANNEL: "  ", FLIGHTDECK_DISCORD_TOKEN: "" }))
      .toEqual({ channel: null, token: null });
    expect(
      resolveDiscordConfig({ FLIGHTDECK_DISCORD_CHANNEL: "c1", FLIGHTDECK_DISCORD_TOKEN: "t1" }),
    ).toEqual({ channel: "c1", token: "t1" });
  });

  test("isConfigured requires BOTH channel and token", () => {
    expect(isConfigured({ channel: "c", token: "t" })).toBe(true);
    expect(isConfigured({ channel: "c", token: null })).toBe(false);
    expect(isConfigured({ channel: null, token: "t" })).toBe(false);
    expect(isConfigured({ channel: null, token: null })).toBe(false);
  });
});

describe("inert-by-default (unconfigured ⇒ no post)", () => {
  test("no config, no injected transport ⇒ notifier is inactive and never posts", async () => {
    const n = new StalenessNotifier({ config: { channel: null, token: null }, staleMs: THRESHOLD });
    expect(n.active).toBe(false);
    // even a clearly-stale activity produces nothing (no transport to call).
    n.tick([openView("a", T0)], NOW + THRESHOLD * 2);
    await flush();
    // nothing to assert on a null transport beyond "did not throw"; active === false is
    // the observable contract.
    expect(n.active).toBe(false);
  });

  test("a transport is present but the channel is unset ⇒ still inert, spy never called", async () => {
    const { post, calls } = spyTransport();
    const n = new StalenessNotifier({ post, config: { channel: null, token: "t" }, staleMs: THRESHOLD });
    expect(n.active).toBe(false);
    n.tick([openView("a", T0)], NOW + THRESHOLD * 2);
    await flush();
    expect(calls).toHaveLength(0);
  });
});

describe("fires once on the stale transition + de-dupe", () => {
  test("one alert on entry into stale; NOT re-alerted while it stays stale", async () => {
    const { post, calls } = spyTransport();
    const n = new StalenessNotifier({ post, config: CONFIGURED, staleMs: THRESHOLD });
    expect(n.active).toBe(true);

    const stale = openView("camp1", T0);
    const now1 = NOW + THRESHOLD; // exactly stale
    n.tick([stale], now1);
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.channel).toBe("chan-123");
    expect(calls[0]!.text).toContain("camp1");
    expect(calls[0]!.text).toContain("idle");

    // still stale on the next tick ⇒ NO second alert (de-dupe by activityId).
    n.tick([stale], now1 + 60_000);
    await flush();
    expect(calls).toHaveLength(1);
  });

  test("a fresh activity never alerts", async () => {
    const { post, calls } = spyTransport();
    const n = new StalenessNotifier({ post, config: CONFIGURED, staleMs: THRESHOLD });
    const freshTs = new Date(NOW + THRESHOLD * 5 - 60_000).toISOString();
    n.tick([openView("fresh", freshTs)], NOW + THRESHOLD * 5);
    await flush();
    expect(calls).toHaveLength(0);
  });

  test("recovery clears the memory ⇒ a later re-stall re-alerts (edge to edge)", async () => {
    const { post, calls } = spyTransport();
    const n = new StalenessNotifier({ post, config: CONFIGURED, staleMs: THRESHOLD });

    // stale → alert #1
    n.tick([openView("a", T0)], NOW + THRESHOLD);
    await flush();
    expect(calls).toHaveLength(1);

    // recovered: a NEW recent event makes it fresh again (no alert on recovery).
    const recentTs = new Date(NOW + THRESHOLD * 2 - 60_000).toISOString();
    n.tick([openView("a", recentTs)], NOW + THRESHOLD * 2);
    await flush();
    expect(calls).toHaveLength(1);

    // goes stale again (last event now old under a later clock) → alert #2.
    n.tick([openView("a", recentTs)], Date.parse(recentTs) + THRESHOLD + 1);
    await flush();
    expect(calls).toHaveLength(2);
  });

  test("a closed activity never alerts, however old", async () => {
    const { post, calls } = spyTransport();
    const n = new StalenessNotifier({ post, config: CONFIGURED, staleMs: THRESHOLD });
    const closed = foldActivity([
      ev({ kind: "activity_start", activityId: "z", ts: T0, activityType: "campaign", detail: { planTotal: 2 } }),
      ev({ kind: "activity_end", activityId: "z", ts: T0 }),
    ]);
    n.tick([closed], NOW + THRESHOLD * 100);
    await flush();
    expect(calls).toHaveLength(0);
  });
});

describe("fire-and-forget never throws into the caller", () => {
  test("a rejecting transport does not throw from tick and does not crash", async () => {
    const rejecting: PostFn = async () => {
      throw new Error("discord down");
    };
    const n = new StalenessNotifier({ post: rejecting, config: CONFIGURED, staleMs: THRESHOLD });
    // tick must return normally despite the transport rejecting.
    expect(() => n.tick([openView("a", T0)], NOW + THRESHOLD)).not.toThrow();
    await flush(); // let the rejection settle — it is swallowed, no unhandled rejection.
  });
});

describe("alertText + default transport shape", () => {
  test("alertText names the activity, its idle age, and its incompleteness", () => {
    const view = openView("Blueshift", T0, { phase: "3", wave: "3.1" } as Partial<FlightDeckEvent>);
    const text = alertText(view, NOW + 20 * 60 * 1000); // 20 min idle
    expect(text).toContain("Blueshift");
    expect(text).toContain("campaign");
    expect(text).toContain("20m");
    expect(text).toContain("not complete");
  });

  test("createDiscordTransport returns a function without performing any I/O", () => {
    // Constructing the transport must NOT touch the network — only invoking it would.
    const post = createDiscordTransport(CONFIGURED);
    expect(typeof post).toBe("function");
  });
});
