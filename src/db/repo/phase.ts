import type { DatabaseSync } from "node:sqlite";
import { type Metrics, metricsByEntity, readMetrics, replaceMetrics } from "./metric.ts";

/** Both read phases store observations (`metrics`) and conclusions (`results`) the same way. */
export type ReadInput = {
  metrics: Metrics;
  results: Metrics;
};

export type MacroInput = ReadInput & {
  summary: string;
};

/** Replaces the whole macro slice for the date so stale keys cannot survive a re-run. */
export function recordMacro(
  db: DatabaseSync,
  date: string,
  input: MacroInput,
  now: string,
): void {
  db.exec("BEGIN");
  try {
    db.prepare(
      `INSERT INTO macro_read (session_date, summary, recorded_at)
       VALUES (?, ?, ?)
       ON CONFLICT(session_date) DO UPDATE SET
         summary = excluded.summary,
         recorded_at = excluded.recorded_at`,
    ).run(date, input.summary, now);
    replaceMetrics(db, "macro_read_metric", { session_date: date }, input.metrics);
    replaceMetrics(db, "macro_read_result", { session_date: date }, input.results);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export type MacroRead = {
  read: { session_date: string; state: string; summary: string; recorded_at: string } | undefined;
  metrics: Metrics;
  results: Metrics;
};

export function getMacro(db: DatabaseSync, date: string): MacroRead {
  return {
    read: db.prepare("SELECT * FROM macro_read WHERE session_date = ?").get(date) as
      MacroRead["read"],
    metrics: readMetrics(db, "macro_read_metric", { session_date: date }),
    results: readMetrics(db, "macro_read_result", { session_date: date }),
  };
}

/** The read row is bare — whatever was observed lands in metrics, the only derived result is regime_smile. */
export function recordClusterRead(
  db: DatabaseSync,
  date: string,
  clusterId: number,
  input: ReadInput,
  now: string,
): void {
  const scope = { session_date: date, cluster_id: clusterId };
  db.exec("BEGIN");
  try {
    db.prepare(
      `INSERT INTO cluster_read (session_date, cluster_id, recorded_at)
       VALUES (?, ?, ?)
       ON CONFLICT(session_date, cluster_id) DO UPDATE SET recorded_at = excluded.recorded_at`,
    ).run(date, clusterId, now);
    replaceMetrics(db, "cluster_read_metric", scope, input.metrics);
    replaceMetrics(db, "cluster_read_result", scope, input.results);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** One cluster's read for the session. Empty bags when it has not been read yet. */
export function getClusterRead(db: DatabaseSync, date: string, clusterId: number): ReadInput {
  const scope = { session_date: date, cluster_id: clusterId };
  return {
    metrics: readMetrics(db, "cluster_read_metric", scope),
    results: readMetrics(db, "cluster_read_result", scope),
  };
}

export function listClusterReads(db: DatabaseSync, date: string): unknown[] {
  const reads = db
    .prepare(
      `SELECT cr.*, c.key AS cluster_key, c.name AS cluster_name
       FROM cluster_read cr JOIN cluster c ON c.id = cr.cluster_id
       WHERE cr.session_date = ? ORDER BY c.key`,
    )
    .all(date) as { cluster_id: number }[];
  const metrics = metricsByEntity(db, "cluster_read_metric", "cluster_id", date);
  const results = metricsByEntity(db, "cluster_read_result", "cluster_id", date);
  return reads.map((r) => ({
    ...r,
    metrics: metrics.get(r.cluster_id) ?? {},
    results: results.get(r.cluster_id) ?? {},
  }));
}
