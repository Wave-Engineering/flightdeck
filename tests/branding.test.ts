// #14 — Oak & Wave branding: logo + wordmark in the topbar of both pages,
// shipped as an inlined data URI (no route, no fs read, outside the SSE swap).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LOGO_DATA_URI, ORG_NAME } from "../src/ui/brand.ts";
import { EventLog } from "../src/log.ts";
import { Store } from "../src/store.ts";
import { renderBoard, renderLogPage, renderPage } from "../src/ui/page.ts";

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "flightdeck-brand-"));
  store = new Store({ log: new EventLog(join(dir, "e.jsonl")), dbPath: ":memory:" });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("brand constants (#14)", () => {
  test("ORG_NAME is the company name", () => {
    expect(ORG_NAME).toBe("Oak & Wave");
  });

  test("LOGO_DATA_URI decodes to a real PNG (magic bytes)", () => {
    expect(LOGO_DATA_URI.startsWith("data:image/png;base64,")).toBe(true);
    const bytes = Buffer.from(LOGO_DATA_URI.slice("data:image/png;base64,".length), "base64");
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(bytes.length).toBeGreaterThan(1000); // a real image, not a stub
  });
});

describe("topbar branding (#14)", () => {
  test("board page carries the logo (decorative alt) and the escaped wordmark", () => {
    const html = renderPage(store);
    expect(html).toContain('class="fd-logo"');
    expect(html).toContain("data:image/png;base64,");
    // alt="" — decorative by design: the adjacent wordmark names the company, so
    // screen readers announce it once (review finding, WCAG duplicate-text rule).
    expect(html).toContain('alt=""');
    expect(html).toContain(">Oak &amp; Wave</span>");
    expect(html).toContain("<h1>FlightDeck</h1>"); // product title intact
  });

  test("log page carries the same branding", () => {
    const html = renderLogPage(store, {});
    expect(html).toContain('class="fd-logo"');
    expect(html).toContain(">Oak &amp; Wave</span>");
    expect(html).toContain("← board"); // its page-specific tail intact
  });

  test("the SSE board fragment does NOT carry the logo bytes", () => {
    // The topbar sits outside #board — swaps must never resend ~11 KB of logo.
    const fragment = renderBoard(store);
    expect(fragment).not.toContain("data:image/png");
    expect(fragment).not.toContain("fd-logo");
  });
});
