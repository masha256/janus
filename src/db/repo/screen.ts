import type { DatabaseSync } from "node:sqlite";
import { type Metrics, metricsByEntity, readMetrics, replaceMetrics } from "./metric.ts";

export type ScreenInput = {
  /** The formula's call on whether this asset makes the scoring queue. */
  flagged: boolean;
  rationale: string | null;
  /** What was observed. */
  metrics: Metrics;
  /** What the formula concluded — the threshold in force, and whatever else it keeps. */
  results: Metrics;
};

export function recordScreen(
  db: DatabaseSync,
  date: string,
  assetId: number,
  input: ScreenInput,
  now: string,
): void {
  const scope = { session_date: date, asset_id: assetId };
  db.exec("BEGIN");
  try {
    db.prepare(
      `INSERT INTO screen (session_date, asset_id, flagged, rationale, recorded_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_date, asset_id) DO UPDATE SET
         flagged = excluded.flagged, rationale = excluded.rationale,
         recorded_at = excluded.recorded_at`,
    ).run(date, assetId, input.flagged ? 1 : 0, input.rationale, now);
    replaceMetrics(db, "screen_metric", scope, input.metrics);
    replaceMetrics(db, "screen_result", scope, input.results);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** One asset's screen for the session, or null if it was never screened. */
export function getScreen(
  db: DatabaseSync,
  date: string,
  assetId: number,
): { flagged: boolean; metrics: Metrics; results: Metrics } | null {
  const scope = { session_date: date, asset_id: assetId };
  const row = db
    .prepare("SELECT flagged FROM screen WHERE session_date = ? AND asset_id = ?")
    .get(date, assetId) as { flagged: number } | undefined;
  if (row === undefined) return null;
  return {
    flagged: row.flagged === 1,
    metrics: readMetrics(db, "screen_metric", scope),
    results: readMetrics(db, "screen_result", scope),
  };
}

export function listScreen(
  db: DatabaseSync,
  date: string,
  opts: { flaggedOnly?: boolean | undefined },
): unknown[] {
  const rows = db
    .prepare(
      `SELECT a.symbol, a.class, s.* FROM screen s
       JOIN asset a ON a.id = s.asset_id
       LEFT JOIN screen_metric m
         ON m.session_date = s.session_date AND m.asset_id = s.asset_id AND m.key = 'score'
       WHERE s.session_date = ? ${opts.flaggedOnly === true ? "AND s.flagged = 1" : ""}
       ORDER BY m.value_num DESC, a.symbol`,
    )
    .all(date) as { asset_id: number }[];
  const metrics = metricsByEntity(db, "screen_metric", "asset_id", date);
  const results = metricsByEntity(db, "screen_result", "asset_id", date);
  return rows.map((r) => ({
    ...r,
    metrics: metrics.get(r.asset_id) ?? {},
    results: results.get(r.asset_id) ?? {},
  }));
}

export function countCoverage(db: DatabaseSync, date: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM coverage WHERE session_date = ?").get(date) as { n: number }).n;
}

export function countScreened(db: DatabaseSync, date: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM screen WHERE session_date = ?").get(date) as { n: number }).n;
}
