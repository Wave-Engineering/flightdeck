// S3.2 / #864 — dense one-line-per-activity table + per-lane toggle (R-13).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FlightDeckEvent } from "../src/events/contract.ts";
import { computeEta } from "../src/eta.ts";
import { foldActivity } from "../src/fold.ts";
import { EventLog } from "../src/log.ts";
import { deriveMetrics } from "../src/metrics.ts";
import { Store } from "../src/store.ts";
import type { CardModel } from "../src/ui/card.ts";
import { renderBoard } from "../src/ui/page.ts";
import { renderTable } from "../src/ui/table.ts";

function ev(e: Partial<FlightDeckEvent> & { kind: FlightDeckEvent["kind"]; activityId: string; ts: string }): FlightDeckEvent {
  return e as FlightDeckEvent;
}

function activeModel(id: string): CardModel {
  const events = [
    ev({ kind: "activity_start", activityId: id, ts: "2026-07-07T10:00:00Z", activityType: "campaign", label: id, detail: { planTotal: 4 } }),
    ev({ kind: "step", activityId: id, ts: "2026-07-07T10:05:00Z", label: "promoted", wave: "1" }),
  ];
  const view = foldActivity(events);
  const metrics = deriveMetrics(events);
  return { view, metrics, eta: computeEta(view, metrics) };
}

describe("renderTable — one row per activity", () => {
  test("N models render N tbody rows", () => {
    for (const n of [1, 3, 7]) {
      const models = Array.from({ length: n }, (_, i) => activeModel(`a${i}`));
      const html = renderTable(models);
      const rows = (html.match(/<tr class="fd-row"/g) ?? []).length;
      expect(rows).toBe(n);
    }
  });

  test("empty model list renders zero rows (no crash)", () => {
    const html = renderTable([]);
    expect((html.match(/<tr class="fd-row"/g) ?? []).length).toBe(0);
  });

  test("row is dense: title, kind, status, progress, machine, blocked-on-you", () => {
    const html = renderTable([activeModel("Blueshift")]);
    expect(html).toContain("Blueshift");
    expect(html).toContain("campaign");
    expect(html).toContain("1 / 4 waves");
    expect(html).toContain("fd-row-machine");
    expect(html).toContain("fd-row-blocked");
  });
});

describe("staleness on the table row (cc-workflow#1146 step 2, FLIGHTDECK_AXIOMS AX-5)", () => {
  test("no clock injected at all ⇒ no data-stale on the row, and an EMPTY last-event cell (not a fabricated '—')", () => {
    const html = renderTable([activeModel("a"), activeModel("b")]);
    expect(html).not.toContain("data-stale");
    expect(html).toContain('<td class="fd-row-lastevent"></td>');
  });

  test("opts.clock marks the <tr> AND the last-event cell for the stale row only", () => {
    const html = renderTable([activeModel("stale-x"), activeModel("fresh-y")], {
      clock: (m) => ({
        stale: m.view.activityId === "stale-x",
        ageMs: m.view.activityId === "stale-x" ? 3_700_000 : 10_000,
      }),
    });
    expect(html).toMatch(/<tr class="fd-row" data-activity-id="stale-x" data-status="active" data-stale="true"/);
    expect(html).toMatch(/<tr class="fd-row" data-activity-id="fresh-y" data-status="active" data-stale="false"/);
    expect(html).toContain("1h 1m"); // 3_700_000ms formatted
    expect(html).toContain("10s");
  });

  test("clock injected but age unknowable (ageMs: null) ⇒ a NAMED hole in the last-event cell, never a fabricated dash (AX-2)", () => {
    const html = renderTable([activeModel("a")], { clock: () => ({ stale: false, ageMs: null }) });
    expect(html).toContain("fd-row-lastevent fd-row-lastevent-hole");
    expect(html).toContain("age unknown");
  });

  test("negative age ⇒ a named clock-skew hole in the last-event cell, never a fabricated '0s'", () => {
    const html = renderTable([activeModel("a")], { clock: () => ({ stale: false, ageMs: -1_000 }) });
    const lastEventCell = html.match(/<td class="fd-row-lastevent[^>]*>([^<]*)</)?.[1];
    expect(html).toContain("fd-row-lastevent fd-row-lastevent-hole");
    expect(lastEventCell).toBe("clock skew");
  });

  test("the table header carries a 'last event' column", () => {
    const html = renderTable([activeModel("a")]);
    expect(html).toContain("<th>last event</th>");
  });
});

describe("renderTable — headless row (#31, AX-2)", () => {
  test("a headless activity's progress cell reads 'no declared type', not '0 / ?'", () => {
    const events = [
      ev({ kind: "step", activityId: "phantom", ts: "2026-07-07T10:00:00Z", label: "some-step" }),
    ];
    const view = foldActivity(events);
    const metrics = deriveMetrics(events);
    const model: CardModel = { view, metrics, eta: computeEta(view, metrics) };
    const html = renderTable([model]);
    expect(html).toContain("no declared type");
    expect(html).not.toContain("0 / ?");
    expect(html).toContain("headless"); // the kind column
  });
});

describe("per-lane toggle defaults (R-13)", () => {
  let dir: string;
  let store: Store;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fd-table-"));
    store = new Store({ log: new EventLog(join(dir, "events.jsonl")), dbPath: ":memory:" });
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("Active lane defaults to cards, Closed lane defaults to table; toggles are independent", () => {
    // one active campaign, one closed campaign
    store.append(ev({ kind: "activity_start", activityId: "act1", ts: "2026-07-07T10:00:00Z", activityType: "campaign", label: "Active", detail: { planTotal: 3 } }));
    store.append(ev({ kind: "activity_start", activityId: "clo1", ts: "2026-07-07T09:00:00Z", activityType: "float", label: "Closed", detail: { cord: 6 } }));
    store.append(ev({ kind: "activity_end", activityId: "clo1", ts: "2026-07-07T09:30:00Z" }));

    // Inject a fixed clock so the open campaign (last event 10:00) is NOT stale under
    // the 15-min threshold and stays in the Active lane (the P4 watcher would otherwise
    // move a long-past-dated fixture into Idle). Idle-lane behaviour is covered in
    // watcher.test.ts.
    const board = renderBoard(store, {
      now: Date.parse("2026-07-07T10:10:00Z"),
      staleMs: 15 * 60 * 1000,
    });
    expect(board).toContain('data-lane="active" data-layout="cards"');
    expect(board).toContain('data-lane="closed" data-layout="table"');
    // one independent toggle button per lane
    expect(board).toContain('data-action="toggle-layout" data-lane="active"');
    expect(board).toContain('data-action="toggle-layout" data-lane="closed"');
    // both representations present in each lane (CSS decides which is visible)
    expect(board).toContain("fd-lane-cards");
    expect(board).toContain("fd-lane-table");
  });

  test("empty store renders an empty board, not an empty lane", () => {
    expect(renderBoard(store)).toContain("no activities");
  });
});
