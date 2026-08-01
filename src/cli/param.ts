import { openDb } from "../db/connect.ts";
import { setClusterParam, getGlobalParams } from "../db/repo/cluster.ts";
import { resolveParams } from "../domain/params.ts";
import { finite, required, unknownVerb } from "./args.ts";

/**
 * The middle rung of the cluster_param → global_param → default chain.
 * `cluster set-param` writes the top rung; this writes the one that applies to
 * every asset, including those with no cluster at all.
 */
export async function handle(verb: string | undefined, argv: string[]): Promise<unknown> {
  const db = openDb();
  try {
    if (verb === "set") {
      const [key, raw] = argv;
      setClusterParam(db, null, required(key, "key"), finite(raw, "value"));
      return { params: getGlobalParams(db) };
    }
    if (verb === "list") {
      const global = getGlobalParams(db);
      return { global, resolved: resolveParams({}, global) };
    }
    throw unknownVerb(verb, "param", "set, list");
  } finally {
    db.close();
  }
}
