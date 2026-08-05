import type { DatabaseSync } from "node:sqlite";
import { JanusError } from "../../output.ts";

export type ClusterRow = {
  id: number;
  key: string;
  name: string;
  description: string | null;
  notes: string | null;
  created_at: string;
};

export function addCluster(
  db: DatabaseSync,
  key: string,
  name: string,
  description: string | null,
  notes: string | null,
  now: string,
): ClusterRow {
  if (getClusterByKey(db, key) !== undefined) {
    throw new JanusError("ALREADY_EXISTS", `cluster ${key} already exists`);
  }
  db.prepare("INSERT INTO cluster (key, name, description, notes, created_at) VALUES (?, ?, ?, ?, ?)").run(
    key, name, description, notes, now,
  );
  return requireClusterByKey(db, key);
}

export function setClusterDescription(
  db: DatabaseSync,
  key: string,
  description: string | null | undefined,
): ClusterRow {
  const row = requireClusterByKey(db, key);
  db.prepare("UPDATE cluster SET description = ? WHERE id = ?").run(description ?? null, row.id);
  return requireClusterByKey(db, key);
}

export function listClusters(db: DatabaseSync): ClusterRow[] {
  return db.prepare("SELECT * FROM cluster ORDER BY key").all() as ClusterRow[];
}

export function getClusterByKey(db: DatabaseSync, key: string): ClusterRow | undefined {
  return db.prepare("SELECT * FROM cluster WHERE key = ?").get(key) as ClusterRow | undefined;
}

export function requireClusterByKey(db: DatabaseSync, key: string): ClusterRow {
  const row = getClusterByKey(db, key);
  if (row === undefined) throw new JanusError("NOT_FOUND", `no cluster ${key}`);
  return row;
}

/** A null clusterId targets the global_param table. */
export function setClusterParam(
  db: DatabaseSync,
  clusterId: number | null,
  key: string,
  value: number,
): void {
  if (clusterId === null) {
    db.prepare(
      "INSERT INTO global_param (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(key, value);
    return;
  }
  db.prepare(
    `INSERT INTO cluster_param (cluster_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT(cluster_id, key) DO UPDATE SET value = excluded.value`,
  ).run(clusterId, key, value);
}

function toMap(rows: unknown[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows as { key: string; value: number }[]) out[r.key] = r.value;
  return out;
}

export function getClusterParams(db: DatabaseSync, clusterId: number | null): Record<string, number> {
  if (clusterId === null) return {};
  return toMap(db.prepare("SELECT key, value FROM cluster_param WHERE cluster_id = ?").all(clusterId));
}

export function getGlobalParams(db: DatabaseSync): Record<string, number> {
  return toMap(db.prepare("SELECT key, value FROM global_param").all());
}

export function removeCluster(db: DatabaseSync, key: string): void {
  const row = requireClusterByKey(db, key);
  db.prepare("DELETE FROM cluster WHERE id = ?").run(row.id);
}
