// formatDuration's day tier (cc-workflow#1146 step 2 code review, minor finding 6):
// the card/table "time since last event" readout is the first caller that can see
// spans past 24h (a stale-but-open activity, or a closed one's last event), so the
// formatter needed a unit past hours or it would render unreadable values like
// "168h" for a week. Direct unit coverage — every other caller (ETA, blocked-on-you,
// metric spans) tops out well under a day and stays exercised via the card/table
// tests instead.

import { describe, expect, test } from "bun:test";

import { formatDuration } from "../src/ui/format.ts";

describe("formatDuration", () => {
  test("null / non-finite renders the honest unknown, never a fabricated 0", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(Number.NaN)).toBe("—");
  });

  test("negative clamps to 0 (unchanged pre-existing behavior for its OTHER callers — ETA/metric spans, never legitimately negative)", () => {
    expect(formatDuration(-5_000)).toBe("0s");
  });

  test("sub-minute, sub-hour, sub-day: unchanged tiers", () => {
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(125_000)).toBe("2m 5s");
    expect(formatDuration(120_000)).toBe("2m");
    expect(formatDuration(3_700_000)).toBe("1h 1m");
    expect(formatDuration(3_600_000)).toBe("1h");
  });

  test("just under 24h stays in the hour tier", () => {
    expect(formatDuration(23 * 3_600_000 + 59 * 60_000)).toBe("23h 59m");
  });

  test("24h and beyond rolls into the new day tier", () => {
    expect(formatDuration(24 * 3_600_000)).toBe("1d");
    expect(formatDuration(25 * 3_600_000)).toBe("1d 1h");
    expect(formatDuration(7 * 24 * 3_600_000)).toBe("7d"); // was the unreadable "168h" before this fix
  });
});
