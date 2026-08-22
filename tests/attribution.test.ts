// #35 / AX-3 — an unattributed activity must not wear its id as an agent name.
//
// `view.agent ?? shortName(label ?? activityId)` was inlined at three call sites, so
// an activity with no resolved agent put an ID in the agent slot at the same weight
// and styling as a real Dev-Name. `P1W1`, `161`, `RTM-spike` and `flightdeck` then
// read as agent names to anyone who does not already know the fleet roster — 34 of
// 56 activities on the live board. AX-2 forbids a guess presented as a fact.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FlightDeckEvent } from "../src/events/contract.ts";
import { computeEta } from "../src/eta.ts";
import { foldActivity } from "../src/fold.ts";
import { deriveMetrics } from "../src/metrics.ts";
import { renderCard } from "../src/ui/card.ts";
import { buildConcernQueue, renderConcernQueue } from "../src/ui/concern_queue.ts";
import { resolveDisplay } from "../src/ui/format.ts";
import { EventLog } from "../src/log.ts";
import { Store } from "../src/store.ts";
import { renderBoard } from "../src/ui/page.ts";
import { renderTable } from "../src/ui/table.ts";

function model(events: FlightDeckEvent[]) {
  const view = foldActivity(events);
  const metrics = deriveMetrics(events);
  return { view, metrics, eta: computeEta(view, metrics) };
}

function start(activityId: string, extra: Partial<FlightDeckEvent> = {}): FlightDeckEvent {
  return {
    kind: "activity_start",
    activityId,
    ts: "2026-08-21T10:00:00Z",
    activityType: "campaign",
    ...extra,
  } as FlightDeckEvent;
}

describe("resolveDisplay (#35)", () => {
  test("a resolved agent is attributed and shown by name", () => {
    const d = resolveDisplay({ agent: "harbinger", label: "blueshift-quartermaster", activityId: "116" });
    expect(d).toEqual({ text: "harbinger", attributed: true });
  });

  test("no agent falls back to the label but is NOT attributed", () => {
    const d = resolveDisplay({ agent: null, label: "blueshift-quartermaster", activityId: "116" });
    expect(d.attributed).toBe(false);
    expect(d.text).toBe("blueshift-quartermaster");
  });

  test("no agent and no label falls back to the id, still unattributed", () => {
    const d = resolveDisplay({ agent: null, label: null, activityId: "P1W1" });
    expect(d).toEqual({ text: "P1W1", attributed: false });
  });

  test("an empty-string agent is not an attribution", () => {
    // A degraded emit that sends "" must not read as a named agent (AX-2).
    expect(resolveDisplay({ agent: "", label: null, activityId: "161" }).attributed).toBe(false);
  });

  test("the full path is still shortened for display", () => {
    const d = resolveDisplay({ agent: null, label: "Wave-Engineering/flightdeck", activityId: "x" });
    expect(d.text).toBe("flightdeck");
  });
});

describe("renderers agree — one resolver, no drift (#35)", () => {
  const attributed = model([start("116", { agent: "harbinger", label: "blueshift-quartermaster" })]);
  const unattributed = model([start("P1W1", { label: "some-repo" })]);

  test("card marks attribution state", () => {
    expect(renderCard(attributed)).toContain('data-attributed="true"');
    expect(renderCard(unattributed)).toContain('data-attributed="false"');
  });

  test("table row marks attribution state", () => {
    expect(renderTable([attributed])).toContain('data-attributed="true"');
    expect(renderTable([unattributed])).toContain('data-attributed="false"');
  });

  test("card and table agree for the same view", () => {
    for (const m of [attributed, unattributed]) {
      const want = `data-attributed="${m.view.agent !== null}"`;
      expect(renderCard(m)).toContain(want);
      expect(renderTable([m])).toContain(want);
    }
  });

  test("the hover title keeps the UNTOUCHED full value (#10 contract)", () => {
    // Attribution is signalled by data-attributed + styling, never by editing the
    // title — #10 requires the full value to survive there verbatim.
    expect(renderCard(unattributed)).toContain('title="some-repo"');
  });
});

describe("concern queue identifies the agent per concern (AX-3, #35)", () => {
  function withConcern(
    activityId: string,
    startExtra: Partial<FlightDeckEvent> = {},
    concernExtra: Partial<FlightDeckEvent> = {},
  ): FlightDeckEvent[] {
    return [
      start(activityId, startExtra),
      {
        kind: "concern",
        activityId,
        ts: "2026-08-21T10:05:00Z",
        concernKind: "gate-override",
        source: "coded",
        ...concernExtra,
      } as FlightDeckEvent,
    ];
  }

  test("a concern naming its agent renders that name IN THE AGENT CHIP", () => {
    const v = foldActivity(withConcern("116", { agent: "harbinger" }, { agent: "harbinger" }));
    const html = renderConcernQueue(buildConcernQueue([v]));
    // Assert the chip specifically: `toContain("harbinger")` alone would pass on
    // the activity span or the scope trail, i.e. for the wrong reason.
    expect(html).toContain('class="fd-concern-agent" data-attributed="true"');
    expect(html).toContain(">harbinger</span>");
  });

  test("the activity keeps its own slot — the agent does not replace it", () => {
    const v = foldActivity(
      withConcern("116", { agent: "harbinger", label: "blueshift-quartermaster" }, { agent: "harbinger" }),
    );
    const html = renderConcernQueue(buildConcernQueue([v]));
    expect(html).toContain("blueshift-quartermaster");
  });

  test("a concern with no agent says 'unattributed' rather than showing an id", () => {
    const html = renderConcernQueue(buildConcernQueue([foldActivity(withConcern("P1W1"))]));
    expect(html).toContain('class="fd-concern-agent" data-attributed="false"');
    expect(html).toContain("unattributed");
  });

  test("a concern with no agent does NOT borrow the activity's agent (AX-2/AX-4)", () => {
    // The activity is attributed; this concern is not. Crediting it to the
    // activity's last-write-wins agent would be a guess presented as a fact —
    // and after a mid-stream rename it would credit the wrong person outright.
    const v = foldActivity(withConcern("116", { agent: "harbinger" }));
    const html = renderConcernQueue(buildConcernQueue([v]));
    expect(html).toContain('class="fd-concern-agent" data-attributed="false"');
  });

  test("two concerns from different agents keep their own attributions", () => {
    // The rename case, and the sibling-latch case, in one stream: whoever emitted
    // last must not retro-claim an earlier concern.
    const v = foldActivity([
      start("116", { agent: "threepio" }),
      { kind: "concern", activityId: "116", ts: "2026-08-21T10:05:00Z", concernKind: "gate-override", source: "coded", agent: "threepio" } as FlightDeckEvent,
      { kind: "concern", activityId: "116", ts: "2026-08-21T10:20:00Z", concernKind: "self-approval", source: "coded", agent: "harbinger" } as FlightDeckEvent,
    ]);
    const html = renderConcernQueue(buildConcernQueue([v]));
    expect(html).toContain(">threepio</span>");
    expect(html).toContain(">harbinger</span>");
  });
});

describe("agent is last-write-wins, but an empty one cannot erase it (#35)", () => {
  test("a later named event wins — the rename is absorbed into view.agent", () => {
    const v = foldActivity([
      start("116", { agent: "threepio" }),
      { kind: "step", activityId: "116", ts: "2026-08-21T10:05:00Z", label: "x", agent: "harbinger" } as FlightDeckEvent,
    ]);
    expect(v.agent).toBe("harbinger");
    expect(resolveDisplay(v).attributed).toBe(true);
  });

  test("an EMPTY agent does not un-name an activity that was attributed", () => {
    // `--agent "$DEV_NAME"` with the variable unset ships "". An unguarded latch
    // would let a degraded emit silently drop a named agent to unattributed.
    const v = foldActivity([
      start("116", { agent: "harbinger" }),
      { kind: "step", activityId: "116", ts: "2026-08-21T10:05:00Z", label: "x", agent: "" } as FlightDeckEvent,
    ]);
    expect(v.agent).toBe("harbinger");
    expect(resolveDisplay(v).attributed).toBe(true);
  });
});

describe("the board tallies unattributed activities (AX-2, #35)", () => {
  let dir: string;
  let store: Store;
  const NOW = Date.parse("2026-08-21T10:10:00Z");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "flightdeck-attr-"));
    store = new Store({ log: new EventLog(join(dir, "events.jsonl")), dbPath: ":memory:" });
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("the tally equals the number of activities with no agent, on a MIXED fixture", () => {
    // Mixed on purpose: a counter only ever exercised at zero — or at all-empty —
    // has not been shown to count. Two named, three not.
    store.append(start("116", { agent: "harbinger" }));
    store.append(start("camp-2", { agent: "bishop" }));
    store.append(start("P1W1"));
    store.append(start("P1W2"));
    store.append(start("161"));

    const html = renderBoard(store, { now: NOW, staleMs: 15 * 60 * 1000 });
    expect(html).toContain("3 unattributed");
  });

  test("no tally is shown when every activity is attributed", () => {
    store.append(start("116", { agent: "harbinger" }));
    const html = renderBoard(store, { now: NOW, staleMs: 15 * 60 * 1000 });
    // Positive assertion paired deliberately: `not.toContain` alone is vacuously
    // satisfiable — if the fixture ever stopped producing a lane activity the
    // board would render "no activities" and this would still pass.
    expect(html).toContain("harbinger");
    expect(html).not.toContain("unattributed");
  });

  test("the tally is PER LANE, not board-wide", () => {
    // Two unattributed in Active, one in Idle. A board-wide count would read "3"
    // once; per-lane must read 2 and 1 separately. Without a stale fixture the
    // granularity the design claims is never actually exercised.
    store.append(start("fresh-named", { agent: "harbinger" }));
    store.append(start("fresh-anon-1"));
    store.append(start("fresh-anon-2"));
    store.append({
      kind: "activity_start",
      activityId: "old-anon",
      ts: "2026-08-21T08:00:00Z",
      activityType: "campaign",
    } as FlightDeckEvent);

    const html = renderBoard(store, { now: NOW, staleMs: 15 * 60 * 1000 });
    expect(html).toContain("2 unattributed");
    expect(html).toContain("1 unattributed");
  });
});
