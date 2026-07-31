import type { DatabaseSync } from "node:sqlite";
import type { CoverageValues } from "../../domain/coverage.ts";

const COLUMNS = [
  "open", "high", "low", "close", "volume",
  "mark_price", "index_price", "open_interest", "daily_change_pct",
  "sma20", "sma50", "sma200", "ema12", "ema26", "atr14",
  "px_vs_sma20", "px_vs_sma50", "px_vs_sma200",
  "cross_50_200", "cross_50_200_age", "cross_px_50", "cross_px_50_age",
  "bars_available", "fetched_at",
] as const;

/** All rows land in one transaction, so an upstream failure never leaves a partial slice. */
export function upsertCoverage(
  db: DatabaseSync,
  date: string,
  rows: { asset_id: number; values: CoverageValues }[],
): void {
  const placeholders = COLUMNS.map(() => "?").join(", ");
  const updates = COLUMNS.map((c) => `${c} = excluded.${c}`).join(", ");
  const stmt = db.prepare(
    `INSERT INTO coverage (session_date, asset_id, ${COLUMNS.join(", ")})
     VALUES (?, ?, ${placeholders})
     ON CONFLICT(session_date, asset_id) DO UPDATE SET ${updates}`,
  );
  db.exec("BEGIN");
  try {
    for (const row of rows) {
      stmt.run(date, row.asset_id, ...COLUMNS.map((c) => row.values[c]));
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function listCoverage(db: DatabaseSync, date: string, symbols?: string[]): unknown[] {
  const filter = symbols === undefined ? "" : `AND a.symbol IN (${symbols.map(() => "?").join(",")})`;
  return db
    .prepare(
      `SELECT a.symbol, a.class, c.* FROM coverage c
       JOIN asset a ON a.id = c.asset_id
       WHERE c.session_date = ? ${filter}
       ORDER BY a.symbol`,
    )
    .all(date, ...(symbols ?? []));
}
