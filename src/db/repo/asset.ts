import type { DatabaseSync } from "node:sqlite";
import { JanusError } from "../../output.ts";
import { getMarketBySymbol } from "./market.ts";
import { requireClusterByKey } from "./cluster.ts";

export const ASSET_CLASSES = ["crypto", "equity", "etf", "commodity", "fx", "index"] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];

export type AssetRow = {
  id: number;
  market_id: number;
  symbol: string;
  class: string;
  cluster_id: number | null;
  cluster_key: string | null;
  active: number;
  notes: string | null;
  added_at: string;
  lighter_status: string;
};

const SELECT = `
  SELECT a.*, c.key AS cluster_key, m.status AS lighter_status
  FROM asset a
  JOIN market m ON m.market_id = a.market_id
  LEFT JOIN cluster c ON c.id = a.cluster_id
`;

export function getAssetBySymbol(db: DatabaseSync, symbol: string): AssetRow | undefined {
  return db.prepare(`${SELECT} WHERE a.symbol = ?`).get(symbol) as AssetRow | undefined;
}

export function requireAssetBySymbol(db: DatabaseSync, symbol: string): AssetRow {
  const row = getAssetBySymbol(db, symbol);
  if (row === undefined) throw new JanusError("NOT_FOUND", `no asset ${symbol} in the roster`);
  return row;
}

export function addAsset(
  db: DatabaseSync,
  symbol: string,
  cls: string,
  clusterKey: string | null,
  notes: string | null,
  now: string,
): AssetRow {
  if (getAssetBySymbol(db, symbol) !== undefined) {
    throw new JanusError("ALREADY_EXISTS", `${symbol} is already in the roster`);
  }
  const market = getMarketBySymbol(db, symbol);
  if (market === undefined) {
    throw new JanusError("NOT_FOUND", `no Lighter market ${symbol}; run "janus market sync" first`);
  }
  const clusterId = clusterKey === null ? null : requireClusterByKey(db, clusterKey).id;
  db.prepare(
    "INSERT INTO asset (market_id, symbol, class, cluster_id, active, notes, added_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
  ).run(market.market_id, symbol, cls, clusterId, notes, now);
  return requireAssetBySymbol(db, symbol);
}

export function listAssets(
  db: DatabaseSync,
  filters: { active?: boolean | undefined; cls?: string | undefined; clusterKey?: string | undefined },
): AssetRow[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (filters.active !== undefined) {
    where.push("a.active = ?");
    args.push(filters.active ? 1 : 0);
  }
  if (filters.cls !== undefined) {
    where.push("a.class = ?");
    args.push(filters.cls);
  }
  if (filters.clusterKey !== undefined) {
    where.push("c.key = ?");
    args.push(filters.clusterKey);
  }
  const sql = `${SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY a.symbol`;
  return db.prepare(sql).all(...args) as AssetRow[];
}

export function updateAsset(
  db: DatabaseSync,
  symbol: string,
  patch: { cls?: string | undefined; clusterKey?: string | undefined; notes?: string | undefined },
): AssetRow {
  const asset = requireAssetBySymbol(db, symbol);
  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  if (patch.cls !== undefined) {
    sets.push("class = ?");
    args.push(patch.cls);
  }
  if (patch.clusterKey !== undefined) {
    sets.push("cluster_id = ?");
    args.push(patch.clusterKey === "" ? null : requireClusterByKey(db, patch.clusterKey).id);
  }
  if (patch.notes !== undefined) {
    sets.push("notes = ?");
    args.push(patch.notes);
  }
  if (sets.length === 0) throw new JanusError("VALIDATION", "nothing to update; pass --cluster, --class, or --notes");
  args.push(asset.id);
  db.prepare(`UPDATE asset SET ${sets.join(", ")} WHERE id = ?`).run(...args);
  return requireAssetBySymbol(db, symbol);
}

export function setAssetActive(db: DatabaseSync, symbol: string, active: boolean): AssetRow {
  const asset = requireAssetBySymbol(db, symbol);
  db.prepare("UPDATE asset SET active = ? WHERE id = ?").run(active ? 1 : 0, asset.id);
  return requireAssetBySymbol(db, symbol);
}

export function removeAsset(db: DatabaseSync, symbol: string): void {
  const asset = requireAssetBySymbol(db, symbol);
  // trade.asset_id has no ON DELETE action, so without this the FK failure
  // surfaces as INTERNAL — the one code that tells an agent nothing actionable.
  const { n } = db
    .prepare("SELECT COUNT(*) AS n FROM trade WHERE asset_id = ?")
    .get(asset.id) as { n: number };
  if (n > 0) {
    throw new JanusError(
      "VALIDATION",
      `${asset.symbol} has ${n} trade${n === 1 ? "" : "s"}; deactivate it instead of removing it`,
    );
  }
  db.prepare("DELETE FROM asset WHERE id = ?").run(asset.id);
}

/**
 * Normalise an `--asset` list for a read: uppercase, dedup, and reject unknown
 * symbols naming them all, so a retry on a subset can never be silently empty.
 */
export function requireSymbols(
  db: DatabaseSync,
  symbols: string[] | undefined,
): string[] | undefined {
  if (symbols === undefined) return undefined;
  const wanted = [...new Set(symbols.map((s) => s.toUpperCase()))];
  const known = new Set(listAssets(db, {}).map((a) => a.symbol));
  const missing = wanted.filter((s) => !known.has(s));
  if (missing.length > 0) {
    throw new JanusError("VALIDATION", `not in the roster: ${missing.join(", ")}`);
  }
  return wanted;
}

/**
 * Coverage eligibility: active roster entries on live markets, plus anything
 * carrying an open trade so a held position cannot go dark.
 */
export function eligibleAssets(db: DatabaseSync): AssetRow[] {
  return db
    .prepare(
      `${SELECT}
       WHERE (a.active = 1 AND m.status = 'active')
          OR a.id IN (SELECT asset_id FROM trade WHERE status = 'open')
       ORDER BY a.symbol`,
    )
    .all() as AssetRow[];
}
