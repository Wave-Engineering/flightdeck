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
    expect(roster[0]).toMatchObject({ agent: "babelfish", attributed: true, active: 1, stale: 1, hosts: ["malory"] });
    expect(roster[1]).toMatchObject({ agent: "strangler", attributed: true, active: 1, stale: 0 });
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

  test("agent-less session with a host degrades to the host, marked unattributed (#38, AX-3)", () => {
    const roster = buildPresence([session("h", { host: "malory" })], { now: NOW, staleMs: STALE_MS });
    expect(roster).toHaveLength(1);
    expect(roster[0]).toMatchObject({ agent: "malory", attributed: false });
  });

  test("a session with neither agent nor host still renders unattributed, not a bare 'unknown' styled as an identity (#38, AX-3)", () => {
    // Resolved through the SAME shared resolver as the rest of the board (#35) —
    // its last resort is the activity's own id, not a synthesized "unknown" string.
    // What matters for AX-3 is that it is MARKED unattributed, not the literal text.
    const roster = buildPresence([session("n", {})], { now: NOW, staleMs: STALE_MS });
    expect(roster).toHaveLength(1);
    expect(roster[0]?.attributed).toBe(false);
    expect(roster[0]?.agent).not.toBe("unknown");
  });

  test("two agent-less sessions on the SAME host aggregate into one unattributed row (#38 test procedure)", () => {
    const roster = buildPresence(
      [session("h1", { host: "malory" }), session("h2", { host: "malory" })],
      { now: NOW, staleMs: STALE_MS },
    );
    expect(roster).toHaveLength(1);
    expect(roster[0]).toMatchObject({ agent: "malory", attributed: false, active: 2 });
  });

  test("the emitter's OWN degradation signature (agent === host) resolves unattributed (#38 code review finding 1)", () => {
    // The real live shape: claudecode-workflow's flightdeck-session-emit.sh sets
    // `agent="$host"` when no Dev-Name resolves — it never leaves `agent` null. A
    // resolver keyed only on "is agent null" would never fire on this population.
    const roster = buildPresence([session("x", { agent: "malory", host: "malory" })], { now: NOW, staleMs: STALE_MS });
    expect(roster).toHaveLength(1);
    expect(roster[0]).toMatchObject({ agent: "malory", attributed: false, hosts: ["malory"] });
  });

  test("a REAL agent is unaffected even when it happens to differ from its host (control for finding 1)", () => {
    const roster = buildPresence([session("x", { agent: "babelfish", host: "malory" })], { now: NOW, staleMs: STALE_MS });
    expect(roster[0]).toMatchObject({ agent: "babelfish", attributed: true });
  });

  test("an attributed and a degraded-to-host identity sharing the same text do NOT merge into one row (#38 finding 2)", () => {
    // Insertion order A: the real agent first, then the degraded one.
    const rosterA = buildPresence(
      [session("real", { agent: "malory", host: "elsewhere" }), session("degraded", { agent: "malory", host: "malory" })],
      { now: NOW, staleMs: STALE_MS },
    );
    expect(rosterA).toHaveLength(2);
    expect(rosterA.filter((r) => r.attributed)).toHaveLength(1);
    expect(rosterA.filter((r) => !r.attributed)).toHaveLength(1);

    // Insertion order B: reversed. Same result either way — the row's attribution
    // must not depend on which one happened to create the group first.
    const rosterB = buildPresence(
      [session("degraded", { agent: "malory", host: "malory" }), session("real", { agent: "malory", host: "elsewhere" })],
      { now: NOW, staleMs: STALE_MS },
    );
    expect(rosterB).toHaveLength(2);
    expect(rosterB.filter((r) => r.attributed)).toHaveLength(1);
    expect(rosterB.filter((r) => !r.attributed)).toHaveLength(1);
  });

  test("an empty-string host does not masquerade as a real host or collide across sessions (#38 finding 4)", () => {
    const roster = buildPresence(
      [session("a", { host: "" }), session("b", { host: "" })],
      { now: NOW, staleMs: STALE_MS },
    );
    // Falls through to the activityId last resort, same as "no host at all" —
    // never an empty name slot, never a shared "" key across unrelated sessions.
    expect(roster.every((r) => r.agent.length > 0)).toBe(true);
    expect(roster.map((r) => r.agent)).not.toContain("");
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
  test("chips carry data-agent and data-attributed; a degraded chip still shows its own host (#38)", () => {
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
    expect(html).toContain('data-attributed="true"'); // babelfish's chip
    expect(html).toContain("@ malory"); // babelfish's chip names its host
    expect(html).toContain('data-agent="malory"'); // degraded chip
    expect(html).toContain('data-attributed="false"'); // degraded chip
    // #38: the host chip is the ONE visible tell that this is a substitution — it
    // must NOT be suppressed just because it duplicates the (unattributed) name slot.
    expect(html.match(/@ malory/g)).toHaveLength(2);
  });

  test("empty roster renders nothing at all", () => {
    expect(renderPresenceStrip([])).toBe("");
  });

  test("the strip carries its OWN unattributed tally (#38, AX-2) — #35's per-lane tally can't reach sessions", () => {
    const html = renderPresenceStrip(
      buildPresence(
        [
          session("x", { agent: "babelfish", host: "malory" }),
          session("h1", { host: "malory" }),
          session("h2", { host: "elsewhere" }),
        ],
        { now: NOW, staleMs: STALE_MS },
      ),
    );
    expect(html).toContain("2 unattributed");
  });

  test("the tally counts SESSIONS, not aggregated roster rows (#38 finding 3)", () => {
    // Three agent-less sessions on the SAME host aggregate into ONE roster row
    // (buildPresence's own aggregation) — the tally must still read 3, not 1.
    const html = renderPresenceStrip(
      buildPresence(
        [session("h1", { host: "malory" }), session("h2", { host: "malory" }), session("h3", { host: "malory" })],
        { now: NOW, staleMs: STALE_MS },
      ),
    );
    expect(html).toContain("3 unattributed");
    expect(html).not.toContain("1 unattributed");
  });

  test("no tally shown when every session is attributed", () => {
    const html = renderPresenceStrip(
      buildPresence([session("x", { agent: "babelfish", host: "malory" })], { now: NOW, staleMs: STALE_MS }),
    );
    expect(html).toContain("babelfish");
    expect(html).not.toContain("unattributed");
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

  test("board-level: an unattributed session is tallied even though the lane campaign is fully attributed (#38 test procedure, mixed fixture)", () => {
    // Mixed on purpose (per #38's own test procedure): a lane activity AND a
    // session in the same fixture, so the two independent tallies (page.ts's
    // per-lane unattributed vs. presence.ts's own) are each exercised, not just
    // asserted in isolation.
    store.append({ kind: "activity_start", activityId: "camp-attributed", ts: "2026-07-22T11:00:00Z", activityType: "campaign", label: "Real Campaign", agent: "harbinger", detail: { planTotal: 3 } });
    store.append({ kind: "activity_start", activityId: "session:anon", ts: "2026-07-22T11:59:00Z", activityType: "session", phase: "session", host: "elsewhere", label: "session-open" });
    const html = renderBoard(store, { now: NOW, staleMs: STALE_MS });
    expect(html).not.toContain("fd-unattributed"); // the lane's OWN tally: campaign IS attributed
    expect(html).toContain("fd-presence-unattributed"); // presence's OWN tally: the session is not
    expect(html).toContain("1 unattributed");
  });

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
