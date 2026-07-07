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
  private events: FlightDeckEvent[] = [];

  constructor(opts: StoreOptions) {
    this.log = opts.log;
    // Open defensively: a lost/empty OR SQLite-corrupt view file is discarded and
    // recreated here, so the rebuild below always folds into a sound, empty db.
    this.db = openViewDb(opts.dbPath ?? ":memory:");
    this.db.run(CREATE_TABLE);
    this.upsertStmt = this.db.query(UPSERT);
    // Hydrate the in-memory event list from the log (source of truth) and rebuild
    // the view from scratch — the view is never trusted across a restart.
    this.rebuild();
  }

  /** Persist an event (log first), then update just its activity's view row. */
  append(event: FlightDeckEvent): void {
    this.log.append(event); // source of truth first
    this.events.push(event);
    this.upsertActivity(event.activityId);
  }

  /**
   * Drop the materialized view and re-fold the WHOLE log from scratch. Re-reads
   * the log (source of truth), so this proves the view is a pure projection.
   */
  rebuild(): void {
    this.events = this.log.readAll();
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

  /** The raw event log (source of truth), in order — for metrics/ETA derivation. */
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
