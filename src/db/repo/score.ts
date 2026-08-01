import type { DatabaseSync } from "node:sqlite";
import type { PositionState } from "../../domain/directive.ts";

export type QueueEntry = {
  asset_id: number;
  symbol: string;
  class: string;
  cluster_id: number | null;
  queue_reason: "flagged" | "open_trade" | "both";
};

export type ScoreRow = {
  d: number;
  conv: number;
  directive: string;
  queue_reason: string;
  position_state: string;
  params_json: string;
  rationale: string | null;
};

/**
 * Flagged this session, unioned with anything carrying an open trade. An open
 * position needs a directive daily whether or not it screened.
 */
export function scoreQueue(db: DatabaseSync, date: string): QueueEntry[] {
  return db
    .prepare(
      `SELECT a.id AS asset_id, a.symbol, a.class, a.cluster_id,
              CASE WHEN f.asset_id IS NOT NULL AND t.asset_id IS NOT NULL THEN 'both'
                   WHEN f.asset_id IS NOT NULL THEN 'flagged'
                   ELSE 'open_trade' END AS queue_reason
       FROM asset a
       LEFT JOIN (SELECT asset_id FROM screen WHERE session_date = ? AND flagged = 1) f ON f.asset_id = a.id
       LEFT JOIN (SELECT DISTINCT asset_id FROM trade WHERE status = 'open') t ON t.asset_id = a.id
       WHERE f.asset_id IS NOT NULL OR t.asset_id IS NOT NULL
       ORDER BY a.symbol`,
    )
    .all(date) as QueueEntry[];
}

/**
 * Side and open unit count for an asset's open trade, if any. An open trade
 * whose units have all closed (a data state Task 17 is meant to prevent by
 * flipping trade.status to 'closed') must not surface as a live position —
 * deriveDirective treats any non-null side as "in a position", so units=0
 * with a side would wrongly unlock HOLD/TRIM/EXIT. Collapse that case to flat.
 */
export function positionOf(db: DatabaseSync, assetId: number): PositionState {
  const row = db
    .prepare(
      `SELECT t.direction, COUNT(u.id) AS units
       FROM trade t LEFT JOIN trade_unit u ON u.trade_id = t.id AND u.status = 'open'
       WHERE t.asset_id = ? AND t.status = 'open'
       GROUP BY t.id`,
    )
    .get(assetId) as { direction: "long" | "short"; units: number } | undefined;
  if (row === undefined || row.units === 0) return { side: null, units: 0 };
  return { side: row.direction, units: row.units };
}

export function recordScore(
  db: DatabaseSync,
  date: string,
  assetId: number,
  row: ScoreRow,
  factors: Record<string, number>,
  weights: Record<string, number>,
  now: string,
): void {
  db.exec("BEGIN");
  try {
    db.prepare(
      `INSERT INTO score (session_date, asset_id, d, conv, directive, queue_reason, position_state, params_json, rationale, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_date, asset_id) DO UPDATE SET
         d = excluded.d, conv = excluded.conv, directive = excluded.directive,
         queue_reason = excluded.queue_reason, position_state = excluded.position_state,
         params_json = excluded.params_json, rationale = excluded.rationale,
         recorded_at = excluded.recorded_at`,
    ).run(date, assetId, row.d, row.conv, row.directive, row.queue_reason, row.position_state, row.params_json, row.rationale, now);

    db.prepare("DELETE FROM score_factor WHERE session_date = ? AND asset_id = ?").run(date, assetId);
    const stmt = db.prepare(
      "INSERT INTO score_factor (session_date, asset_id, key, value, weight) VALUES (?, ?, ?, ?, ?)",
    );
    for (const [key, value] of Object.entries(factors)) {
      stmt.run(date, assetId, key, value, weights[key] ?? 0);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function listScores(db: DatabaseSync, date: string): unknown[] {
  const scores = db
    .prepare(
      `SELECT a.symbol, a.class, s.* FROM score s
       JOIN asset a ON a.id = s.asset_id
       WHERE s.session_date = ? ORDER BY ABS(s.d) DESC, a.symbol`,
    )
    .all(date) as (ScoreRow & { asset_id: number; symbol: string })[];

  const factorRows = db
    .prepare("SELECT asset_id, key, value, weight FROM score_factor WHERE session_date = ?")
    .all(date) as { asset_id: number; key: string; value: number; weight: number }[];

  return scores.map((s) => {
    const factors: Record<string, { value: number; weight: number }> = {};
    for (const f of factorRows) {
      if (f.asset_id === s.asset_id) factors[f.key] = { value: f.value, weight: f.weight };
    }
    return { ...s, factors };
  });
}
