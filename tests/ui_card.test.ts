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

describe("work-items done/total cell — campaign scope only (cc-workflow#1154)", () => {
  test("a campaign card with no shipped denominator shows a NAMED hole, never '0 / ?' (AX-2)", () => {
    // AX-2: the pair is atomic. A numerator is meaningless without a known
    // denominator — "0 / ?" is a false "we've observed zero", not a hole.
    const html = renderCard(campaignModel());
    expect(html).toContain(">work items (campaign)<");
    expect(html).not.toContain("0 / ?");
    expect(html).toContain('class="fd-metric-hole"');
    expect(html).toContain("workItemsTotal denominator"); // names WHICH hole this is
  });

  test("a float card never shows the work-items cell — not applicable, not a hole", () => {
    const html = renderCard(floatModel());
    expect(html).not.toContain("work items (campaign)");
    expect(html).not.toContain("work items (wave");
  });

  test("a campaign with workItemsTotal + closed work items shows the real fraction", () => {
    const m = model([
      ev({ kind: "activity_start", activityId: "wi1", ts: "2026-08-23T10:00:00Z", activityType: "campaign", detail: { planTotal: 7, workItemsTotal: 5 } }),
      ev({ kind: "step", activityId: "wi1", ts: "2026-08-23T10:05:00Z", action: "close-issue", label: "owner/repo#1" }),
      ev({ kind: "step", activityId: "wi1", ts: "2026-08-23T10:06:00Z", action: "close-issue", label: "owner/repo#2" }),
    ]);
    const html = renderCard(m);
    expect(html).toContain(">work items (campaign)<");
    expect(html).toContain("2 / 5");
  });
});

describe("work-items done/total cell — wave scope (cc-workflow#1157)", () => {
  test("no current wave ⇒ a NAMED hole distinct from the 'no denominator shipped' hole", () => {
    const m = model([
      ev({ kind: "activity_start", activityId: "wwc0", ts: "2026-08-24T10:00:00Z", activityType: "campaign", detail: { planTotal: 2 } }),
      // no wave-carrying event at all — currentWave stays null.
    ]);
    const html = renderCard(m);
    expect(html).toContain(">work items (wave)<");
    expect(html).not.toContain("0 / ?");
    expect(html).toContain("no wave is current");
  });

  test("a current wave with no waveWorkItems entry ⇒ a hole naming THAT gap specifically", () => {
    const m = model([
      ev({ kind: "activity_start", activityId: "wwc1", ts: "2026-08-24T10:00:00Z", activityType: "campaign", detail: { planTotal: 2, waveWorkItems: { "wave-1": 3 } } }),
      // close-issue's own `wave` no longer sets currentWave (review round
      // 3) — a real position event establishes it.
      ev({ kind: "phase", activityId: "wwc1", ts: "2026-08-24T10:04:00Z", wave: "wave-9", action: "planning" }),
      ev({ kind: "step", activityId: "wwc1", ts: "2026-08-24T10:05:00Z", action: "close-issue", label: "owner/repo#1", wave: "wave-9" }),
    ]);
    const html = renderCard(m);
    // The label names the wave (code review: a bare "work items (wave)" label
    // hides which wave a possibly-stale currentWave actually names).
    expect(html).toContain(">work items (wave-9)<");
    expect(html).not.toContain("0 / ?");
    expect(html).toContain("no entry for the current wave");
  });

  test("a current wave, but NO waveWorkItems map shipped at all ⇒ a hole naming THAT gap, not the 'no entry' one", () => {
    // Code review (Important #1): the first draft collapsed this into the
    // "map has no entry" copy, which is false when there's no map at all —
    // the dominant shape for every campaign card built from a pre-#1157 head.
    const m = model([
      ev({ kind: "activity_start", activityId: "wwc3", ts: "2026-08-24T10:00:00Z", activityType: "campaign", detail: { planTotal: 2 } }), // no waveWorkItems key
      ev({ kind: "phase", activityId: "wwc3", ts: "2026-08-24T10:04:00Z", wave: "wave-1", action: "planning" }),
      ev({ kind: "step", activityId: "wwc3", ts: "2026-08-24T10:05:00Z", action: "close-issue", label: "owner/repo#1", wave: "wave-1" }),
    ]);
    const html = renderCard(m);
    expect(html).toContain(">work items (wave-1)<");
    expect(html).not.toContain("0 / ?");
    expect(html).toContain("no activity_start on this campaign has shipped a waveWorkItems map");
    expect(html).not.toContain("no entry for the current wave");
  });

  test("a campaign with waveWorkItems + a current-wave close shows the real fraction, wave id in the label", () => {
    const m = model([
      ev({ kind: "activity_start", activityId: "wwc2", ts: "2026-08-24T10:00:00Z", activityType: "campaign", detail: { planTotal: 2, waveWorkItems: { "wave-1": 3, "wave-2": 2 } } }),
      ev({ kind: "phase", activityId: "wwc2", ts: "2026-08-24T10:04:00Z", wave: "wave-1", action: "planning" }),
      ev({ kind: "step", activityId: "wwc2", ts: "2026-08-24T10:05:00Z", action: "close-issue", label: "owner/repo#1", wave: "wave-1" }),
    ]);
    const html = renderCard(m);
    expect(html).toContain(">work items (wave-1)<");
    expect(html).toContain("1 / 3");
  });

  test("a float card never shows the wave-scope work-items cell either", () => {
    const html = renderCard(floatModel());
    expect(html).not.toContain("work items (wave");
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

describe("staleness on the card (cc-workflow#1146 step 2, FLIGHTDECK_AXIOMS AX-5)", () => {
  test("no clock injected at all ⇒ no data-stale attribute, no age chip (existing callers render unchanged)", () => {
    const html = renderCard(campaignModel());
    expect(html).not.toContain("data-stale");
    expect(html).not.toContain("fd-card-age");
  });

  test("clock injected, stale + a known age ⇒ data-stale=true on the card AND a visible age readout", () => {
    const html = renderCard(campaignModel(), { clock: { stale: true, ageMs: 62_000 } });
    expect(html).toContain('<article class="fd-card"');
    expect(html).toMatch(/data-status="active" data-stale="true" data-expanded/); // the article's own marker
    expect(html).toContain('class="fd-card-age" data-stale="true"');
    expect(html).toContain("1m 2s ago");
  });

  test("clock injected, fresh with a known age still shows the age, un-amber (AX-5: reported always, not only when stale)", () => {
    const html = renderCard(campaignModel(), { clock: { stale: false, ageMs: 5_000 } });
    expect(html).toContain('class="fd-card-age" data-stale="false"');
    expect(html).toContain("5s ago");
  });

  test("clock injected but age unknowable (ageMs: null) ⇒ a NAMED hole, never a fabricated '— ago' or silent omission (AX-2)", () => {
    const html = renderCard(campaignModel(), { clock: { stale: true, ageMs: null } });
    expect(html).toContain("fd-card-age fd-card-age-hole");
    expect(html).toContain("age unknown");
    expect(html).toContain('title="no event on this activity carries a parseable timestamp"');
  });

  test("negative age (event timestamp ahead of the server clock) ⇒ a named clock-skew hole, never a fabricated '0s ago'", () => {
    const html = renderCard(campaignModel(), { clock: { stale: false, ageMs: -5_000 } });
    expect(html).toContain("fd-card-age fd-card-age-hole");
    expect(html).toContain("clock skew");
    expect(html).not.toContain("0s ago");
    expect(html).toContain('title="event timestamp is ahead of the FlightDeck server clock"');
  });

  test("AX-5 guard: staleness never touches the status badge/text — 'active' stays 'active' whether stale or not", () => {
    const fresh = renderCard(campaignModel(), { clock: { stale: false, ageMs: 5_000 } });
    const stale = renderCard(campaignModel(), { clock: { stale: true, ageMs: 999_000 } });
    const statusOf = (html: string) => html.match(/fd-badge-status[^>]*>([^<]+)</)?.[1];
    expect(statusOf(fresh)).toBe(statusOf(stale));
    expect(stale).toContain('data-status="active"'); // lifecycle status is untouched by staleness
  });
});

describe("headless card (#31, AX-2)", () => {
  test("a headless activity shows 'no declared type', never '0 / ?' or a waves/legs count", () => {
    const m = model([
      ev({ kind: "step", activityId: "phantom", ts: "2026-07-07T10:00:00Z", label: "some-step" }),
      ev({ kind: "ci_wait", activityId: "phantom", ts: "2026-07-07T10:05:00Z", action: "waiting-ci" }),
    ]);
    expect(m.view.activityType).toBe("headless");
    const html = renderCard(m);
    expect(html).toContain("no declared type");
    expect(html).not.toContain("0 / ?");
    expect(html).not.toContain(">waves<");
    expect(html).not.toContain(">legs<");
    expect(html).toContain('data-type="headless"');
  });

  test("a bare activity_start with no activityType is headless too, and the copy never claims otherwise (#31 code-review finding)", () => {
    // The dominant live shape (cc-workflow state.py:664): a REAL activity_start,
    // just with no `activityType`. Distinct from a stream with no activity_start at
    // all — both classify headless, but only the copy for the first must not lie.
    const m = model([
      ev({ kind: "activity_start", activityId: "deploy-smoke", ts: "2026-07-07T10:00:00Z", label: "deploy-smoke" }),
    ]);
    expect(m.view.activityType).toBe("headless");
    const html = renderCard(m);
    expect(html).toContain("no declared type");
    expect(html).not.toContain("no activity_start seen");
  });

  test("mutation guard: a plausible wrong fix (defaulting cord to fabricate a float band) would leak a numeric ETA — it must not", () => {
    // headless activities that happen to emit `leg` steps (never declared float)
    // must not get a real float ETA estimate — computeEta has an explicit headless
    // branch precisely to prevent that.
    const m = model([
      ev({ kind: "step", activityId: "phantom2", ts: "2026-07-07T10:00:00Z", label: "leg", detail: { leg: 1 } }),
    ]);
    expect(m.eta.machineTimeRemainingMs).toBeNull();
    expect(m.eta.kind).toBe("headless");
  });

  test("a CLOSED headless activity gets a real 0, not null — that fact is activity_end, not a type-dependent estimate", () => {
    const m = model([
      ev({ kind: "step", activityId: "phantom3", ts: "2026-07-07T10:00:00Z", label: "some-step" }),
      ev({ kind: "activity_end", activityId: "phantom3", ts: "2026-07-07T10:05:00Z" }),
    ]);
    expect(m.view.activityType).toBe("headless");
    expect(m.view.status).toBe("closed");
    expect(m.eta.machineTimeRemainingMs).toBe(0);
  });

  test("the ETA tooltip names the real reason for a headless hole, not a campaign-shaped one", () => {
    const m = model([
      ev({ kind: "step", activityId: "phantom4", ts: "2026-07-07T10:00:00Z", label: "some-step" }),
    ]);
    const html = renderCard(m);
    expect(html).toContain("no declared campaign/float type");
    expect(html).not.toContain("no completed wave to set a rate");
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

  test("renderGrid with no opts emits no data-stale on any card (same as renderCard's no-clock case)", () => {
    const html = renderGrid([campaignModel("x")]);
    expect(html).not.toContain("data-stale");
  });

  test("laneFor derives lane from folded status only", () => {
    expect(laneFor(campaignModel().view)).toBe("active");
    const closed = model([
      ev({ kind: "activity_start", activityId: "z", ts: "2026-07-07T10:00:00Z", activityType: "campaign", detail: { planTotal: 2 } }),
      ev({ kind: "activity_end", activityId: "z", ts: "2026-07-07T10:30:00Z" }),
    ]);
    expect(laneFor(closed.view)).toBe("closed");
  });

  test("opts.clock fans out per-model, keyed by the SAME model the callback receives", () => {
    const a = campaignModel("stale-one");
    const b = campaignModel("fresh-two");
    const html = renderGrid([a, b], {
      clock: (m) => ({
        stale: m.view.activityId === "stale-one",
        ageMs: m.view.activityId === "stale-one" ? 900_000 : 3_000,
      }),
    });
    // one card is marked stale, the other is not (each card carries the marker
    // twice — the <article> itself and its age chip — hence 2 per card, not 1).
    expect((html.match(/data-stale="true"/g) ?? []).length).toBe(2);
    expect((html.match(/data-stale="false"/g) ?? []).length).toBe(2);
    expect(html).toContain("15m ago");
    expect(html).toContain("3s ago");
  });
});

describe("activityType conflict marker (fd#41)", () => {
  test("no marker on an ordinary card", () => {
    const html = renderCard(campaignModel());
    expect(html).not.toContain("fd-chip-type-conflict");
  });

  test("visible marker when two different declared types land on one activityId", () => {
    const conflicted = model([
      ev({ kind: "step", activityId: "conflict1", ts: "t0", activityType: "campaign", label: "promoted", wave: "1" }),
      ev({ kind: "step", activityId: "conflict1", ts: "t1", activityType: "float", label: "leg", detail: { leg: 1 } }),
    ]);
    expect(conflicted.view.activityTypeConflict).toBe(true);
    const html = renderCard(conflicted);
    expect(html).toContain("fd-chip-type-conflict");
    // AX-2's "name the kind of hole" — a title, not just a bare marker.
    expect(html).toContain("activityType changed mid-stream");
  });
});
