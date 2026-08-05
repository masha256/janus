import { JanusError } from "../../output.js";
export function addCluster(db, key, name, description, notes, now) {
    if (getClusterByKey(db, key) !== undefined) {
        throw new JanusError("ALREADY_EXISTS", `cluster ${key} already exists`);
    }
    db.prepare("INSERT INTO cluster (key, name, description, notes, created_at) VALUES (?, ?, ?, ?, ?)").run(key, name, description, notes, now);
    return requireClusterByKey(db, key);
}
export function setClusterDescription(db, key, description) {
    const row = requireClusterByKey(db, key);
    db.prepare("UPDATE cluster SET description = ? WHERE id = ?").run(description ?? null, row.id);
    return requireClusterByKey(db, key);
}
export function listClusters(db) {
    return db.prepare("SELECT * FROM cluster ORDER BY key").all();
}
export function getClusterByKey(db, key) {
    return db.prepare("SELECT * FROM cluster WHERE key = ?").get(key);
}
export function requireClusterByKey(db, key) {
    const row = getClusterByKey(db, key);
    if (row === undefined)
        throw new JanusError("NOT_FOUND", `no cluster ${key}`);
    return row;
}
/** A null clusterId targets the global_param table. */
export function setClusterParam(db, clusterId, key, value) {
    if (clusterId === null) {
        db.prepare("INSERT INTO global_param (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
        return;
    }
    db.prepare(`INSERT INTO cluster_param (cluster_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT(cluster_id, key) DO UPDATE SET value = excluded.value`).run(clusterId, key, value);
}
function toMap(rows) {
    const out = {};
    for (const r of rows)
        out[r.key] = r.value;
    return out;
}
export function getClusterParams(db, clusterId) {
    if (clusterId === null)
        return {};
    return toMap(db.prepare("SELECT key, value FROM cluster_param WHERE cluster_id = ?").all(clusterId));
}
export function getGlobalParams(db) {
    return toMap(db.prepare("SELECT key, value FROM global_param").all());
}
export function removeCluster(db, key) {
    const row = requireClusterByKey(db, key);
    db.prepare("DELETE FROM cluster WHERE id = ?").run(row.id);
}
export function removeGlobalParam(db, key) {
    db.prepare("DELETE FROM global_param WHERE key = ?").run(key);
}
