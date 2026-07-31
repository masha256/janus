import type { DatabaseSync } from "node:sqlite";

export type RegimeInput = {
  state: string;
  score: number;
  confidence: number;
  summary: string;
  metrics: Record<string, number>;
};

/** Replaces the whole regime slice for the date so stale metrics cannot survive a re-run. */
export function recordRegime(
  db: DatabaseSync,
  date: string,
  input: RegimeInput,
  now: string,
): void {
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM regime_metric WHERE session_date = ?").run(date);
    db.prepare(
      `INSERT INTO regime_read (session_date, state, score, confidence, summary, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_date) DO UPDATE SET
         state = excluded.state, score = excluded.score, confidence = excluded.confidence,
         summary = excluded.summary, recorded_at = excluded.recorded_at`,
    ).run(date, input.state, input.score, input.confidence, input.summary, now);
    const metric = db.prepare(
      "INSERT INTO regime_metric (session_date, key, value_num) VALUES (?, ?, ?)",
    );
    for (const [key, value] of Object.entries(input.metrics)) metric.run(date, key, value);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function getRegime(db: DatabaseSync, date: string): unknown {
  const read = db.prepare("SELECT * FROM regime_read WHERE session_date = ?").get(date);
  const rows = db
    .prepare("SELECT key, value_num FROM regime_metric WHERE session_date = ? ORDER BY key")
    .all(date) as { key: string; value_num: number }[];
  const metrics: Record<string, number> = {};
  for (const r of rows) metrics[r.key] = r.value_num;
  return { read, metrics };
}

export function recordClusterRead(
  db: DatabaseSync,
  date: string,
  clusterId: number,
  bias: number,
  judgement: string,
  now: string,
): void {
  db.prepare(
    `INSERT INTO cluster_read (session_date, cluster_id, bias, judgement, recorded_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(session_date, cluster_id) DO UPDATE SET
       bias = excluded.bias, judgement = excluded.judgement, recorded_at = excluded.recorded_at`,
  ).run(date, clusterId, bias, judgement, now);
}

export function listClusterReads(db: DatabaseSync, date: string): unknown[] {
  return db
    .prepare(
      `SELECT cr.*, c.key AS cluster_key, c.name AS cluster_name
       FROM cluster_read cr JOIN cluster c ON c.id = cr.cluster_id
       WHERE cr.session_date = ? ORDER BY c.key`,
    )
    .all(date);
}
