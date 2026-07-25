// S3.1 / #868 — one-anatomy card + card grid.
//
// Proves the load-bearing invariant: a campaign and a float render from ONE identical
// card anatomy, differing only in the estimator label ("waves" vs "legs"). Models are
// built through the real fold + metrics + eta (pure consumer, no status re-derivation).

import { describe, expect, test } from "bun:test";

import type { FlightDeckEvent } from "../src/events/contract.ts";
import { computeEta } from "../src/eta.ts";
import { foldActivity } from "../src/fold.ts";
import { deriveMetrics } from "../src/metrics.ts";
import { type CardModel, estimatorLabel, renderCard } from "../src/ui/card.ts";
import { laneFor, renderGrid } from "../src/ui/grid.ts";

function ev(e: Partial<FlightDeckEvent> & { kind: FlightDeckEvent["kind"]; activityId: string; ts: string }): FlightDeckEvent {
  return e as FlightDeckEvent;
}

function model(events: FlightDeckEvent[]): CardModel {
  const view = foldActivity(events);
  const metrics = deriveMetrics(events);
  const eta = computeEta(view, metrics);
  return { view, metrics, eta };
}

// A campaign: 3 of 7 waves promoted.
function campaignModel(id = "camp1"): CardModel {
  return model([
    ev({ kind: "activity_start", activityId: id, ts: "2026-07-07T10:00:00Z", activityType: "campaign", label: "Blueshift", detail: { planTotal: 7 } }),
    ev({ kind: "step", activityId: id, ts: "2026-07-07T10:05:00Z", label: "promoted", wave: "1" }),
    ev({ kind: "step", activityId: id, ts: "2026-07-07T10:10:00Z", label: "promoted", wave: "2" }),
    ev({ kind: "step", activityId: id, ts: "2026-07-07T10:15:00Z", label: "promoted", wave: "3" }),
  ]);
}

// A float: 3 of 7 legs, same numbers as the campaign so the ONLY textual difference
// between the two cards is the estimator label.
function floatModel(id = "float1"): CardModel {
  return model([
    ev({ kind: "activity_start", activityId: id, ts: "2026-07-07T10:00:00Z", activityType: "float", label: "Blueshift", detail: { cord: 7 } }),
    ev({ kind: "step", activityId: id, ts: "2026-07-07T10:05:00Z", label: "leg", detail: { leg: 1 } }),
    ev({ kind: "step", activityId: id, ts: "2026-07-07T10:10:00Z", label: "leg", detail: { leg: 2 } }),
    ev({ kind: "step", activityId: id, ts: "2026-07-07T10:15:00Z", label: "leg", detail: { leg: 3 } }),
  ]);
}

describe("estimator label — the single campaign/float difference", () => {
  test("campaign counts waves, float counts legs", () => {
    expect(estimatorLabel("campaign")).toBe("waves");
    expect(estimatorLabel("float")).toBe("legs");
  });
});

describe("one card anatomy renders both kinds", () => {
  const camp = renderCard(campaignModel());
  const flt = renderCard(floatModel());

  test("both cards use the identical anatomy (same structural markers)", () => {
    const markers = [
      "fd-card",
      "fd-card-head",
      "fd-badge-status",
      "fd-vitals",
      "fd-progress",
      "fd-eta-machine",
      "fd-eta-blocked",
      "fd-metrics-grid",
    ];
    for (const m of markers) {
      expect(camp).toContain(m);
      expect(flt).toContain(m);
    }
  });

  test("campaign shows 'waves', float shows 'legs'", () => {
    expect(camp).toContain(">waves<");
    expect(flt).toContain(">legs<");
    expect(camp).not.toContain(">legs<");
    expect(flt).not.toContain(">waves<");
  });

  test("progress reads identically (3 / 7) for both — only the label differs", () => {
    expect(camp).toContain("3 / 7");
    expect(flt).toContain("3 / 7");
  });

  test("card carries type + status data attributes for the client/lane logic", () => {
    expect(camp).toContain('data-type="campaign"');
    expect(flt).toContain('data-type="float"');
    expect(camp).toContain('data-status="active"');
  });
});

describe("R-14 vitals row + expandable metrics grid", () => {
  test("active defaults to expanded; explicit collapse flips data-expanded", () => {
    const m = campaignModel();
    expect(renderCard(m)).toContain('data-expanded="true"');
    expect(renderCard(m, { expanded: false })).toContain('data-expanded="false"');
  });

  test("metrics grid is always emitted (CSS hides it when collapsed)", () => {
    // wall/machine/blocked-on-you/ci-wait + collision/confidence/drift/tokens
    const html = renderCard(campaignModel());
    for (const label of ["wall", "machine", "blocked-on-you", "ci-wait", "collision", "confidence", "drift", "tokens"]) {
      expect(html).toContain(`>${label}<`);
    }
  });

  test("seamed-absent token metric renders an em dash, never a fabricated 0", () => {
    const html = renderCard(campaignModel());
    // token cell present with an em-dash value (no tokens metric emitted).
    expect(html).toContain("tokens");
    expect(html).toContain("—");
  });
});

describe("card header — dev-name title + granular action status (cc#1026)", () => {
  const PROJECT = "github.com/Wave-Engineering/blueshift";

  test("title is the agent Dev-Name when present; full project stays on hover (AC1)", () => {
    const m = model([
      ev({ kind: "activity_start", activityId: "c1", ts: "2026-07-07T10:00:00Z", activityType: "campaign", label: PROJECT, detail: { planTotal: 7 }, agent: "babelfish" }),
      ev({ kind: "step", activityId: "c1", ts: "2026-07-07T10:05:00Z", label: "promoted", wave: "1", agent: "babelfish" }),
    ]);
    const html = renderCard(m);
    expect(html).toContain(">babelfish<"); // dev-name is the visible title
    expect(html).toContain(`title="${PROJECT}"`); // untouched full name on hover
  });

  test("title falls back to the SHORT project name (basename) when no agent (AC1)", () => {
    const m = model([
      ev({ kind: "activity_start", activityId: "c2", ts: "2026-07-07T10:00:00Z", activityType: "campaign", label: PROJECT, detail: { planTotal: 7 } }),
    ]);
    const html = renderCard(m);
    expect(html).toContain(">blueshift<"); // short basename, never the full forge path
    expect(html).not.toContain(`>${PROJECT}<`);
  });

  test("status badge shows the granular action while active, not the coarse 'active' (AC3)", () => {
    const m = model([
      ev({ kind: "activity_start", activityId: "c3", ts: "2026-07-07T10:00:00Z", activityType: "campaign", detail: { planTotal: 7 }, agent: "babelfish" }),
      ev({ kind: "step", activityId: "c3", ts: "2026-07-07T10:05:00Z", label: "promoted", wave: "1" }),
      ev({ kind: "step", activityId: "c3", ts: "2026-07-07T10:06:00Z", action: "promoting", wave: "2" }),
    ]);
    const html = renderCard(m);
    expect(html).toContain(">promoting<"); // granular action is the status text
    expect(html).toContain('data-status="active"'); // raw lifecycle preserved for lane logic
    expect(html).not.toContain(">active<"); // coarse badge text replaced
  });

  test("hyphenated actions display with spaces (AC3)", () => {
    const m = model([
      ev({ kind: "activity_start", activityId: "c4", ts: "2026-07-07T10:00:00Z", activityType: "campaign", detail: { planTotal: 7 } }),
      ev({ kind: "step", activityId: "c4", ts: "2026-07-07T10:06:00Z", action: "awaiting-verdict" }),
    ]);
    expect(renderCard(m)).toContain(">awaiting verdict<");
  });

  test("blocked keeps the human lifecycle text, not the raw action (AC3)", () => {
    const m = model([
      ev({ kind: "activity_start", activityId: "c5", ts: "2026-07-07T10:00:00Z", activityType: "campaign", detail: { planTotal: 7 } }),
      ev({ kind: "blocked_on_human", activityId: "c5", ts: "2026-07-07T10:06:00Z", action: "waiting-on-meatbag" }),
    ]);
    const html = renderCard(m);
    expect(html).toContain(">blocked on you<");
    expect(html).toContain('data-status="blocked"');
  });
});

describe("card grid (default multi-activity view, R-12)", () => {
  test("N models render N cards", () => {
    const html = renderGrid([campaignModel("a"), floatModel("b"), campaignModel("c")]);
    const count = (html.match(/class="fd-card"/g) ?? []).length;
    expect(count).toBe(3);
    expect(html).toContain('class="fd-grid"');
  });

  test("empty grid shows an empty state, not a crash", () => {
    expect(renderGrid([])).toContain("no activities");
  });

  test("laneFor derives lane from folded status only", () => {
    expect(laneFor(campaignModel().view)).toBe("active");
    const closed = model([
      ev({ kind: "activity_start", activityId: "z", ts: "2026-07-07T10:00:00Z", activityType: "campaign", detail: { planTotal: 2 } }),
      ev({ kind: "activity_end", activityId: "z", ts: "2026-07-07T10:30:00Z" }),
    ]);
    expect(laneFor(closed.view)).toBe("closed");
  });
});
