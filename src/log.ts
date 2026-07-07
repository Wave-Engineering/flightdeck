// Append-only event log — the SINGLE SOURCE OF TRUTH (Dev Spec TC-3).
//
// One JSON object per line (JSONL). Events are only ever appended, never mutated
// or deleted. The SQLite materialized view (store.ts) is a pure, rebuildable fold
// of this log; if the view and the log disagree, the log wins and the view is
// rebuilt. Ingest (server.ts) appends here BEFORE updating the view, so a crash
// mid-write can lose at most the view update — never a persisted event.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import type { FlightDeckEvent } from "./events/contract.ts";

/** A minimal append sink the ingest server writes to (log or store both satisfy it). */
export interface IngestSink {
  append(event: FlightDeckEvent): void;
}

export class EventLog implements IngestSink {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
    const dir = dirname(path);
    if (dir && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /** Append one event as a JSONL line. Append-only; never rewrites existing lines. */
  append(event: FlightDeckEvent): void {
    appendFileSync(this.path, `${JSON.stringify(event)}\n`, { encoding: "utf-8" });
  }

  /** Every persisted event, in log (append) order. Missing file ⇒ []. */
  readAll(): FlightDeckEvent[] {
    return this.readLines().map((line) => JSON.parse(line) as FlightDeckEvent);
  }

  /** Raw non-empty JSONL lines, in order. Missing file ⇒ []. */
  readLines(): string[] {
    if (!existsSync(this.path)) return [];
    const text = readFileSync(this.path, { encoding: "utf-8" });
    const lines: string[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length > 0) lines.push(trimmed);
    }
    return lines;
  }

  /** Number of persisted events. */
  count(): number {
    return this.readLines().length;
  }
}
