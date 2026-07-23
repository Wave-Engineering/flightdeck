// #7 / cc-workflow#947 — sessions render as an agent-presence strip, never as
// campaign cards; synthetic activities are filtered off the board.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FlightDeckEvent } from "../src/events/contract.ts";
import { foldActivity } from "../src/fold.ts";
import { EventLog } from "../src/log.ts";
import { Store } from "../src/store.ts";
import { renderBoard } from "../src/ui/page.ts";
import { buildPresence, renderPresenceStrip } from "../src/ui/presence.ts";

const T = (s: string) => Date.parse(s);
const NOW = T("2026-07-22T12:00:00Z");
const STALE_MS = 15 * 60 * 1000;

/** Fold one session activity from a start (+ optional extra events). */
function session(
  id: string,
  opts: { agent?: string; host?: string; ts?: string; closed?: boolean },
): ReturnType<typeof foldActivity> {
  const ts = opts.ts ?? "2026-07-22T11:59:00Z";
  const events: FlightDeckEvent[] = [
    {
      kind: "activity_start",
      activityId: `session:${id}`,
      ts,
      activityType: "session",
      phase: "session",
      agent: opts.agent ?? null,
      host: opts.host ?? null,
      label: "session-open",
    },
  ];
  if (opts.closed) {
    events.push({ kind: "activity_end", activityId: `session:${id}`, ts });
  }
  return foldActivity(events);
}

describe("buildPresence", () => {
  test("groups by agent; fresh vs stale counted via the injected clock", () => {
    const views = [
      session("a1", { agent: "babelfish", host: "malory", ts: "2026-07-22T11:59:00Z" }), // fresh
      session("a2", { agent: "babelfish", host: "malory", ts: "2026-07-22T10:00:00Z" }), // stale (2h)
      session("b1", { agent: "strangler", host: "malory", ts: "2026-07-22T11:58:00Z" }), // fresh
    ];
    const roster = buildPresence(views, { now: NOW, staleMs: STALE_MS });
    expect(roster).toHaveLength(2);
    expect(roster[0]).toMatchObject({ agent: "babelfish", active: 1, stale: 1, hosts: ["malory"] });
    expect(roster[1]).toMatchObject({ agent: "strangler", active: 1, stale: 0 });
  });

  test("two agents on one host are distinguishable (#947 AC)", () => {
    const roster = buildPresence(
      [
        session("x", { agent: "babelfish", host: "malory" }),
        session("y", { agent: "polyjuice", host: "malory" }),
      ],
      { now: NOW, staleMs: STALE_MS },
    );
    expect(roster.map((r) => r.agent)).toEqual(["babelfish", "polyjuice"]);
  });

  test("agent-less sessions group under host (visible degradation), else 'unknown'", () => {
    const roster = buildPresence(
      [session("h", { host: "malory" }), session("n", {})],
      { now: NOW, staleMs: STALE_MS },
    );
    expect(roster.map((r) => r.agent)).toEqual(["malory", "unknown"]);
  });

  test("closed sessions drop off the roster", () => {
    const roster = buildPresence(
      [session("dead", { agent: "babelfish", closed: true })],
      { now: NOW, staleMs: STALE_MS },
    );
    expect(roster).toHaveLength(0);
  });

  test("lastSeenMs is now minus the most recent event", () => {
    const roster = buildPresence(
      [session("t", { agent: "babelfish", ts: "2026-07-22T11:59:00Z" })],
      { now: NOW, staleMs: STALE_MS },
    );
    expect(roster[0]?.lastSeenMs).toBe(60_000);
  });
});

describe("renderPresenceStrip", () => {
  test("chips carry data-agent; host shown only when it adds information", () => {
    const html = renderPresenceStrip(
      buildPresence(
        [
          session("x", { agent: "babelfish", host: "malory" }),
          session("h", { host: "malory" }), // degraded: agent IS the host
        ],
        { now: NOW, staleMs: STALE_MS },
      ),
    );
    expect(html).toContain('data-agent="babelfish"');
    expect(html).toContain("@ malory"); // babelfish's chip names its host
    expect(html).toContain('data-agent="malory"'); // degraded chip
    // the degraded chip must NOT repeat its own name as a host suffix
    expect(html.match(/@ malory/g)).toHaveLength(1);
  });

  test("empty roster renders nothing at all", () => {
    expect(renderPresenceStrip([])).toBe("");
  });
});

describe("renderBoard partition (#7)", () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "flightdeck-presence-"));
    store = new Store({ log: new EventLog(join(dir, "events.jsonl")), dbPath: ":memory:" });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const seed = () => {
    // one real campaign …
    store.append({ kind: "activity_start", activityId: "camp-1", ts: "2026-07-22T11:00:00Z", activityType: "campaign", label: "Real Campaign", detail: { planTotal: 3 } });
    // … a legacy-shape session (the production flood shape: phase only) …
    store.append({ kind: "step", activityId: "session:legacy", ts: "2026-07-22T11:59:00Z", phase: "session", agent: "malory", label: "session-idle" });
    // … a declared-shape session (new emitter) …
    store.append({ kind: "activity_start", activityId: "session:new", ts: "2026-07-22T11:59:30Z", activityType: "session", phase: "session", agent: "babelfish", host: "malory", label: "session-open" });
    // … and synthetic test residue.
    store.append({ kind: "activity_start", activityId: "e2e-smoke", ts: "2026-07-22T11:30:00Z", activityType: "campaign", label: "e2e-smoke", detail: { synthetic: true } });
  };

  test("sessions appear in the presence strip and in NO lane; campaigns still card", () => {
    seed();
    const html = renderBoard(store, { now: NOW, staleMs: STALE_MS });
    // Cards and table rows both carry data-activity-id; presence chips do not.
    // Assertion-liveness (#922): before the fix this HTML contained
    // `data-activity-id="session:…"` campaign cards — verified failing pre-fix.
    expect(html).not.toContain('data-activity-id="session:');
    expect(html).toContain('class="fd-presence"');
    expect(html).toContain('data-agent="babelfish"');
    expect(html).toContain('data-agent="malory"'); // legacy session, degraded identity
    expect(html).toContain('data-activity-id="camp-1"'); // the real campaign still cards
    expect(html).toContain("Real Campaign");
  });

  test("synthetic activities appear nowhere on the board", () => {
    seed();
    const html = renderBoard(store, { now: NOW, staleMs: STALE_MS });
    expect(html).not.toContain("e2e-smoke");
  });

  test("sessions alone (no campaigns) still render a board with the strip", () => {
    store.append({ kind: "step", activityId: "session:only", ts: "2026-07-22T11:59:00Z", phase: "session", agent: "malory", label: "session-idle" });
    const html = renderBoard(store, { now: NOW, staleMs: STALE_MS });
    expect(html).toContain('class="fd-presence"');
    expect(html).not.toContain("fd-card");
  });

  test("only synthetic activities ⇒ the empty state", () => {
    store.append({ kind: "activity_start", activityId: "smoke", ts: "2026-07-22T11:00:00Z", detail: { synthetic: true } });
    const html = renderBoard(store, { now: NOW, staleMs: STALE_MS });
    expect(html).toContain("no activities");
  });

  test("rebuild ≡ live for the new fields (IT-05 holds)", () => {
    seed();
    const live = store.getView();
    store.rebuild();
    expect(store.getView()).toEqual(live);
  });
});
