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
// If the view is ever lost or corrupted, it is thrown away and rebuilt from the
// log — the log never depends on the view.

import { Database, type Statement } from "bun:sqlite";

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

export class Store implements IngestSink {
  readonly log: EventLog;
  private readonly db: Database;
  private readonly upsertStmt: Statement;
  private events: FlightDeckEvent[];

  constructor(opts: StoreOptions) {
    this.log = opts.log;
    this.db = new Database(opts.dbPath ?? ":memory:");
    this.db.run(CREATE_TABLE);
    this.upsertStmt = this.db.query(UPSERT);
    // Hydrate the in-memory event list from the log (source of truth) and build
    // the view from scratch — the view is never trusted across a restart.
    this.events = this.log.readAll();
    this.rebuildFromEvents();
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
