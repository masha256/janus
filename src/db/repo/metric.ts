import type { DatabaseSync } from "node:sqlite";
import type { Metrics } from "../../domain/metrics.ts";

/**
 * Every phase table stores its numbers the same way: a sibling `<table>_metric`
 * of (scope columns…, key, value_num, value_text). `scope` is the parent's key —
 * { session_date } for macro, { session_date, asset_id } for screen and score.
 * Table and column names are module-level constants, never user input.
 */
export type { Metrics };
type Scope = Record<string, string | number>;
type Row = { key: string; value_num: number | null; value_text: string | null };

/** A number lands in value_num, anything else in value_text; exactly one is ever set. */
const value = (r: Row): number | string => r.value_num ?? r.value_text ?? 0;

/** Replaces the whole metric set for the scope, so stale keys cannot survive a re-run. */
export function replaceMetrics(
  db: DatabaseSync,
  table: string,
  scope: Scope,
  metrics: Metrics,
): void {
  const cols = Object.keys(scope);
  const vals = Object.values(scope);
  db.prepare(`DELETE FROM ${table} WHERE ${cols.map((c) => `${c} = ?`).join(" AND ")}`).run(...vals);
  const stmt = db.prepare(
    `INSERT INTO ${table} (${cols.join(", ")}, key, value_num, value_text)
     VALUES (${cols.map(() => "?").join(", ")}, ?, ?, ?)`,
  );
  for (const [key, v] of Object.entries(metrics)) {
    const num = typeof v === "number" ? v : null;
    stmt.run(...vals, key, num, num === null ? String(v) : null);
  }
}

export function readMetrics(db: DatabaseSync, table: string, scope: Scope): Metrics {
  const cols = Object.keys(scope);
  const rows = db
    .prepare(
      `SELECT key, value_num, value_text FROM ${table}
       WHERE ${cols.map((c) => `${c} = ?`).join(" AND ")} ORDER BY key`,
    )
    .all(...Object.values(scope)) as Row[];
  return Object.fromEntries(rows.map((r) => [r.key, value(r)]));
}

/** One session's metrics grouped by owning entity, for the list queries. */
export function metricsByEntity(
  db: DatabaseSync,
  table: string,
  idCol: string,
  date: string,
): Map<number, Metrics> {
  const rows = db
    .prepare(
      `SELECT ${idCol} AS id, key, value_num, value_text FROM ${table}
       WHERE session_date = ? ORDER BY key`,
    )
    .all(date) as (Row & { id: number })[];
  const byId = new Map<number, Metrics>();
  for (const r of rows) {
    const m = byId.get(r.id) ?? {};
    m[r.key] = value(r);
    byId.set(r.id, m);
  }
  return byId;
}
