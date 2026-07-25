// S3.4 / #871 — split-ETA strip: machine-time and blocked-on-you as two
// structurally independent figures, never merged (R-17).

import { describe, expect, test } from "bun:test";

import type { EtaResult } from "../src/eta.ts";
import { renderEtaStrip } from "../src/ui/eta_strip.ts";

const campaignEta: EtaResult = {
  kind: "campaign",
  machineTimeRemainingMs: 5 * 60_000, // 5m
  blockedOnYouMs: 2 * 60_000, // 2m
  completed: 3,
  planTotal: 7,
  remaining: 4,
};

describe("headline variant — two independent figures", () => {
  const html = renderEtaStrip(campaignEta);

  test("renders exactly two separate figures (never merged)", () => {
    expect((html.match(/fd-eta-figure/g) ?? []).length).toBe(2);
    expect(html).toContain('class="fd-eta-figure machine"');
    expect(html).toContain('class="fd-eta-figure blocked"');
  });

  test("machine-time and blocked-on-you carry their own distinct values", () => {
    expect(html).toContain("fd-eta-machine");
    expect(html).toContain("fd-eta-blocked");
    expect(html).toContain("5m"); // machine
    expect(html).toContain("2m"); // blocked
  });

  test("the blocked figure carries data-blocked-ms for the live client tick", () => {
    expect(html).toContain('data-blocked-ms="120000"');
  });
});

describe("honest unknowns and no merging", () => {
  test("null machine-time renders an em dash, blocked stays numeric", () => {
    const eta: EtaResult = { ...campaignEta, machineTimeRemainingMs: null };
    const html = renderEtaStrip(eta);
    expect(html).toContain("—"); // machine unknown
    expect(html).toContain("2m"); // blocked still shown
    expect((html.match(/fd-eta-figure/g) ?? []).length).toBe(2); // still two figures
  });

  test("null machine-time carries an explicit reason on the title, not a mystery dash (AC6, cc#1026)", () => {
    const eta: EtaResult = { ...campaignEta, machineTimeRemainingMs: null };
    expect(renderEtaStrip(eta)).toContain("not yet estimable"); // the N/A reason
    expect(renderEtaStrip(eta, { variant: "inline" })).toContain("not yet estimable");
  });

  test("a present machine-time uses the plain title, no reason (AC6, cc#1026)", () => {
    const html = renderEtaStrip(campaignEta, { variant: "inline" });
    expect(html).toContain('title="machine-time remaining"');
    expect(html).not.toContain("not yet estimable");
  });
});

describe("inline variant (card vitals)", () => {
  test("emits the compact two-figure markers + data-blocked-ms", () => {
    const html = renderEtaStrip(campaignEta, { variant: "inline" });
    expect(html).toContain("fd-eta-machine");
    expect(html).toContain("fd-eta-blocked");
    expect(html).toContain('data-blocked-ms="120000"');
  });
});

describe("float ETA renders from the same strip", () => {
  test("float uses the same anatomy (kind attribute reflects float)", () => {
    const floatEta: EtaResult = {
      kind: "float",
      machineTimeRemainingMs: 90_000,
      blockedOnYouMs: 0,
      cord: 12,
      legs: 4,
      legsRemainingBand: { low: 0, high: 2 },
      indicator: "converging",
    };
    const html = renderEtaStrip(floatEta);
    expect(html).toContain('data-eta-kind="float"');
    expect((html.match(/fd-eta-figure/g) ?? []).length).toBe(2);
  });
});
