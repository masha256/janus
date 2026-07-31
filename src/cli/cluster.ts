import { parseArgs } from "node:util";
import { openDb } from "../db/connect.ts";
import {
  addCluster, listClusters, requireClusterByKey, setClusterParam,
  getClusterParams, getGlobalParams, removeCluster,
} from "../db/repo/cluster.ts";
import { listAssets } from "../db/repo/asset.ts";
import { resolveParams } from "../domain/params.ts";
import { nowIso } from "../domain/session.ts";
import { readText, required } from "./args.ts";
import { JanusError } from "../output.ts";

export async function handle(verb: string | undefined, argv: string[]): Promise<unknown> {
  const db = openDb();
  try {
    if (verb === "add") {
      const [key, ...rest] = argv;
      const { values } = parseArgs({
        args: rest,
        options: { name: { type: "string" }, notes: { type: "string" } },
      });
      return addCluster(
        db,
        required(key, "key"),
        required(values.name, "name"),
        readText(values.notes) ?? null,
        nowIso(),
      );
    }
    if (verb === "list") {
      const clusters = listClusters(db);
      return { count: clusters.length, clusters };
    }
    if (verb === "show") {
      const cluster = requireClusterByKey(db, required(argv[0], "key"));
      return {
        cluster,
        params: getClusterParams(db, cluster.id),
        resolved: resolveParams(getClusterParams(db, cluster.id), getGlobalParams(db)),
        assets: listAssets(db, { clusterKey: cluster.key }).map((a) => a.symbol),
      };
    }
    if (verb === "set-param") {
      const [key, param, raw] = argv;
      const cluster = requireClusterByKey(db, required(key, "key"));
      const value = Number(required(raw, "value"));
      if (!Number.isFinite(value)) throw new JanusError("VALIDATION", `value must be a number, got ${raw}`);
      setClusterParam(db, cluster.id, required(param, "param"), value);
      return { cluster: cluster.key, params: getClusterParams(db, cluster.id) };
    }
    if (verb === "rm") {
      removeCluster(db, required(argv[0], "key"));
      return { removed: argv[0] };
    }
    throw new JanusError("VALIDATION", `unknown verb "${verb}" for cluster; try: add, list, show, set-param, rm`);
  } finally {
    db.close();
  }
}
