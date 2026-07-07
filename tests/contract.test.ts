// Contract guard (IT-08, in-repo form). The TS mirror in contract.ts must not drift
// from the vendored schema.json, and the vendored schema is the cc contract copied
// verbatim (a cc-side drift check belongs in CI with a cc checkout — seam noted in
// the PR; here we pin the mirror ⇄ vendored-schema, which is the part this repo owns).

import { describe, expect, test } from "bun:test";

import {
  CONCERN_KINDS,
  CONCERN_SOURCES,
  EVENT_KINDS,
  SCHEMA,
  SCHEMA_VERSION,
  validateEvent,
  isValidEvent,
} from "../src/events/contract.ts";

describe("contract mirror ⇄ vendored schema.json", () => {
  test("event kinds match the schema enum", () => {
    expect(([...EVENT_KINDS] as string[]).sort()).toEqual(
      [...SCHEMA.$defs.eventKind.enum].sort(),
    );
  });

  test("concern kinds match the schema enum", () => {
    expect(([...CONCERN_KINDS] as string[]).sort()).toEqual(
      [...SCHEMA.$defs.concernKind.enum].sort(),
    );
  });

  test("concern sources match the schema enum", () => {
    expect(([...CONCERN_SOURCES] as string[]).sort()).toEqual(
      [...SCHEMA.$defs.concernSource.enum].sort(),
    );
  });

  test("schemaVersion matches", () => {
    expect(SCHEMA_VERSION as number).toBe(SCHEMA.schemaVersion);
  });
});

describe("validateEvent mirrors the Python validator", () => {
  test("every event kind validates a minimal sample", () => {
    for (const kind of EVENT_KINDS) {
      const base: Record<string, unknown> = {
        kind,
        activityId: "a1",
        ts: "2026-07-07T00:00:00Z",
      };
      if (kind === "concern") {
        base["concernKind"] = "workaround";
        base["source"] = "declared";
      }
      if (kind === "metric") base["metric"] = "latency";
      expect(isValidEvent(base)).toBe(true);
    }
  });

  test("rejects non-object", () => {
    expect(() => validateEvent(42)).toThrow();
    expect(() => validateEvent(null)).toThrow();
    expect(() => validateEvent([])).toThrow();
  });

  test("rejects bad scope-tag type", () => {
    expect(
      isValidEvent({ kind: "step", activityId: "a", ts: "t", phase: 5 }),
    ).toBe(false);
  });

  test("metric value may be null (seamed-absent #853 token stub)", () => {
    expect(
      isValidEvent({
        kind: "metric",
        activityId: "a",
        ts: "t",
        metric: "tokens",
        value: null,
      }),
    ).toBe(true);
  });

  test("flight scope tag accepts string or integer", () => {
    expect(isValidEvent({ kind: "step", activityId: "a", ts: "t", flight: 3 })).toBe(true);
    expect(isValidEvent({ kind: "step", activityId: "a", ts: "t", flight: "3" })).toBe(true);
  });
});

// I2 — the validator must reject every shape schema.json rejects, so validator ⇄
// schema drift is pinned structurally, not just via the enum arrays above.
describe("validateEvent enforces the schema's structural/type constraints (I2)", () => {
  const base = { activityId: "a", ts: "t" } as const;

  test("schemaVersion must be an integer >= 1 when present", () => {
    expect(isValidEvent({ kind: "step", ...base, schemaVersion: 1 })).toBe(true);
    expect(isValidEvent({ kind: "step", ...base, schemaVersion: "x" })).toBe(false);
    expect(isValidEvent({ kind: "step", ...base, schemaVersion: 0 })).toBe(false);
    expect(isValidEvent({ kind: "step", ...base, schemaVersion: 1.5 })).toBe(false);
    expect(isValidEvent({ kind: "step", ...base, schemaVersion: null })).toBe(false);
  });

  test("flight must be a string or integer, never a float", () => {
    expect(isValidEvent({ kind: "step", ...base, flight: 3.5 })).toBe(false);
    expect(isValidEvent({ kind: "step", ...base, flight: true })).toBe(false);
  });

  test("action / label / unit must be strings when present", () => {
    expect(isValidEvent({ kind: "step", ...base, action: 5 })).toBe(false);
    expect(isValidEvent({ kind: "step", ...base, label: 7 })).toBe(false);
    expect(isValidEvent({ kind: "metric", ...base, metric: "m", unit: 9 })).toBe(false);
    // null/absent stay valid (schema types them ["string","null"]).
    expect(isValidEvent({ kind: "step", ...base, action: null, label: null })).toBe(true);
  });

  test("concernKind is enum-constrained whenever present, even on a non-concern event", () => {
    expect(isValidEvent({ kind: "step", ...base, concernKind: "bogus" })).toBe(false);
    expect(isValidEvent({ kind: "step", ...base, concernKind: "workaround" })).toBe(true);
    expect(isValidEvent({ kind: "step", ...base, concernKind: null })).toBe(false);
  });

  test("source is enum-constrained whenever present, even on a non-concern event", () => {
    expect(isValidEvent({ kind: "step", ...base, source: "bogus" })).toBe(false);
    expect(isValidEvent({ kind: "step", ...base, source: "coded" })).toBe(true);
  });

  test("a concern event requires both concernKind and source (schema allOf)", () => {
    expect(isValidEvent({ kind: "concern", ...base })).toBe(false);
    expect(isValidEvent({ kind: "concern", ...base, concernKind: "workaround" })).toBe(false);
    expect(isValidEvent({ kind: "concern", ...base, source: "coded" })).toBe(false);
    expect(
      isValidEvent({ kind: "concern", ...base, concernKind: "workaround", source: "coded" }),
    ).toBe(true);
  });

  test("a metric event requires a non-empty metric name (schema allOf)", () => {
    expect(isValidEvent({ kind: "metric", ...base })).toBe(false);
    expect(isValidEvent({ kind: "metric", ...base, metric: "" })).toBe(false);
    expect(isValidEvent({ kind: "metric", ...base, metric: "latency" })).toBe(true);
  });
});
