// Event-sourced store (Dev Spec §5.3 / TC-8 / S2.2 / #866).
//
//   append-only JSONL log  ── source of truth (log.ts / TC-3)
//          │  the ONE fold (fold.ts)
//          ▼
//   bun:sqlite `activity_view`  ── materialized view (rebuildable)
//
// The view is a pure, rebuildable projection of the log. `append()` (live) and
// `rebuild()` (drop + re-fold the whole log) BOTH derive state through the single
// `foldActivity`, so `rebuild()` reproduces the live view exactly (R-09, IT-05).
// If the view is ever lost OR corrupted, it is thrown away and rebuilt from the
// log — the log never depends on the view. Boot proves this both ways: a lost/empty
// view is re-folded from scratch, and a SQLite-corrupt view file is detected at open
// (`openViewDb`), unlinked, and recreated before the whole log is re-folded into it.

import { Database, type Statement } from "bun:sqlite";
import { rmSync } from "node:fs";

import type { FlightDeckEvent } from "./events/contract.ts";
import { type ActivityView, fold, foldActivity } from "./fold.ts";
import { EventLog, type IngestSink } from "./log.ts";

export interface StoreOptions {
  log: EventLog;
  /** SQLite path for the materialized view. Defaults to in-memory (rebuilt on boot). */
  dbPath?: string;
  /**
   * ISO-8601 watermark (flightdeck#25). Events with `ts` strictly before this are
   * excluded from the materialized view — never from the log, which stays the
   * complete, untouched source of truth. Closes the "emit-side fixes are not
   * retroactive" gap: every FlightDeck UI fix to date has corrected events going
   * FORWARD, so a pre-fix event (wrong activityId, missing agent, wrong scope —
   * whatever the bug of the day was) sits in the log forever and re-folds into a
   * broken card on every boot, with no way to distinguish "old and wrong" from
   * "new and correct" from inside the view itself. A watermark is a bounded,
   * reversible answer: raise it past a known-bad period's events and they stop
   * rendering; the log is untouched, so lowering it (or removing the var) brings
   * them back exactly as they were. ISO-8601 UTC timestamps compare correctly as
   * plain strings, so no date parsing is needed here — validated at the caller
   * (server.ts) as UTC `Z`-suffixed with required seconds and OPTIONAL
   * fractional seconds (the real emitter never emits fractions —
   * "2026-01-01T00:00:00Z" — but a `.000Z`-style watermark, e.g. from
   * `Date.toISOString()`, compares safely against it either way); an offset
   * form is rejected, since a plain string compare is only correct when both
   * sides share the same UTC `Z` shape.
   * NOT safe to raise past a still-live activity's `activity_start` — see
   * deploy/README.md's caution before setting this on a running deploy.
   */
  foldSince?: string;
}

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS activity_view (
  activityId   TEXT PRIMARY KEY,
  activityType TEXT NOT NULL,
  status       TEXT NOT NULL,
  label        TEXT,
  startedAt    TEXT,
  endedAt      TEXT,
  lastEventTs  TEXT,
  eventCount   INTEGER NOT NULL,
  planTotal    INTEGER,
  completed    INTEGER NOT NULL,
  cord         INTEGER,
  legs         INTEGER NOT NULL,
  openConcerns INTEGER NOT NULL,
  view_json    TEXT NOT NULL
)`;

const UPSERT = `
INSERT INTO activity_view
  (activityId, activityType, status, label, startedAt, endedAt, lastEventTs,
   eventCount, planTotal, completed, cord, legs, openConcerns, view_json)
VALUES
  ($activityId, $activityType, $status, $label, $startedAt, $endedAt, $lastEventTs,
   $eventCount, $planTotal, $completed, $cord, $legs, $openConcerns, $view_json)
ON CONFLICT(activityId) DO UPDATE SET
  activityType = excluded.activityType,
  status       = excluded.status,
  label        = excluded.label,
  startedAt    = excluded.startedAt,
  endedAt      = excluded.endedAt,
  lastEventTs  = excluded.lastEventTs,
  eventCount   = excluded.eventCount,
  planTotal    = excluded.planTotal,
  completed    = excluded.completed,
  cord         = excluded.cord,
  legs         = excluded.legs,
  openConcerns = excluded.openConcerns,
  view_json    = excluded.view_json`;

/**
 * Open the materialized-view db at `dbPath`, tolerating a lost OR corrupt file.
 * The view is a pure, rebuildable projection of the log (never trusted across a
 * restart), so if an existing file can't be opened/read (corrupt/unreadable) we
 * discard it and hand back a fresh, empty db — the caller then re-folds the whole
 * log into it. `:memory:` has no file to salvage, so it is opened directly.
 *
 * `new Database()` is lazy: a corrupt or non-database file opens without error and
 * only fails when SQLite first reads a page. We force that read here (probe the
 * schema) so corruption surfaces at boot, where we can recover, instead of leaking
 * out later as a mid-flight crash.
 */
function openViewDb(dbPath: string): Database {
  if (dbPath === ":memory:") return new Database(dbPath);
  let db: Database | null = null;
  try {
    db = new Database(dbPath);
    db.query("SELECT count(*) FROM sqlite_master").get(); // force a page read
    return db;
  } catch {
    // Corrupt/unreadable view → throw the bad file away and recreate it empty.
    if (db) {
      try {
        db.close();
      } catch {
        /* the handle is already broken; nothing to salvage */
      }
    }
    rmSync(dbPath, { force: true });
    return new Database(dbPath);
  }
}

export class Store implements IngestSink {
  readonly log: EventLog;
  private readonly db: Database;
  private readonly upsertStmt: Statement;
  private readonly foldSince: string | null;
  private events: FlightDeckEvent[] = [];

  constructor(opts: StoreOptions) {
    this.log = opts.log;
    this.foldSince = opts.foldSince ?? null;
    // Open defensively: a lost/empty OR SQLite-corrupt view file is discarded and
    // recreated here, so the rebuild below always folds into a sound, empty db.
    this.db = openViewDb(opts.dbPath ?? ":memory:");
    this.db.run(CREATE_TABLE);
    this.upsertStmt = this.db.query(UPSERT);
    // Hydrate the in-memory event list from the log (source of truth) and rebuild
    // the view from scratch — the view is never trusted across a restart.
    this.rebuild();
  }

  /** True when a fold-since watermark would exclude *event* from the view. */
  private beforeWatermark(event: FlightDeckEvent): boolean {
    return this.foldSince !== null && event.ts < this.foldSince;
  }

  /**
   * Persist an event (log first — ALWAYS, watermark or not, since the log is the
   * complete source of truth per flightdeck#25), then fold it into the view only
   * if it's not older than the watermark. A live append is always "now", so this
   * branch is defense-in-depth (backdated/replayed events, clock skew) rather
   * than the primary use case — the watermark's real job is bounding `rebuild()`.
   */
  append(event: FlightDeckEvent): void {
    this.log.append(event); // source of truth first, unconditionally
    if (this.beforeWatermark(event)) return;
    this.events.push(event);
    this.upsertActivity(event.activityId);
  }

  /**
   * Drop the materialized view and re-fold the log from scratch, EXCLUDING
   * anything before the fold-since watermark (flightdeck#25) — the log itself is
   * still read in full (`readAll()`); only the in-memory/materialized PROJECTION
   * is bounded. Re-reads the log (source of truth) either way, so this proves the
   * view is a pure projection.
   */
  rebuild(): void {
    const all = this.log.readAll();
    this.events = this.foldSince === null ? all : all.filter((e) => !this.beforeWatermark(e));
    this.db.run("DELETE FROM activity_view");
    this.rebuildFromEvents();
  }

  /** All activity views, ordered by activityId (deterministic). */
  getView(): ActivityView[] {
    const rows = this.db
      .query("SELECT view_json FROM activity_view ORDER BY activityId")
      .all() as Array<{ view_json: string }>;
    return rows.map((r) => JSON.parse(r.view_json) as ActivityView);
  }

  /** One activity view, or null. */
  getActivity(activityId: string): ActivityView | null {
    const row = this.db
      .query("SELECT view_json FROM activity_view WHERE activityId = $id")
      .get({ $id: activityId }) as { view_json: string } | null;
    return row ? (JSON.parse(row.view_json) as ActivityView) : null;
  }

  /**
   * The in-memory event set backing the view, in order — for metrics/ETA
   * derivation and the /log transcript viewer. NOT the raw log: under a
   * fold-since watermark (flightdeck#25) this is the same bounded projection
   * `getView()` folds from, not the complete on-disk history. The untouched
   * complete log is `this.log.readAll()`.
   */
  allEvents(): FlightDeckEvent[] {
    return this.events.slice();
  }

  close(): void {
    this.db.close();
  }

  // --- internals ---------------------------------------------------------

  private eventsFor(activityId: string): FlightDeckEvent[] {
    return this.events.filter((e) => e.activityId === activityId);
  }

  private upsertActivity(activityId: string): void {
    const group = this.eventsFor(activityId);
    if (group.length === 0) return;
    this.writeRow(foldActivity(group));
  }

  private rebuildFromEvents(): void {
    for (const view of fold(this.events).values()) {
      this.writeRow(view);
    }
  }

  private writeRow(v: ActivityView): void {
    this.upsertStmt.run({
      $activityId: v.activityId,
      $activityType: v.activityType,
      $status: v.status,
      $label: v.label,
      $startedAt: v.startedAt,
      $endedAt: v.endedAt,
      $lastEventTs: v.lastEventTs,
      $eventCount: v.eventCount,
      $planTotal: v.planTotal,
      $completed: v.completed,
      $cord: v.cord,
      $legs: v.legs,
      $openConcerns: v.openConcerns,
      $view_json: JSON.stringify(v),
    });
  }
}
