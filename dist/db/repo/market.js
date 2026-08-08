export function upsertMarkets(db, markets, syncedAt) {
    const stmt = db.prepare(`
    INSERT INTO market (market_id, symbol, market_type, status, price_decimals, size_decimals, listed_at, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(market_id) DO UPDATE SET
      symbol = excluded.symbol, market_type = excluded.market_type, status = excluded.status,
      price_decimals = excluded.price_decimals, size_decimals = excluded.size_decimals,
      listed_at = excluded.listed_at, synced_at = excluded.synced_at
  `);
    db.exec("BEGIN");
    try {
        for (const m of markets) {
            stmt.run(m.market_id, m.symbol, m.market_type, m.status, m.price_decimals, m.size_decimals, m.listed_at, syncedAt);
        }
        db.exec("COMMIT");
    }
    catch (e) {
        db.exec("ROLLBACK");
        throw e;
    }
    return markets.length;
}
export function listMarkets(db, opts) {
    const where = [];
    const args = [];
    if (opts.search !== undefined) {
        where.push("symbol LIKE ?");
        args.push(`%${opts.search.toUpperCase()}%`);
    }
    if (opts.status !== undefined) {
        where.push("status = ?");
        args.push(opts.status);
    }
    const sql = `SELECT * FROM market ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY symbol`;
    return db.prepare(sql).all(...args);
}
export function nextMarketId(db) {
    const row = db.prepare("SELECT COALESCE(MAX(market_id), 0) + 1 AS id FROM market").get();
    return row.id;
}
export function getMarketBySymbol(db, symbol) {
    return db.prepare("SELECT * FROM market WHERE symbol = ?").get(symbol);
}
