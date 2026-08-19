// Build identity — what build is this? (#24)
//
// The operator-facing answer to "is the deployed instance actually running the
// latest?". Before this module that question was unanswerable from outside the
// Swarm manager: `/health` returned `{ok:true}` and nothing else, so a stale
// deployment and a genuine defect looked identical from the console.
//
// Resolution order, most authoritative first:
//
//   1. FLIGHTDECK_VERSION / FLIGHTDECK_GIT_SHA — baked into the image at build
//      time (Dockerfile ARG -> ENV, fed by the release workflow from the git
//      tag + SHA). This is the ONLY source that describes the *image*; the
//      others describe whatever source tree happens to be on disk.
//   2. package.json `version` — the source tree's declared version. Correct for
//      `bun run src/server.ts` in a checkout; CI enforces that it matches the
//      git tag on a release build so it cannot silently drift again (it sat at
//      0.1.0 through eight releases).
//   3. "dev" / "unknown" — no build identity available. Rendered as-is rather
//      than hidden: an unlabelled build is itself a fact worth showing.

import pkg from "../package.json";

/** Value shown when no build identity is available (never an empty string —
 *  an empty version renders as a blank gap that reads like a UI bug). */
export const UNKNOWN_VERSION = "dev";
export const UNKNOWN_SHA = "unknown";

export interface BuildInfo {
  /** Semver of the image, or "dev" outside a released image. */
  version: string;
  /** Full git SHA the image was built from, or "unknown". */
  gitSha: string;
  /** Short (7-char) SHA — what the UI shows. */
  shortSha: string;
  /** Process start, ISO-8601. Distinguishes "restarted just now" from "up for days". */
  startedAt: string;
}

const startedAt = new Date().toISOString();

/** Resolve build identity. Pure over the environment so tests can drive it
 *  directly (see `resolveBuildInfo`); the module-level `BUILD_INFO` is the
 *  single instance the server and UI share. */
export function resolveBuildInfo(
  env: Record<string, string | undefined> = process.env,
  startedAtIso: string = startedAt,
): BuildInfo {
  // Trim and reject empty/whitespace values so a blank `FLIGHTDECK_VERSION=`
  // falls through to the next source instead of blanking the badge.
  const fromEnv = (name: string, fallback: string): string => {
    const raw = env[name];
    if (raw === undefined) return fallback;
    const trimmed = raw.trim();
    return trimmed === "" ? fallback : trimmed;
  };

  // package.json is the fallback for a source checkout. A version of "0.0.0" or
  // a missing field is treated as absent rather than shown as a real release.
  const pkgVersion = typeof pkg.version === "string" ? pkg.version.trim() : "";
  const versionFallback = pkgVersion === "" || pkgVersion === "0.0.0" ? UNKNOWN_VERSION : pkgVersion;

  const gitSha = fromEnv("FLIGHTDECK_GIT_SHA", UNKNOWN_SHA);
  return {
    version: fromEnv("FLIGHTDECK_VERSION", versionFallback),
    gitSha,
    shortSha: gitSha === UNKNOWN_SHA ? UNKNOWN_SHA : gitSha.slice(0, 7),
    startedAt: startedAtIso,
  };
}

/** The build identity for this process. */
export const BUILD_INFO: BuildInfo = resolveBuildInfo();
