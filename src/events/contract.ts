// FlightDeck event contract — TypeScript mirror of the vendored schema (F-7 / TC-4).
//
// `schema.json` (sibling file) is the single, versioned, language-neutral contract.
// It is vendored verbatim from cc `src/wave_status/events/schema.json`; the Python
// emitter (`wave_status.events`) and THIS TS service both validate against it —
// schema, not shared code. This module mirrors the schema's `$defs` enums as typed
// constants plus a dependency-free validator that mirrors the Python `validate_event`
// (stdlib-only there; framework-free here). `contract.test.ts` pins these constants
// against `schema.json` so the two never drift.
//
// Design note (#853 token gate): a `metric` event's `value` may be `null` — a
// seamed-absent metric (the token cell stubs until #853 lands; R-19/TC-7: never
// fabricated, explicitly absent).

import schema from "./schema.json" with { type: "json" };

export const SCHEMA_VERSION = 1 as const;

/** The eight deterministic event kinds. */
export const EVENT_KINDS = [
  "activity_start",
  "phase",
  "step",
  "metric",
  "concern",
  "blocked_on_human",
  "ci_wait",
  "activity_end",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** The six concern categories (kind === "concern"). */
export const CONCERN_KINDS = [
  "workaround",
  "di-seam",
  "forced-default",
  "gate-override",
  "self-approval",
  "unresolved-todo",
] as const;
export type ConcernKind = (typeof CONCERN_KINDS)[number];

/** Where a concern originated: a coded escape hatch, or an agent declaration. */
export const CONCERN_SOURCES = ["coded", "declared"] as const;
export type ConcernSource = (typeof CONCERN_SOURCES)[number];

/** The canonical scope-tag key set carried by every event (Dev Spec §5.1). */
export const SCOPE_TAGS = [
  "activityId",
  "kind",
  "phase",
  "wave",
  "flight",
  "agent",
  "ts",
  "logRef",
] as const;

// state.py action vocabulary → event kind (mirrors ACTION_TO_KIND in the Python
// contract). Consumed only where the TS side needs to reason about action strings.
export const ACTION_TO_KIND: Record<string, EventKind> = {
  idle: "step",
  "pre-flight": "phase",
  planning: "phase",
  "post-wave-review": "phase",
  "in-flight": "step",
  merging: "step",
  "waiting-on-meatbag": "blocked_on_human",
  "waiting-ci": "ci_wait",
  launching: "step",
  "awaiting-verdict": "step",
  promoting: "step",
  hold: "blocked_on_human",
};

/** Map a state.py `current_action.action` to its event kind; unknown → "step". */
export function kindForAction(action: string): EventKind {
  return ACTION_TO_KIND[action] ?? "step";
}

/**
 * A FlightDeck event. `kind`, `activityId`, `ts` are required; everything else is
 * an optional scope tag or kind-specific field. `additionalProperties: true` in the
 * schema — emit-side conventions (e.g. `activityType`, `detail.planTotal`) ride here.
 */
export interface FlightDeckEvent {
  kind: EventKind;
  activityId: string;
  ts: string;
  schemaVersion?: number;
  // scope tags
  phase?: string | null;
  wave?: string | null;
  flight?: string | number | null;
  agent?: string | null;
  logRef?: string | null;
  // kind-specific
  action?: string | null;
  label?: string | null;
  detail?: unknown;
  metric?: string | null;
  value?: number | string | boolean | null;
  unit?: string | null;
  concernKind?: ConcernKind;
  source?: ConcernSource;
  // additive convention fields (activity_start): activityType, planTotal, cord
  activityType?: "campaign" | "float";
  [key: string]: unknown;
}

export class EventValidationError extends Error {
  override name = "EventValidationError";
}

// Properties the schema types as `["string", "null"]` — a string when present,
// else null/absent. `flight` (string|integer) and `schemaVersion` (integer) are
// numeric and handled separately below.
const STRING_OR_NULL_KEYS = [
  "phase",
  "wave",
  "agent",
  "logRef",
  "action",
  "label",
  "metric",
  "unit",
] as const;

const EVENT_KIND_SET: ReadonlySet<string> = new Set(EVENT_KINDS);
const CONCERN_KIND_SET: ReadonlySet<string> = new Set(CONCERN_KINDS);
const CONCERN_SOURCE_SET: ReadonlySet<string> = new Set(CONCERN_SOURCES);

/**
 * Validate `event` against the vendored contract (`schema.json`); throws
 * {@link EventValidationError} on any violation. This enforces exactly what the
 * schema does, so the validator rejects every shape the schema rejects:
 *   • required fields + types: `kind` ∈ enum, non-empty `activityId`/`ts`;
 *   • `schemaVersion` an integer ≥ 1 when present;
 *   • `flight` a string OR an integer (never a float) when present;
 *   • the `["string","null"]`-typed tags (phase/wave/agent/logRef/action/
 *     label/metric/unit) a string when present;
 *   • `concernKind`/`source` constrained to their enums WHENEVER present on ANY
 *     event (schema `$ref`), independent of `kind`;
 *   • kind-conditional requirements (schema `allOf`): concern ⇒ concernKind +
 *     source present; metric ⇒ non-empty metric name.
 * `contract.test.ts` pins these structural rules so validator ⇄ schema never drift.
 */
export function validateEvent(event: unknown): asserts event is FlightDeckEvent {
  if (typeof event !== "object" || event === null || Array.isArray(event)) {
    throw new EventValidationError(
      `event must be an object, got ${event === null ? "null" : Array.isArray(event) ? "array" : typeof event}`,
    );
  }
  const e = event as Record<string, unknown>;

  const kind = e["kind"];
  if (typeof kind !== "string" || !EVENT_KIND_SET.has(kind)) {
    throw new EventValidationError(
      `invalid event kind ${JSON.stringify(kind)}; must be one of ${EVENT_KINDS.join(", ")}`,
    );
  }

  const activityId = e["activityId"];
  if (typeof activityId !== "string" || activityId.length === 0) {
    throw new EventValidationError("event 'activityId' must be a non-empty string");
  }

  const ts = e["ts"];
  if (typeof ts !== "string" || ts.length === 0) {
    throw new EventValidationError("event 'ts' must be a non-empty string");
  }

  // schemaVersion: integer >= 1 when present (schema: {type:integer, minimum:1}).
  const schemaVersion = e["schemaVersion"];
  if (schemaVersion !== undefined) {
    if (
      typeof schemaVersion !== "number" ||
      !Number.isInteger(schemaVersion) ||
      schemaVersion < 1
    ) {
      throw new EventValidationError(
        `'schemaVersion' must be an integer >= 1, got ${JSON.stringify(schemaVersion)}`,
      );
    }
  }

  // ["string","null"]-typed properties: a string when present, else null/absent.
  for (const key of STRING_OR_NULL_KEYS) {
    const v = e[key];
    if (v !== undefined && v !== null && typeof v !== "string") {
      throw new EventValidationError(`'${key}' must be a string or null/absent`);
    }
  }

  // flight: a string OR an integer (never a float) when present
  // (schema: {type:["string","integer","null"]}).
  const flight = e["flight"];
  if (flight !== undefined && flight !== null) {
    const ok = typeof flight === "string" || (typeof flight === "number" && Number.isInteger(flight));
    if (!ok) {
      throw new EventValidationError(
        `scope tag 'flight' must be a string or integer, got ${JSON.stringify(flight)}`,
      );
    }
  }

  // concernKind / source: constrained to their enums WHENEVER present on ANY event
  // (schema $ref), independent of kind. (null is not a valid enum member.)
  const concernKind = e["concernKind"];
  if (concernKind !== undefined) {
    if (typeof concernKind !== "string" || !CONCERN_KIND_SET.has(concernKind)) {
      throw new EventValidationError(
        `'concernKind' must be one of ${CONCERN_KINDS.join(", ")}, got ${JSON.stringify(concernKind)}`,
      );
    }
  }
  const source = e["source"];
  if (source !== undefined) {
    if (typeof source !== "string" || !CONCERN_SOURCE_SET.has(source)) {
      throw new EventValidationError(
        `'source' must be one of ${CONCERN_SOURCES.join(", ")}, got ${JSON.stringify(source)}`,
      );
    }
  }

  // Kind-conditional requirements (schema allOf).
  if (kind === "concern") {
    if (typeof concernKind !== "string") {
      throw new EventValidationError(
        `concern event requires 'concernKind' (one of ${CONCERN_KINDS.join(", ")})`,
      );
    }
    if (typeof source !== "string") {
      throw new EventValidationError(
        `concern event requires 'source' (one of ${CONCERN_SOURCES.join(", ")})`,
      );
    }
  }

  if (kind === "metric") {
    const name = e["metric"];
    if (typeof name !== "string" || name.length === 0) {
      throw new EventValidationError(
        "metric event 'metric' (name) must be a non-empty string",
      );
    }
  }
}

/** Non-throwing form: `true` iff `event` satisfies the contract. */
export function isValidEvent(event: unknown): event is FlightDeckEvent {
  try {
    validateEvent(event);
    return true;
  } catch {
    return false;
  }
}

/** The parsed, vendored `schema.json` contract (used by the drift test). */
export const SCHEMA = schema as {
  schemaVersion: number;
  $defs: {
    eventKind: { enum: string[] };
    concernKind: { enum: string[] };
    concernSource: { enum: string[] };
  };
};

/** ISO-8601 UTC timestamp (mirrors Python `now_iso`). Not used inside `fold`. */
export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
