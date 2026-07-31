import type { DatabaseSync } from "node:sqlite";

export type ScreenInput = {
  score: number;
  confidence: number;
  threshold: number;
  flagged: boolean;
  rationale: string | null;
};

export function recordScreen(
  db: DatabaseSync,
  date: string,
  assetId: number,
  input: ScreenInput,
  now: string,
): void {
  db.prepare(
    `INSERT INTO screen (session_date, asset_id, score, confidence, threshold, flagged, rationale, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_date, asset_id) DO UPDATE SET
       score = excluded.score, confidence = excluded.confidence, threshold = excluded.threshold,
       flagged = excluded.flagged, rationale = excluded.rationale, recorded_at = excluded.recorded_at`,
  ).run(date, assetId, input.score, input.confidence, input.threshold, input.flagged ? 1 : 0, input.rationale, now);
}

export function listScreen(
  db: DatabaseSync,
  date: string,
  opts: { flaggedOnly?: boolean | undefined },
): unknown[] {
  return db
    .prepare(
      `SELECT a.symbol, a.class, s.* FROM screen s
       JOIN asset a ON a.id = s.asset_id
       WHERE s.session_date = ? ${opts.flaggedOnly === true ? "AND s.flagged = 1" : ""}
       ORDER BY s.score DESC, a.symbol`,
    )
    .all(date);
}

export function countCoverage(db: DatabaseSync, date: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM coverage WHERE session_date = ?").get(date) as { n: number }).n;
}

export function countScreened(db: DatabaseSync, date: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM screen WHERE session_date = ?").get(date) as { n: number }).n;
}
