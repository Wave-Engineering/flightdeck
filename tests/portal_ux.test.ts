// #10 — portal UX: board order (Active → concerns → Idle), concern-queue scroll
// cap, agent-first titles, short project names, cyberpunk theme structure.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FlightDeckEvent } from "../src/events/contract.ts";
import { foldActivity } from "../src/fold.ts";
import { EventLog } from "../src/log.ts";
import { Store } from "../src/store.ts";
import { computeEta } from "../src/eta.ts";
import { deriveMetrics } from "../src/metrics.ts";
import { renderCard } from "../src/ui/card.ts";
import { buildConcernQueue, renderConcernQueue } from "../src/ui/concern_queue.ts";
import { shortName } from "../src/ui/format.ts";
import { renderBoard } from "../src/ui/page.ts";
import { renderTable } from "../src/ui/table.ts";

const NOW = Date.parse("2026-07-23T12:00:00Z");
const STALE_MS = 15 * 60 * 1000;

function ev(
  e: Partial<FlightDeckEvent> & { kind: FlightDeckEvent["kind"]; activityId: string; ts: string },
): FlightDeckEvent {
  return e as FlightDeckEvent;
}

function model(events: FlightDeckEvent[]) {
  const view = foldActivity(events);
  const metrics = deriveMetrics(events);
  return { view, metrics, eta: computeEta(view, metrics) };
}

describe("shortName", () => {
  test("strips to the last path segment", () => {
    expect(shortName("Wave-Engineering/flightdeck")).toBe("flightdeck");
    expect(shortName("analogicdev/internal/tools/blueshift/blueshift-agent-mantle")).toBe(
      "blueshift-agent-mantle",
    );
  });
  test("non-path values pass through", () => {
    expect(shortName("flightdeck")).toBe("flightdeck");
    expect(shortName("deploy smoke test")).toBe("deploy smoke test");
    expect(shortName("P1W1")).toBe("P1W1");
  });
  test("trailing-slash and degenerate inputs are safe", () => {
    expect(shortName("a/b/")).toBe("b");
    expect(shortName("/")).toBe("/"); // reduces to nothing → fall back to input
    expect(shortName("")).toBe("");
  });
});

describe("title precedence (#10): agent > short project name", () => {
  const withAgent = [
    ev({ kind: "activity_start", activityId: "c1", ts: "t0", activityType: "campaign", label: "Wave-Engineering/claudecode-workflow", detail: { planTotal: 3 } }),
    ev({ kind: "step", activityId: "c1", ts: "t1", label: "promoted", wave: "W1", agent: "babelfish" }),
  ];
  const withoutAgent = [
    ev({ kind: "activity_start", activityId: "c2", ts: "t0", activityType: "campaign", label: "Wave-Engineering/claudecode-workflow", detail: { planTotal: 3 } }),
  ];

  test("card: agent Dev-Name wins; full path survives on hover", () => {
    const html = renderCard(model(withAgent));
    expect(html).toContain(">babelfish</span>");
    expect(html).toContain('title="Wave-Engineering/claudecode-workflow"');
    expect(html).not.toContain(">Wave-Engineering/claudecode-workflow</span>");
  });

  test("card: no agent → short project name, never the full path", () => {
    const html = renderCard(model(withoutAgent));
    expect(html).toContain(">claudecode-workflow</span>");
    expect(html).toContain('title="Wave-Engineering/claudecode-workflow"');
  });

  test("card: label-less activity falls back to activityId basename", () => {
    const html = renderCard(
      model([ev({ kind: "step", activityId: "org/repo-x", ts: "t0", label: "promoted" })]),
    );
    expect(html).toContain(">repo-x</span>");
  });

  test("table row: same precedence, hover attr present", () => {
    const html = renderTable([model(withAgent), model(withoutAgent)]);
    expect(html).toContain(">babelfish</td>");
    expect(html).toContain(">claudecode-workflow</td>");
    expect(html).toContain('title="Wave-Engineering/claudecode-workflow"');
  });

  test("concern row: activity name is the short form with full on hover", () => {
    const stream = [
      ...withoutAgent,
      ev({ kind: "concern", activityId: "c2", ts: "t2", concernKind: "workaround", source: "coded" }),
    ];
    const html = renderConcernQueue(buildConcernQueue([foldActivity(stream)]));
    expect(html).toContain(">claudecode-workflow</span>");
    expect(html).toContain('title="Wave-Engineering/claudecode-workflow"');
  });
});

describe("concern queue scroll container (#10)", () => {
  test("rows render inside .fd-concern-rows with ALL rows in the DOM (scroll, not truncation)", () => {
    const events: FlightDeckEvent[] = [
      ev({ kind: "activity_start", activityId: "c", ts: "t0", activityType: "campaign" }),
    ];
    for (let i = 0; i < 10; i++) {
      events.push(
        ev({ kind: "concern", activityId: "c", ts: `t${i + 1}`, concernKind: "workaround", source: "coded", label: `concern-${i}` }),
      );
    }
    const html = renderConcernQueue(buildConcernQueue([foldActivity(events)]));
    expect(html).toContain('class="fd-concern-rows"');
    expect(html.match(/fd-concern-row[ "]/g)!.length).toBeGreaterThanOrEqual(10); // all 10 present
  });
});

describe("client script scroll preservation (#10)", () => {
  test("the live client restores .fd-concern-rows scrollTop across board swaps", async () => {
    // The vanilla client is a static string with no DOM harness in this repo;
    // this pins the presence of the capture/restore logic so it can't be
    // silently dropped (behavioral coverage would need a DOM test rig).
    const page = await import("../src/ui/page.ts");
    const { EventLog } = await import("../src/log.ts");
    const dir = mkdtempSync(join(tmpdir(), "flightdeck-client-"));
    try {
      const store = new Store({ log: new EventLog(join(dir, "e.jsonl")), dbPath: ":memory:" });
      const html = page.renderPage(store);
      store.close();
      expect(html).toContain("fd-concern-rows");
      expect(html).toContain("scrollTop");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("board order (#10): presence → Active → concerns → Idle → Closed", () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "flightdeck-ux-"));
    store = new Store({ log: new EventLog(join(dir, "events.jsonl")), dbPath: ":memory:" });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("concern queue sits after the Active lane and before the Idle lane", () => {
    const fresh = "2026-07-23T11:59:00Z";
    const staleTs = "2026-07-23T09:00:00Z";
    // active campaign with a concern …
    store.append(ev({ kind: "activity_start", activityId: "act", ts: fresh, activityType: "campaign", label: "Active One" }));
    store.append(ev({ kind: "concern", activityId: "act", ts: fresh, concernKind: "workaround", source: "coded" }));
    // … and a stale (idle-lane) campaign.
    store.append(ev({ kind: "activity_start", activityId: "idl", ts: staleTs, activityType: "campaign", label: "Idle One" }));

    const html = renderBoard(store, { now: NOW, staleMs: STALE_MS });
    const posActive = html.indexOf('data-lane="active"');
    const posConcerns = html.indexOf('class="fd-concerns"');
    const posIdle = html.indexOf('data-lane="idle"');
    expect(posActive).toBeGreaterThan(-1);
    expect(posConcerns).toBeGreaterThan(-1);
    expect(posIdle).toBeGreaterThan(-1);
    expect(posActive).toBeLessThan(posConcerns);
    expect(posConcerns).toBeLessThan(posIdle);
  });
});
