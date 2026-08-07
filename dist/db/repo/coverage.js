const COLUMNS = [
    "open", "high", "low", "close", "volume",
    "mark_price", "index_price", "open_interest", "daily_change_pct",
    "sma20", "sma50", "sma200", "ema12", "ema26", "atr14",
    "px_vs_sma20", "px_vs_sma50", "px_vs_sma200",
    "cross_50_200", "cross_50_200_age", "cross_px_50", "cross_px_50_age",
    "bars_available", "fetched_at",
];
/** All rows land in one transaction, so an upstream failure never leaves a partial slice. */
export function upsertCoverage(db, date, rows) {
    const placeholders = COLUMNS.map(() => "?").join(", ");
    const updates = COLUMNS.map((c) => `${c} = excluded.${c}`).join(", ");
    const stmt = db.prepare(`INSERT INTO coverage (session_date, asset_id, ${COLUMNS.join(", ")})
     VALUES (?, ?, ${placeholders})
     ON CONFLICT(session_date, asset_id) DO UPDATE SET ${updates}`);
    db.exec("BEGIN");
    try {
        for (const row of rows) {
            stmt.run(date, row.asset_id, ...COLUMNS.map((c) => row.values[c]));
        }
        db.exec("COMMIT");
    }
    catch (e) {
        db.exec("ROLLBACK");
        throw e;
    }
}
/**
 * One asset's coverage row for the session, or null if it was never fetched.
 * Selecting COLUMNS rather than * is what makes the CoverageValues cast honest.
 */
export function getCoverage(db, date, assetId) {
    const row = db
        .prepare(`SELECT ${COLUMNS.join(", ")} FROM coverage WHERE session_date = ? AND asset_id = ?`)
        .get(date, assetId);
    return row ?? null;
}
export function listCoverage(db, date, symbols) {
    const filter = symbols === undefined ? "" : `AND a.symbol IN (${symbols.map(() => "?").join(",")})`;
    return db
        .prepare(`SELECT a.symbol, a.class, c.* FROM coverage c
       JOIN asset a ON a.id = c.asset_id
       WHERE c.session_date = ? ${filter}
       ORDER BY a.symbol`)
        .all(date, ...(symbols ?? []));
}
/**
 * The most recent coverage row for an asset.
 *
 * `onOrBefore` bounds the search to that session date, which is what any caller
 * reasoning about a past date wants: marking a trade against a row from *after*
 * the date in question prices it with information that did not exist yet. Omit
 * it only when the question really is "the newest data we hold" — trailing a
 * stop right now, say.
 */
export function latestCoverage(db, assetId, onOrBefore) {
    const bound = onOrBefore === undefined ? "" : "AND session_date <= ?";
    const row = db
        .prepare(`SELECT session_date, ${COLUMNS.join(", ")} FROM coverage
       WHERE asset_id = ? ${bound} ORDER BY session_date DESC LIMIT 1`)
        .get(assetId, ...(onOrBefore === undefined ? [] : [onOrBefore]));
    if (row === undefined)
        return null;
    const { session_date, ...values } = row;
    return { session_date, values };
}
