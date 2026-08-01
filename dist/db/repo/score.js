import { metricsByEntity, replaceMetrics } from "./metric.js";
/**
 * Flagged this session, unioned with anything carrying an open trade. An open
 * position needs a directive daily whether or not it screened.
 */
export function scoreQueue(db, date) {
    return db
        .prepare(`SELECT a.id AS asset_id, a.symbol, a.class, a.cluster_id,
              CASE WHEN f.asset_id IS NOT NULL AND t.asset_id IS NOT NULL THEN 'both'
                   WHEN f.asset_id IS NOT NULL THEN 'flagged'
                   ELSE 'open_trade' END AS queue_reason
       FROM asset a
       LEFT JOIN (SELECT asset_id FROM screen WHERE session_date = ? AND flagged = 1) f ON f.asset_id = a.id
       LEFT JOIN (SELECT DISTINCT asset_id FROM trade WHERE status = 'open') t ON t.asset_id = a.id
       WHERE f.asset_id IS NOT NULL OR t.asset_id IS NOT NULL
       ORDER BY a.symbol`)
        .all(date);
}
/**
 * Side and open unit count for an asset's open trade, if any. An open trade
 * whose units have all closed (a data state Task 17 is meant to prevent by
 * flipping trade.status to 'closed') must not surface as a live position —
 * a directive formula treats any non-null side as "in a position", so units=0
 * with a side would wrongly unlock HOLD/TRIM/EXIT. Collapse that case to flat.
 */
export function positionOf(db, assetId) {
    const row = db
        .prepare(`SELECT t.direction, COUNT(u.id) AS units
       FROM trade t LEFT JOIN trade_unit u ON u.trade_id = t.id AND u.status = 'open'
       WHERE t.asset_id = ? AND t.status = 'open'
       GROUP BY t.id`)
        .get(assetId);
    if (row === undefined || row.units === 0)
        return { side: null, units: 0 };
    return { side: row.direction, units: row.units };
}
/**
 * Every open position in the book, for formulas that weigh a decision against
 * what is already on. Same units=0 collapse as positionOf: a trade whose units
 * have all closed is not a live position.
 */
export function openPositions(db) {
    return db
        .prepare(`SELECT t.asset_id, a.symbol, t.direction AS side, COUNT(u.id) AS units
       FROM trade t
       JOIN asset a ON a.id = t.asset_id
       LEFT JOIN trade_unit u ON u.trade_id = t.id AND u.status = 'open'
       WHERE t.status = 'open'
       GROUP BY t.id
       HAVING units > 0
       ORDER BY a.symbol`)
        .all();
}
export function recordScore(db, date, assetId, row, now) {
    db.exec("BEGIN");
    try {
        db.prepare(`INSERT INTO score (session_date, asset_id, strength, conviction, directive, queue_reason, position_state, rationale, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_date, asset_id) DO UPDATE SET
         strength = excluded.strength, conviction = excluded.conviction,
         directive = excluded.directive,
         queue_reason = excluded.queue_reason, position_state = excluded.position_state,
         rationale = excluded.rationale, recorded_at = excluded.recorded_at`).run(date, assetId, row.strength, row.conviction, row.directive, row.queue_reason, row.position_state, row.rationale, now);
        const scope = { session_date: date, asset_id: assetId };
        replaceMetrics(db, "score_metric", scope, row.metrics);
        replaceMetrics(db, "score_result", scope, row.results);
        db.exec("COMMIT");
    }
    catch (e) {
        db.exec("ROLLBACK");
        throw e;
    }
}
export function listScores(db, date) {
    const scores = db
        .prepare(`SELECT a.symbol, a.class, s.* FROM score s
       JOIN asset a ON a.id = s.asset_id
       WHERE s.session_date = ? ORDER BY ABS(s.strength) DESC, a.symbol`)
        .all(date);
    const metrics = metricsByEntity(db, "score_metric", "asset_id", date);
    const results = metricsByEntity(db, "score_result", "asset_id", date);
    return scores.map((s) => ({
        ...s,
        metrics: metrics.get(s.asset_id) ?? {},
        results: results.get(s.asset_id) ?? {},
    }));
}
