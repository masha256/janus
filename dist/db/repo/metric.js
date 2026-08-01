/** A number lands in value_num, anything else in value_text; exactly one is ever set. */
const value = (r) => r.value_num ?? r.value_text ?? 0;
/** Replaces the whole metric set for the scope, so stale keys cannot survive a re-run. */
export function replaceMetrics(db, table, scope, metrics) {
    const cols = Object.keys(scope);
    const vals = Object.values(scope);
    db.prepare(`DELETE FROM ${table} WHERE ${cols.map((c) => `${c} = ?`).join(" AND ")}`).run(...vals);
    const stmt = db.prepare(`INSERT INTO ${table} (${cols.join(", ")}, key, value_num, value_text)
     VALUES (${cols.map(() => "?").join(", ")}, ?, ?, ?)`);
    for (const [key, v] of Object.entries(metrics)) {
        const num = typeof v === "number" ? v : null;
        stmt.run(...vals, key, num, num === null ? String(v) : null);
    }
}
export function readMetrics(db, table, scope) {
    const cols = Object.keys(scope);
    const rows = db
        .prepare(`SELECT key, value_num, value_text FROM ${table}
       WHERE ${cols.map((c) => `${c} = ?`).join(" AND ")} ORDER BY key`)
        .all(...Object.values(scope));
    return Object.fromEntries(rows.map((r) => [r.key, value(r)]));
}
/** One session's metrics grouped by owning entity, for the list queries. */
export function metricsByEntity(db, table, idCol, date) {
    const rows = db
        .prepare(`SELECT ${idCol} AS id, key, value_num, value_text FROM ${table}
       WHERE session_date = ? ORDER BY key`)
        .all(date);
    const byId = new Map();
    for (const r of rows) {
        const m = byId.get(r.id) ?? {};
        m[r.key] = value(r);
        byId.set(r.id, m);
    }
    return byId;
}
