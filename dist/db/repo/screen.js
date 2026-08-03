import { metricsByEntity, readMetrics, replaceMetrics } from "./metric.js";
export function recordScreen(db, date, assetId, input, now) {
    const scope = { session_date: date, asset_id: assetId };
    db.exec("BEGIN");
    try {
        db.prepare(`INSERT INTO screen (session_date, asset_id, flagged, rationale, binary_date, binary_reason, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_date, asset_id) DO UPDATE SET
         flagged = excluded.flagged, rationale = excluded.rationale,
         binary_date = excluded.binary_date, binary_reason = excluded.binary_reason,
         recorded_at = excluded.recorded_at`).run(date, assetId, input.flagged ? 1 : 0, input.rationale, input.binary_date ?? null, input.binary_reason ?? null, now);
        replaceMetrics(db, "screen_metric", scope, input.metrics);
        replaceMetrics(db, "screen_result", scope, input.results);
        db.exec("COMMIT");
    }
    catch (e) {
        db.exec("ROLLBACK");
        throw e;
    }
}
/** One asset's screen for the session, or null if it was never screened. */
export function getScreen(db, date, assetId) {
    const scope = { session_date: date, asset_id: assetId };
    const row = db
        .prepare("SELECT flagged, binary_date, binary_reason FROM screen WHERE session_date = ? AND asset_id = ?")
        .get(date, assetId);
    if (row === undefined)
        return null;
    return {
        flagged: row.flagged === 1,
        binary_date: row.binary_date,
        binary_reason: row.binary_reason,
        metrics: readMetrics(db, "screen_metric", scope),
        results: readMetrics(db, "screen_result", scope),
    };
}
export function listScreen(db, date, opts) {
    const rows = db
        .prepare(`SELECT a.symbol, a.class, s.* FROM screen s
       JOIN asset a ON a.id = s.asset_id
       LEFT JOIN screen_metric m
         ON m.session_date = s.session_date AND m.asset_id = s.asset_id AND m.key = 'score'
       WHERE s.session_date = ? ${opts.flaggedOnly === true ? "AND s.flagged = 1" : ""}
       ORDER BY m.value_num DESC, a.symbol`)
        .all(date);
    const metrics = metricsByEntity(db, "screen_metric", "asset_id", date);
    const results = metricsByEntity(db, "screen_result", "asset_id", date);
    return rows.map((r) => ({
        ...r,
        metrics: metrics.get(r.asset_id) ?? {},
        results: results.get(r.asset_id) ?? {},
    }));
}
export function countCoverage(db, date) {
    return db.prepare("SELECT COUNT(*) AS n FROM coverage WHERE session_date = ?").get(date).n;
}
export function countScreened(db, date) {
    return db.prepare("SELECT COUNT(*) AS n FROM screen WHERE session_date = ?").get(date).n;
}
