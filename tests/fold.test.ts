// S2.2 / #866 — deterministic fold (IT-04). Canned streams → expected card state.

import { describe, expect, test } from "bun:test";

import type { FlightDeckEvent } from "../src/events/contract.ts";
import { fold, foldActivity } from "../src/fold.ts";

// A canned campaign stream: start (planTotal 5) → planning phase → two promoted
// waves → a coded concern → a confidence metric → blocked on the human.
const campaign: FlightDeckEvent[] = [
  {
    kind: "activity_start",
    activityId: "camp-1",
    ts: "2026-07-07T10:00:00Z",
    activityType: "campaign",
    label: "Blueshift #56",
    detail: { planTotal: 5 },
  },
  { kind: "phase", activityId: "camp-1", ts: "2026-07-07T10:01:00Z", phase: "P1", action: "planning" },
  { kind: "step", activityId: "camp-1", ts: "2026-07-07T10:10:00Z", label: "promoted", wave: "W1" },
  { kind: "step", activityId: "camp-1", ts: "2026-07-07T10:20:00Z", label: "promoted", wave: "W2" },
  {
    kind: "concern",
    activityId: "camp-1",
    ts: "2026-07-07T10:21:00Z",
    concernKind: "gate-override",
    source: "coded",
    wave: "W2",
    logRef: "log://camp-1/W2",
  },
  { kind: "metric", activityId: "camp-1", ts: "2026-07-07T10:22:00Z", metric: "confidence", value: 0.9 },
  { kind: "blocked_on_human", activityId: "camp-1", ts: "2026-07-07T10:25:00Z", action: "waiting-on-meatbag" },
];

describe("foldActivity — campaign", () => {
  const v = foldActivity(campaign);

  test("identity + type + label", () => {
    expect(v.activityId).toBe("camp-1");
    expect(v.activityType).toBe("campaign");
    // last non-empty label wins; here it is the start label (later events carry none).
    expect(v.label).toBe("Blueshift #56");
  });

  test("progress: planTotal + completed waves", () => {
    expect(v.planTotal).toBe(5);
    expect(v.completed).toBe(2);
  });

  test("scope: last-write-wins wave", () => {
    expect(v.currentWave).toBe("W2");
    expect(v.currentPhase).toBe("P1");
  });

  test("status derived from last state-bearing event", () => {
    expect(v.status).toBe("blocked");
  });

  test("currentAction latches the last ACTIVE-lane action; block/ci actions don't (AC3, cc#1026)", () => {
    // The only active-lane (step/phase) action in the stream is the "planning" phase;
    // the trailing blocked_on_human ("waiting-on-meatbag") owns the lifecycle status
    // instead, so it must NOT latch into currentAction (that would show a block action
    // on a card that later re-activates). Metrics/concerns carry no action either.
    expect(v.currentAction).toBe("planning");
    expect(v.status).toBe("blocked");
  });

  test("a re-activated card shows the last active action, not a stale block (AC3, cc#1026)", () => {
    // promoting (active) → hold (block) → action-less promoted step re-activates the card.
    // status returns to active; currentAction must still read "promoting", never "hold".
    const w = foldActivity([
      { kind: "activity_start", activityId: "s", ts: "2026-07-07T10:00:00Z", activityType: "campaign", detail: { planTotal: 3 } },
      { kind: "step", activityId: "s", ts: "2026-07-07T10:01:00Z", action: "promoting", wave: "1" },
      { kind: "blocked_on_human", activityId: "s", ts: "2026-07-07T10:02:00Z", action: "hold" },
      { kind: "step", activityId: "s", ts: "2026-07-07T10:03:00Z", label: "promoted", wave: "1" },
    ] as FlightDeckEvent[]);
    expect(w.status).toBe("active");
    expect(w.currentAction).toBe("promoting");
  });

  test("currentAction is null when no event carries an active-lane action (AC3, cc#1026)", () => {
    const bare = foldActivity([
      { kind: "activity_start", activityId: "x", ts: "2026-07-07T10:00:00Z", activityType: "campaign", detail: { planTotal: 3 } },
      { kind: "step", activityId: "x", ts: "2026-07-07T10:05:00Z", label: "promoted", wave: "1" },
    ] as FlightDeckEvent[]);
    expect(bare.currentAction).toBeNull();
  });

  test("timestamps", () => {
    expect(v.startedAt).toBe("2026-07-07T10:00:00Z");
    expect(v.endedAt).toBeNull();
    expect(v.lastEventTs).toBe("2026-07-07T10:25:00Z");
    expect(v.eventCount).toBe(7);
  });

  test("concerns collected with scope + logRef", () => {
    expect(v.concerns).toHaveLength(1);
    expect(v.openConcerns).toBe(1);
    expect(v.concerns[0]).toMatchObject({
      concernKind: "gate-override",
      source: "coded",
      logRef: "log://camp-1/W2",
      scope: { wave: "W2" },
    });
  });

  test("metrics: latest value by name", () => {
    expect(v.metrics["confidence"]).toMatchObject({ value: 0.9 });
  });
});

describe("foldActivity — status + determinism", () => {
  test("activity_end ⇒ closed (the single 'closed' code path)", () => {
    const closed = foldActivity([
      ...campaign,
      { kind: "activity_end", activityId: "camp-1", ts: "2026-07-07T11:00:00Z" },
    ]);
    expect(closed.status).toBe("closed");
    expect(closed.endedAt).toBe("2026-07-07T11:00:00Z");
  });

  test("ci_wait last ⇒ ci-wait status", () => {
    const v = foldActivity([
      { kind: "activity_start", activityId: "c", ts: "t0", activityType: "campaign" },
      { kind: "ci_wait", activityId: "c", ts: "t1", action: "waiting-ci" },
    ]);
    expect(v.status).toBe("ci-wait");
  });

  test("fold is deterministic (same input ⇒ deep-equal output)", () => {
    expect(foldActivity(campaign)).toEqual(foldActivity(campaign));
    expect(JSON.stringify(foldActivity(campaign))).toBe(JSON.stringify(foldActivity(campaign)));
  });
});

describe("foldActivity — float", () => {
  const float: FlightDeckEvent[] = [
    {
      kind: "activity_start",
      activityId: "float-9",
      ts: "2026-07-07T09:00:00Z",
      activityType: "float",
      detail: { cord: 12 },
    },
    { kind: "step", activityId: "float-9", ts: "2026-07-07T09:05:00Z", label: "leg", detail: { leg: 1 } },
    { kind: "metric", activityId: "float-9", ts: "2026-07-07T09:05:30Z", metric: "findings-velocity", value: 4 },
    { kind: "step", activityId: "float-9", ts: "2026-07-07T09:10:00Z", label: "leg", detail: { leg: 2 } },
    { kind: "metric", activityId: "float-9", ts: "2026-07-07T09:10:30Z", metric: "findings-velocity", value: 1 },
    { kind: "step", activityId: "float-9", ts: "2026-07-07T09:15:00Z", label: "leg", detail: { leg: 3 } },
    { kind: "metric", activityId: "float-9", ts: "2026-07-07T09:15:30Z", metric: "findings-velocity", value: 0 },
  ];
  const v = foldActivity(float);

  test("type + cord + legs", () => {
    expect(v.activityType).toBe("float");
    expect(v.cord).toBe(12);
    expect(v.legs).toBe(3);
  });

  test("findings-velocity trend retained in order", () => {
    expect(v.findingsVelocity).toEqual([4, 1, 0]);
  });

  test("no promoted waves ⇒ completed 0, status active", () => {
    expect(v.completed).toBe(0);
    expect(v.status).toBe("active");
  });
});

describe("foldActivity — headless activities are not phantom campaigns (#31, AX-2)", () => {
  test("step + ci_wait with no activity_start does NOT type as campaign", () => {
    // Exactly the live shape from #31: real work events, never a lifecycle head.
    const v = foldActivity([
      { kind: "step", activityId: "phantom-1", ts: "t0", label: "some-step" },
      { kind: "ci_wait", activityId: "phantom-1", ts: "t1", action: "waiting-ci" },
    ] as FlightDeckEvent[]);
    expect(v.activityType).toBe("headless");
    expect(v.activityType).not.toBe("campaign");
  });

  test("no declared type anywhere, including an activity_start with none ⇒ headless", () => {
    const v = foldActivity([
      { kind: "activity_start", activityId: "bare", ts: "t0" },
      { kind: "step", activityId: "bare", ts: "t1", label: "x" },
    ] as FlightDeckEvent[]);
    expect(v.activityType).toBe("headless");
  });

  test("declared campaign/float on a NON-head event is honored, symmetric with session (#31/AX-6)", () => {
    // A `step` (not activity_start) carrying activityType still classifies the
    // activity — the fold must not require a head to learn the real type any more
    // than it requires one to learn a session.
    const campaignHeadless = foldActivity([
      { kind: "step", activityId: "late-campaign", ts: "t0", activityType: "campaign", label: "promoted", wave: "1" },
    ] as FlightDeckEvent[]);
    expect(campaignHeadless.activityType).toBe("campaign");

    const floatHeadless = foldActivity([
      { kind: "step", activityId: "late-float", ts: "t0", activityType: "float", label: "leg", detail: { leg: 1 } },
    ] as FlightDeckEvent[]);
    expect(floatHeadless.activityType).toBe("float");
  });

  test("a real activity_start still classifies as before (no regression)", () => {
    expect(foldActivity(campaign).activityType).toBe("campaign");
  });

  test("session classification still wins over a head regardless (AC6, #7 unchanged)", () => {
    const v = foldActivity([
      { kind: "activity_start", activityId: "s", ts: "t0", activityType: "session", phase: "session" },
      { kind: "step", activityId: "s", ts: "t1", phase: "session" },
    ] as FlightDeckEvent[]);
    expect(v.activityType).toBe("session");
  });
});

describe("foldActivity — session classification (#7 / cc-workflow#947)", () => {
  test("legacy shape: phase 'session' with no activityType classifies as session", () => {
    // EXACTLY the production shape flooding the deck (cc-workflow#947): the S1.7
    // hook emits phase:"session" and no activityType. Assertion-liveness probe
    // (#922): before the fix this folded to "campaign" (the default) — verified
    // failing against unmodified fold.ts before implementing.
    const v = foldActivity([
      { kind: "activity_start", activityId: "session:aaa", ts: "2026-07-22T10:00:00Z", phase: "session", agent: "malory", label: "session-open" },
      { kind: "step", activityId: "session:aaa", ts: "2026-07-22T10:05:00Z", phase: "session", agent: "malory", label: "session-idle" },
    ]);
    expect(v.activityType).toBe("session");
  });

  test("declared shape: activityType 'session' (new emitter) classifies as session", () => {
    const v = foldActivity([
      { kind: "activity_start", activityId: "session:bbb", ts: "2026-07-22T10:00:00Z", activityType: "session", phase: "session", agent: "babelfish", host: "malory", label: "session-open" },
    ]);
    expect(v.activityType).toBe("session");
  });

  test("orphan steps (no activity_start) with phase 'session' classify as session", () => {
    // A session opened before the emitter installed has steps but no start event.
    const v = foldActivity([
      { kind: "step", activityId: "session:ccc", ts: "2026-07-22T10:05:00Z", phase: "session", agent: "malory", label: "session-idle" },
    ]);
    expect(v.activityType).toBe("session");
  });

  test("campaign/float classification is unchanged by a non-session phase", () => {
    const v = foldActivity([
      { kind: "activity_start", activityId: "f", ts: "t0", activityType: "float", detail: { cord: 3 } },
      { kind: "phase", activityId: "f", ts: "t1", phase: "P1" },
    ]);
    expect(v.activityType).toBe("float");
  });

  test("host folds last-write-wins; absent host ⇒ null", () => {
    const v = foldActivity([
      { kind: "activity_start", activityId: "session:ddd", ts: "t0", activityType: "session", host: "malory" },
      { kind: "step", activityId: "session:ddd", ts: "t1", host: "sterling" },
    ]);
    expect(v.host).toBe("sterling");
    const bare = foldActivity([
      { kind: "activity_start", activityId: "c", ts: "t0", activityType: "campaign" },
    ]);
    expect(bare.host).toBeNull();
  });
});

describe("foldActivity — synthetic marker (#7)", () => {
  test("detail.synthetic true on any event marks the activity synthetic", () => {
    const v = foldActivity([
      { kind: "activity_start", activityId: "e2e-smoke", ts: "t0", activityType: "campaign", detail: { synthetic: true } },
      { kind: "step", activityId: "e2e-smoke", ts: "t1", label: "promoted", wave: "W1" },
    ]);
    expect(v.synthetic).toBe(true);
    // marker on a later event (not just activity_start) also marks it
    const late = foldActivity([
      { kind: "activity_start", activityId: "smoke-2", ts: "t0", activityType: "campaign" },
      { kind: "step", activityId: "smoke-2", ts: "t1", detail: { synthetic: true } },
    ]);
    expect(late.synthetic).toBe(true);
  });

  test("no marker ⇒ synthetic false (real activities unaffected)", () => {
    expect(foldActivity(campaign).synthetic).toBe(false);
  });
});

describe("foldActivity — honest token stub", () => {
  test("metric value null is preserved (never fabricated, #853 gate)", () => {
    const v = foldActivity([
      { kind: "activity_start", activityId: "c", ts: "t0", activityType: "campaign" },
      { kind: "metric", activityId: "c", ts: "t1", metric: "tokens", value: null },
    ]);
    expect(v.metrics["tokens"]).toEqual({ value: null, unit: null, ts: "t1" });
  });
});

describe("fold — multiple independent activities", () => {
  test("groups by activityId, folds each independently", () => {
    const mixed: FlightDeckEvent[] = [
      { kind: "activity_start", activityId: "a", ts: "t0", activityType: "campaign", detail: { planTotal: 3 } },
      { kind: "activity_start", activityId: "b", ts: "t0", activityType: "float", detail: { cord: 8 } },
      { kind: "step", activityId: "a", ts: "t1", label: "promoted", wave: "W1" },
      { kind: "step", activityId: "b", ts: "t1", label: "leg", detail: { leg: 1 } },
    ];
    const m = fold(mixed);
    expect(m.size).toBe(2);
    expect(m.get("a")?.completed).toBe(1);
    expect(m.get("a")?.legs).toBe(0);
    expect(m.get("b")?.legs).toBe(1);
    expect(m.get("b")?.completed).toBe(0);
  });
});

// --- promotion dedup (#27) ----------------------------------------------------
//
// The promote emit is not a deterministic call — it is a line appended to an
// agent's prompt asking it to run a command "ONCE" (cc-workflow#1138). Plan #103
// emitted TEN `promoted` rows for THREE waves. These pin the collector against
// that, and against over-correcting into a suppression bug.

const promo = (wave: string | null, ts: string, phase?: string): FlightDeckEvent =>
  ({
    kind: "step",
    activityId: "dedup-1",
    ts,
    label: "promoted",
    ...(wave === null ? {} : { wave }),
    ...(phase === undefined ? {} : { phase }),
  }) as FlightDeckEvent;

const head: FlightDeckEvent = {
  kind: "activity_start",
  activityId: "dedup-1",
  ts: "2026-08-20T12:49:17Z",
  activityType: "campaign",
  label: "automated-estimator",
  detail: { planTotal: 3 },
};

describe("promotion dedup (#27)", () => {
  test("the REAL #103 shape folds to 3/3, not 10/3", () => {
    // Exactly what the pre-wipe corpus contained: wave-1c ×1 (hand-merged),
    // wave-2c ×4 and wave-3c ×5 (both through the agent-driven tee).
    const events: FlightDeckEvent[] = [
      head,
      // Producer-faithful: wave-1c was hand-merged (state.py `complete`, no
      // phase); 2c/3c went through the tee (phase "Promote"). An earlier draft
      // omitted phase entirely, which made all ten rows one producer shape — so
      // the suite structurally could not see the (wave,phase) keying bug.
      promo("wave-1c", "2026-08-20T15:04:00Z"),
      ...Array.from({ length: 4 }, (_, i) =>
        promo("wave-2c", `2026-08-20T15:5${i}:00Z`, "Promote")),
      ...Array.from({ length: 5 }, (_, i) =>
        promo("wave-3c", `2026-08-20T17:0${i}:00Z`, "Promote")),
    ];
    expect(events.filter((e) => (e as { label?: string }).label === "promoted")).toHaveLength(10);

    const v = foldActivity(events);
    expect(v.completed).toBe(3);
    expect(v.planTotal).toBe(3);
    expect(v.eventCount).toBe(events.length);
    expect(v.lastEventTs).toBe("2026-08-20T17:04:00Z");
  });

  test("distinct waves each still count — guards against over-dedup", () => {
    // The failure mode of a careless fix: collapsing everything to 1.
    const v = foldActivity([
      head,
      promo("W1", "2026-08-20T10:00:00Z"),
      promo("W2", "2026-08-20T11:00:00Z"),
      promo("W3", "2026-08-20T12:00:00Z"),
    ]);
    expect(v.completed).toBe(3);
  });

  test("BOTH real producers for one wave count ONCE", () => {
    // This test previously asserted the OPPOSITE — that a differing `phase` meant
    // a distinct promotion — and that assumption would have left a systematic 2x
    // over-count. There are exactly two producers of label:"promoted" and they
    // disagree on phase for the same promotion:
    //
    //   state.py:1298                → wave, NO phase
    //   per-wave-workflow.js:476     → wave, phase "Promote"
    //
    // The same terminal prompt instructs both, and wavemachine/SKILL.md pins
    // FLIGHTDECK_ACTIVITY_ID so both land on one card by design. Keying on phase
    // would render a clean 3-wave campaign as 6/3 — worse than the flaky bug,
    // because it is stable and looks nearly right.
    const v = foldActivity([
      head,
      promo("wave-1c", "2026-08-20T15:04:00Z"),              // state.py complete
      promo("wave-1c", "2026-08-20T15:04:01Z", "Promote"),   // the tee
      promo("wave-1c", "2026-08-20T15:04:02Z", "Promote"),   // tee re-fire
    ]);
    expect(v.completed).toBe(1);
  });

  test("NON-ADJACENT duplicates still collapse", () => {
    // Guards an implementation that remembers only the LAST promotion. Every
    // other duplicate in this suite is adjacent to its twin, so a single
    // `lastKey` variable would pass all of them — including the mutations run
    // against the Set. Realistic: a late tee re-fire after the next wave started,
    // or a resume replaying wave N's rows after N+1.
    const v = foldActivity([
      head,
      promo("W1", "2026-08-20T10:00:00Z"),
      promo("W2", "2026-08-20T11:00:00Z"),
      promo("W1", "2026-08-20T12:00:00Z"),
    ]);
    expect(v.completed).toBe(2);
  });

  test("a deduped promotion still advances the REST of the fold", () => {
    // Guards `if (dup) continue;` at the top of the loop, which passes every
    // count-based assertion while freezing lastEventTs and eventCount. Not
    // academic: lastEventTs feeds ageMs/isStalled (watcher.ts) and
    // StalenessNotifier (push_discord.ts), so the failure mode is a false "idle"
    // Discord page about a card that is actively promoting.
    const events: FlightDeckEvent[] = [
      head,
      promo("W1", "2026-08-20T10:00:00Z"),
      promo("W1", "2026-08-20T10:05:00Z"),
      promo("W1", "2026-08-20T10:09:00Z"),
    ];
    const v = foldActivity(events);
    expect(v.completed).toBe(1);
    expect(v.lastEventTs).toBe("2026-08-20T10:09:00Z");
    expect(v.eventCount).toBe(events.length);
    expect(v.currentWave).toBe("W1");
  });

  test("a promoted with NO wave still counts — dedup requires identity", () => {
    // Unidentifiable events cannot be PROVEN duplicates. Collapsing them would
    // trade over-counting for under-counting: 1/3 when three waves landed is no
    // better than 10/3, and is harder to notice.
    const v = foldActivity([
      head,
      promo(null, "2026-08-20T10:00:00Z"),
      promo(null, "2026-08-20T11:00:00Z"),
    ]);
    expect(v.completed).toBe(2);
  });

  test("legs are NOT deduped — they legitimately repeat", () => {
    // A float leg identifies itself by detail.leg, not by wave/phase. Keying legs
    // on (wave, phase) would collapse them all, turning an inflation bug into a
    // suppression bug.
    const leg = (n: number, ts: string): FlightDeckEvent =>
      ({
        kind: "step", activityId: "dedup-1", ts, label: "leg",
        wave: "W1", detail: { leg: n },
      }) as FlightDeckEvent;
    const v = foldActivity([
      head, leg(1, "2026-08-20T10:00:00Z"),
      leg(2, "2026-08-20T11:00:00Z"), leg(3, "2026-08-20T12:00:00Z"),
    ]);
    expect(v.legs).toBe(3);
  });

  test("dedup is per-activity, not global", () => {
    // Two campaigns each promoting "W1" must both count it. `fold()` groups by
    // activityId and calls foldActivity per group, so the Set is per-view — this
    // pins that a future refactor cannot hoist it into module scope.
    const other: FlightDeckEvent = { ...head, activityId: "dedup-2" };
    const views = fold([
      head, promo("W1", "2026-08-20T10:00:00Z"),
      other,
      { ...promo("W1", "2026-08-20T10:05:00Z"), activityId: "dedup-2" } as FlightDeckEvent,
    ]);
    expect(views.get("dedup-1")?.completed).toBe(1);
    expect(views.get("dedup-2")?.completed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// cc-workflow#1154 — work-items done/total (campaign scope). `close_issue()`
// (cc-workflow state.py:1302) emits `{kind:"step", action:"close-issue",
// label:<issue ref>}` on every issue close; `campaign-head` ships
// `workItemsTotal` in `activity_start.detail`. Same dedup rationale and
// shape as the `promoted` collector above, keyed on the issue ref instead
// of the wave.

const closeIssue = (ref: string | null, ts: string, wave?: string): FlightDeckEvent =>
  ({
    kind: "step",
    activityId: "witems-1",
    ts,
    action: "close-issue",
    ...(ref === null ? {} : { label: ref }),
    ...(wave === undefined ? {} : { wave }),
  }) as FlightDeckEvent;

const witemsHead: FlightDeckEvent = {
  kind: "activity_start",
  activityId: "witems-1",
  ts: "2026-08-23T12:00:00Z",
  activityType: "campaign",
  label: "witems-campaign",
  detail: { planTotal: 3, workItemsTotal: 5 },
};

describe("work-items done/total (cc-workflow#1154)", () => {
  test("workItemsTotal parses from activity_start detail", () => {
    const v = foldActivity([witemsHead]);
    expect(v.workItemsTotal).toBe(5);
    expect(v.workItemsDone).toBe(0);
  });

  test("distinct issue refs each count", () => {
    const v = foldActivity([
      witemsHead,
      closeIssue("owner/repo#1", "2026-08-23T12:01:00Z"),
      closeIssue("owner/repo#2", "2026-08-23T12:02:00Z"),
      closeIssue("owner/repo#3", "2026-08-23T12:03:00Z"),
    ]);
    expect(v.workItemsDone).toBe(3);
  });

  test("a re-fired close-issue for the SAME ref counts once", () => {
    // `close_issue()` is idempotent-by-design (state.py just re-sets status to
    // "closed"), so a retried CLI call or a re-run hook can legitimately emit
    // the same close twice for one issue.
    const v = foldActivity([
      witemsHead,
      closeIssue("owner/repo#1", "2026-08-23T12:01:00Z"),
      closeIssue("owner/repo#1", "2026-08-23T12:01:05Z"),
    ]);
    expect(v.workItemsDone).toBe(1);
  });

  test("a close-issue with NO label still counts — dedup requires identity", () => {
    // Same rationale as the wave-less `promoted` case: an unidentifiable
    // close cannot be PROVEN a duplicate, so collapsing it would trade
    // over-counting for under-counting.
    const v = foldActivity([
      witemsHead,
      closeIssue(null, "2026-08-23T12:01:00Z"),
      closeIssue(null, "2026-08-23T12:02:00Z"),
    ]);
    expect(v.workItemsDone).toBe(2);
  });

  test("a step with a different action does not count as a close", () => {
    const v = foldActivity([
      witemsHead,
      { kind: "step", activityId: "witems-1", ts: "2026-08-23T12:01:00Z", action: "record-mr", label: "owner/repo#1" } as FlightDeckEvent,
    ]);
    expect(v.workItemsDone).toBe(0);
  });

  test("dedup is per-activity, not global", () => {
    const other: FlightDeckEvent = { ...witemsHead, activityId: "witems-2" };
    const views = fold([
      witemsHead, closeIssue("owner/repo#1", "2026-08-23T12:01:00Z"),
      other,
      { ...closeIssue("owner/repo#1", "2026-08-23T12:02:00Z"), activityId: "witems-2" } as FlightDeckEvent,
    ]);
    expect(views.get("witems-1")?.workItemsDone).toBe(1);
    expect(views.get("witems-2")?.workItemsDone).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// cc-workflow#1157 — work-items done/total at WAVE scope. The denominator
// (`waveWorkItems`) ships once, at campaign-head time, as a static
// per-wave map from the plan. The numerator is derived in a POST-loop pass
// over `close-issue` steps filtered by the FINAL `currentWave` — the key
// property under test is that a close under an EARLIER wave must not leak
// into a LATER wave's count once the campaign has moved on.

const waveHead: FlightDeckEvent = {
  kind: "activity_start",
  activityId: "wwitems-1",
  ts: "2026-08-24T09:00:00Z",
  activityType: "campaign",
  label: "wave-witems-campaign",
  detail: { planTotal: 2, workItemsTotal: 5, waveWorkItems: { "wave-1": 3, "wave-2": 2 } },
};

// `closeIssue` (defined above, #1154's tests) hardcodes `activityId:
// "witems-1"` — harmless for a direct `foldActivity()` call (it doesn't
// filter by the field), but wrong for `fold()`'s per-activity grouping,
// which DOES respect it. A dedicated helper avoids silently mis-grouping
// events in the multi-activity test below.
const waveCloseIssue = (ref: string | null, ts: string, wave: string): FlightDeckEvent =>
  ({
    kind: "step",
    activityId: "wwitems-1",
    ts,
    action: "close-issue",
    wave,
    ...(ref === null ? {} : { label: ref }),
  }) as FlightDeckEvent;

// A POSITION-bearing event — establishes currentWave the way a real
// campaign does (activity_start, phase, a non-close-issue step). Since
// review round 3, close-issue's `wave` tag is excluded from the
// currentWave latch (fold.ts) — it's the closed issue's own plan wave, a
// static attribute, not a position update. Tests below that need a
// specific currentWave must set it via this, not via waveCloseIssue.
const wavePosition = (wave: string, ts: string): FlightDeckEvent =>
  ({ kind: "phase", activityId: "wwitems-1", ts, wave, action: "planning" }) as FlightDeckEvent;

describe("wave-scope work-items done/total (cc-workflow#1157)", () => {
  test("waveWorkItemsTotal resolves the CURRENT wave's entry from the map", () => {
    const v = foldActivity([
      waveHead,
      wavePosition("wave-1", "2026-08-24T09:00:30Z"),
      waveCloseIssue("owner/repo#1", "2026-08-24T09:01:00Z", "wave-1"),
    ]);
    expect(v.currentWave).toBe("wave-1");
    expect(v.waveWorkItemsTotal).toBe(3); // wave-1's entry, not wave-2's or the campaign total
    expect(v.waveWorkItemsDone).toBe(1);
  });

  test("a close under an EARLIER wave does not count once the campaign has moved on", () => {
    // The exact case that makes this scope non-trivial: wave-1 sees a close,
    // then the campaign promotes to wave-2. wave-2's numerator must start
    // fresh at 0, not inherit wave-1's close.
    const v = foldActivity([
      waveHead,
      waveCloseIssue("owner/repo#1", "2026-08-24T09:01:00Z", "wave-1"),
      waveCloseIssue("owner/repo#2", "2026-08-24T09:02:00Z", "wave-1"),
      // wave transition — any event carrying wave:"wave-2" advances currentWave.
      { kind: "step", activityId: "wwitems-1", ts: "2026-08-24T09:03:00Z", label: "promoted", wave: "wave-1" } as FlightDeckEvent,
      { kind: "phase", activityId: "wwitems-1", ts: "2026-08-24T09:04:00Z", wave: "wave-2", action: "planning" } as FlightDeckEvent,
    ]);
    expect(v.currentWave).toBe("wave-2");
    expect(v.waveWorkItemsTotal).toBe(2); // wave-2's entry
    expect(v.waveWorkItemsDone).toBe(0); // NOT 2 — those closes were under wave-1
  });

  test("a straggler close for an EARLIER wave does NOT move currentWave backward (review round 3)", () => {
    // The core round-3 fix, isolated: close-issue's `wave` tag is the
    // closed issue's OWN plan wave (a static attribute post cc-workflow
    // #1157's emit-side fix), not a position update — so it must NOT
    // participate in the currentWave last-write-wins latch the way
    // activity_start/phase/promoted steps do. Position is set to wave-2;
    // a wave-1 straggler is then closed (a real, ROUTINE shape — an
    // operator closing a deferred issue after the campaign has advanced,
    // not merely a rare re-fire/replay). currentWave must stay wave-2.
    //
    // This is deliberately the ONLY test in this file that would pass
    // 102/102 unchanged if the latch exclusion were reverted while every
    // other wave-scope test here keeps its position event and close-issue
    // event pointed at the SAME wave — this is the one that isolates the
    // property those coincidentally can't.
    const v = foldActivity([
      waveHead,
      wavePosition("wave-2", "2026-08-24T09:00:30Z"),
      waveCloseIssue("owner/repo#1", "2026-08-24T09:01:00Z", "wave-1"), // straggler
    ]);
    expect(v.currentWave).toBe("wave-2"); // NOT "wave-1" — the close must not move position
    expect(v.waveWorkItemsTotal).toBe(2); // wave-2's denominator
    expect(v.waveWorkItemsDone).toBe(0); // the straggler was wave-1's, doesn't count toward wave-2
  });

  test("closes under the current wave count once the campaign has moved past a prior wave", () => {
    const v = foldActivity([
      waveHead,
      waveCloseIssue("owner/repo#1", "2026-08-24T09:01:00Z", "wave-1"),
      { kind: "phase", activityId: "wwitems-1", ts: "2026-08-24T09:02:00Z", wave: "wave-2", action: "planning" } as FlightDeckEvent,
      waveCloseIssue("owner/repo#2", "2026-08-24T09:03:00Z", "wave-2"),
    ]);
    expect(v.currentWave).toBe("wave-2");
    expect(v.waveWorkItemsTotal).toBe(2);
    expect(v.waveWorkItemsDone).toBe(1); // only owner/repo#2, the wave-2 close
  });

  test("a LATE-ARRIVING position event for an earlier wave moves currentWave backward — known, pinned behavior (code review)", () => {
    // currentWave is last-write-wins over POSITION-bearing events
    // (activity_start/phase/non-close-issue steps — close-issue's own
    // `wave` no longer contributes at all, review round 3), same as every
    // other scope tag in this reducer for the events that DO set it — not
    // special-cased for this feature, and NOT something #1157 can fix
    // without changing that reducer-wide convention. Code review flagged
    // this as consequential specifically for a done/total FRACTION
    // (silently attributing it to a stale wave) in a way it wasn't for a
    // coarse currentWave label — the mitigation is card.ts naming the wave
    // IN the cell label ("work items (wave-1)", not a bare "work items
    // (wave)"), so a stale attribution is visible/auditable rather than
    // silently wrong.
    //
    // Pins BOTH directions in one fixture, not just that currentWave can
    // move backward (review M3 — a single close only proves a mutant that
    // always returns 0 would also pass): a wave-2 close that must NOT
    // count once we're back at wave-1, AND a wave-1 close that MUST count
    // — proving the numerator actually reconstructs the earlier wave's
    // real fraction rather than just reading as "empty" after the move.
    const v = foldActivity([
      waveHead,
      wavePosition("wave-2", "2026-08-24T09:00:30Z"),
      waveCloseIssue("owner/repo#1", "2026-08-24T09:01:00Z", "wave-2"),
      // A late/reordered POSITION event re-asserts wave-1 as current — e.g.
      // a resumed replay of wave-1's own rows arriving after wave-2's.
      { kind: "step", activityId: "wwitems-1", ts: "2026-08-24T09:02:00Z", label: "promoted", wave: "wave-1" } as FlightDeckEvent,
      waveCloseIssue("owner/repo#2", "2026-08-24T09:03:00Z", "wave-1"),
    ]);
    expect(v.currentWave).toBe("wave-1"); // moved BACKWARD — last-write-wins, as designed
    expect(v.waveWorkItemsTotal).toBe(3); // wave-1's denominator, not wave-2's
    expect(v.waveWorkItemsDone).toBe(1); // owner/repo#2 (wave-1) counts; owner/repo#1 (wave-2) does not
  });

  test("a re-fired close for the SAME ref, same wave, counts once", () => {
    const v = foldActivity([
      waveHead,
      wavePosition("wave-1", "2026-08-24T09:00:30Z"),
      waveCloseIssue("owner/repo#1", "2026-08-24T09:01:00Z", "wave-1"),
      waveCloseIssue("owner/repo#1", "2026-08-24T09:01:05Z", "wave-1"),
    ]);
    expect(v.waveWorkItemsDone).toBe(1);
  });

  test("a close with no label still counts — dedup requires identity", () => {
    const v = foldActivity([
      waveHead,
      wavePosition("wave-1", "2026-08-24T09:00:30Z"),
      waveCloseIssue(null, "2026-08-24T09:01:00Z", "wave-1"),
      waveCloseIssue(null, "2026-08-24T09:02:00Z", "wave-1"),
    ]);
    expect(v.waveWorkItemsDone).toBe(2);
  });

  test("no currentWave ⇒ waveWorkItemsTotal null, waveWorkItemsDone 0 — not a guessed value", () => {
    const v = foldActivity([waveHead]); // no wave-carrying event at all
    expect(v.currentWave).toBeNull();
    expect(v.waveWorkItemsTotal).toBeNull();
    expect(v.waveWorkItemsDone).toBe(0);
  });

  test("current wave absent from the map ⇒ waveWorkItemsTotal null (a real hole, not 0)", () => {
    const v = foldActivity([
      waveHead,
      wavePosition("wave-9", "2026-08-24T09:00:30Z"), // not in the map
      waveCloseIssue("owner/repo#1", "2026-08-24T09:01:00Z", "wave-9"),
    ]);
    expect(v.currentWave).toBe("wave-9");
    expect(v.waveWorkItemsTotal).toBeNull();
  });

  test("dedup is per-activity, not global", () => {
    const other: FlightDeckEvent = { ...waveHead, activityId: "wwitems-2" };
    const views = fold([
      waveHead, wavePosition("wave-1", "2026-08-24T09:00:30Z"),
      waveCloseIssue("owner/repo#1", "2026-08-24T09:01:00Z", "wave-1"),
      other, { ...wavePosition("wave-1", "2026-08-24T09:00:30Z"), activityId: "wwitems-2" } as FlightDeckEvent,
      { ...waveCloseIssue("owner/repo#1", "2026-08-24T09:02:00Z", "wave-1"), activityId: "wwitems-2" } as FlightDeckEvent,
    ]);
    expect(views.get("wwitems-1")?.waveWorkItemsDone).toBe(1);
    expect(views.get("wwitems-2")?.waveWorkItemsDone).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// #34 — `detail` arrives as a JSON STRING from the kit's emitter.
//
// `wave-status emit --detail '{"planTotal": 3}'` passes the argparse value
// through with no json.loads, so the shipped event carries
//   "detail":"{\"planTotal\": 3}"
// The string below is that payload VERBATIM, captured from the installed CLI —
// not a hand-written approximation of it, because the whole defect is a
// disagreement about shape and an approximation would assume the answer.
// ---------------------------------------------------------------------------

const CLI_DETAIL = '{"planTotal": 3}';

function startWith(detail: unknown, activityType: "campaign" | "float" = "campaign"): FlightDeckEvent[] {
  return [
    {
      kind: "activity_start",
      activityId: "d",
      ts: "2026-07-07T10:00:00Z",
      activityType,
      detail,
    } as FlightDeckEvent,
  ];
}

describe("foldActivity — detail delivered as a JSON string (#34)", () => {
  test("the object form still works, unchanged", () => {
    expect(foldActivity(startWith({ planTotal: 3 })).planTotal).toBe(3);
  });

  test("the CLI's string form yields the same planTotal as the object form", () => {
    expect(foldActivity(startWith(CLI_DETAIL)).planTotal).toBe(3);
  });

  test("string and object forms fold identically", () => {
    expect(foldActivity(startWith(CLI_DETAIL)).planTotal).toBe(
      foldActivity(startWith({ planTotal: 3 })).planTotal,
    );
  });

  test("cord survives the string form too", () => {
    expect(foldActivity(startWith('{"cord": 7}', "float")).cord).toBe(7);
  });

  test("the synthetic marker survives the string form — the #7 filter was inert", () => {
    expect(foldActivity(startWith('{"synthetic": true}')).synthetic).toBe(true);
  });

  test("invalid JSON yields no denominator and does not throw", () => {
    expect(foldActivity(startWith('{"planTotal": ')).planTotal).toBeNull();
  });

  test("free-form prose is permitted by the emitter's schema and must be inert", () => {
    // schema.json: "Free-form detail payload (string or structured)."
    expect(foldActivity(startWith("promoted wave 2 by hand")).planTotal).toBeNull();
  });

  test.each(["3", '"x"', "[1,2]", "null", "true"])(
    "valid JSON encoding a non-object (%s) yields no denominator",
    (raw) => {
      expect(foldActivity(startWith(raw)).planTotal).toBeNull();
    },
  );

  // The synthetic negatives matter more than the positive. A wrong `true` does not
  // render badly — it DELETES the activity: page.ts filters `!v.synthetic` off the
  // board and push_discord.ts skips it for alerts, so the card and its pages vanish
  // with no artifact left to compare against. The implementation is strict
  // (`=== true`); these pin it against a future loosening to a truthy check.
  test("a string detail without the marker leaves synthetic false", () => {
    expect(foldActivity(startWith(CLI_DETAIL)).synthetic).toBe(false);
    expect(foldActivity(startWith("promoted wave 2 by hand")).synthetic).toBe(false);
  });

  test.each(['{"synthetic": "true"}', '{"synthetic": 1}', '{"synthetic": "yes"}', '{"synthetic": null}'])(
    "only a strict boolean true marks synthetic, not %s",
    (raw) => {
      expect(foldActivity(startWith(raw)).synthetic).toBe(false);
    },
  );

  test("the marker works on ANY event kind, not just activity_start (#7's contract)", () => {
    const v = foldActivity([
      { kind: "activity_start", activityId: "d", ts: "2026-07-07T10:00:00Z", activityType: "campaign" },
      { kind: "step", activityId: "d", ts: "2026-07-07T10:01:00Z", label: "x", detail: '{"synthetic": true}' },
    ] as FlightDeckEvent[]);
    expect(v.synthetic).toBe(true);
  });

  test("a detail string over the size cap is inert rather than parsed", () => {
    const huge = '{"planTotal": 3, "pad": "' + "x".repeat(70_000) + '"}';
    expect(foldActivity(startWith(huge)).planTotal).toBeNull();
  });

  test("a DOUBLE-encoded payload is rejected, not unwrapped", () => {
    // Only one layer is parsed on purpose: unwrapping further would absorb a
    // producer bug this shim exists to surface.
    expect(foldActivity(startWith(JSON.stringify(CLI_DETAIL))).planTotal).toBeNull();
  });
});
