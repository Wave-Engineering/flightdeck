// #24 — build identity: a running FlightDeck must be able to say what build it
// is, from the console alone. Before this, `/health` returned `{ok:true}` and
// package.json sat at 0.1.0 through eight releases, so a stale deployment and a
// genuine defect were indistinguishable without shell access to the Swarm manager.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventLog } from "../src/log.ts";
import { Store } from "../src/store.ts";
import type { ServerConfig } from "../src/server.ts";
import { renderLogPage, renderPage } from "../src/ui/page.ts";
import { BUILD_INFO, resolveBuildInfo, UNKNOWN_SHA, UNKNOWN_VERSION } from "../src/version.ts";
import { handleRequest } from "../src/server.ts";

let dir: string;
let store: Store;
let log: EventLog;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "flightdeck-version-"));
  log = new EventLog(join(dir, "e.jsonl"));
  store = new Store({ log, dbPath: ":memory:" });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveBuildInfo (#24)", () => {
  test("prefers the image-baked env over package.json", () => {
    const info = resolveBuildInfo({
      FLIGHTDECK_VERSION: "0.2.8",
      FLIGHTDECK_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
    });
    expect(info.version).toBe("0.2.8");
    expect(info.gitSha).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(info.shortSha).toBe("0123456");
  });

  test("falls back to package.json version when the env is absent", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"));
    const info = resolveBuildInfo({});
    expect(info.version).toBe(pkg.version);
    expect(info.gitSha).toBe(UNKNOWN_SHA);
    expect(info.shortSha).toBe(UNKNOWN_SHA);
  });

  test("treats blank/whitespace env values as absent, not as a blank version", () => {
    // A `-e FLIGHTDECK_VERSION=` in a run command must not blank the badge.
    const info = resolveBuildInfo({ FLIGHTDECK_VERSION: "   ", FLIGHTDECK_GIT_SHA: "" });
    expect(info.version).not.toBe("");
    expect(info.version.trim()).toBe(info.version);
    expect(info.gitSha).toBe(UNKNOWN_SHA);
  });

  test("never yields an empty version — an unlabelled build still renders", () => {
    const info = resolveBuildInfo({ FLIGHTDECK_VERSION: "" });
    expect(info.version.length).toBeGreaterThan(0);
    expect([UNKNOWN_VERSION, JSON.parse(
      readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"),
    ).version]).toContain(info.version);
  });

  test("startedAt is a valid ISO-8601 instant", () => {
    const info = resolveBuildInfo({}, "2026-08-19T12:00:00.000Z");
    expect(info.startedAt).toBe("2026-08-19T12:00:00.000Z");
    expect(Number.isNaN(Date.parse(BUILD_INFO.startedAt))).toBe(false);
  });
});

describe("package.json version is real (#24)", () => {
  test("is not the stale 0.1.0 placeholder that survived eight releases", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"));
    expect(pkg.version).not.toBe("0.1.0");
  });

  test("is full semver — prerelease and build suffixes allowed", () => {
    // Must accept what scripts/ci/check-version.sh accepts, or the two guards
    // become mutually unsatisfiable and no prerelease tag can ever ship: the
    // script requires package.json === the v-stripped tag (so v1.0.0-rc1 needs
    // "1.0.0-rc1"), and a \d+\.\d+\.\d+-only regex here would reject exactly
    // that. Both run in release.yml's `test` job, which gates `publish`.
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"));
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
  });
});

describe("GET /health reports build identity (#24)", () => {
  // A REAL ServerConfig, not a cast-to-never stand-in: /health returns before
  // reading any of these today, so a fabricated shape would pass now and crash
  // the day the handler grows a dependency on cfg.
  const cfg = (): ServerConfig => ({ port: 0, token: "t", sink: log });

  test("returns ok plus version, gitSha and startedAt", async () => {
    const res = await handleRequest(new Request("http://x/health"), cfg());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(body["version"]).toBe(BUILD_INFO.version);
    expect(body["gitSha"]).toBe(BUILD_INFO.gitSha);
    expect(body["startedAt"]).toBe(BUILD_INFO.startedAt);
  });

  test("still rejects non-GET (the liveness contract is unchanged)", async () => {
    const res = await handleRequest(new Request("http://x/health", { method: "POST" }), cfg());
    expect(res.status).toBe(405);
  });
});

describe("build badge in the topbar (#24)", () => {
  test("board page shows the version, outside the SSE-swapped board", () => {
    const html = renderPage(store);
    expect(html).toContain('class="fd-build"');
    expect(html).toContain(`v${BUILD_INFO.version}`);
    // Must live in the topbar, which sits before #board and survives frame swaps.
    expect(html.indexOf('class="fd-build"')).toBeLessThan(html.indexOf('id="board"'));
  });

  test("log page shows it too — the operator may report from either view", () => {
    const html = renderLogPage(store, {} as never);
    expect(html).toContain('class="fd-build"');
    expect(html).toContain(`v${BUILD_INFO.version}`);
  });

  test("the title attribute carries the full sha and process start for triage", () => {
    const html = renderPage(store);
    expect(html).toContain(BUILD_INFO.gitSha);
    expect(html).toContain(BUILD_INFO.startedAt);
  });
});
