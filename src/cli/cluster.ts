import { parseArgs } from "node:util";
import { openDb } from "../db/connect.ts";
import {
  addCluster, listClusters, requireClusterByKey, setClusterParam,
  getClusterParams, getGlobalParams, removeCluster,
} from "../db/repo/cluster.ts";
import { listAssets } from "../db/repo/asset.ts";
import { recordClusterRead, listClusterReads, getMacro } from "../db/repo/phase.ts";
import { resolveSession, readSessionDate, stampPhase } from "../db/repo/session.ts";
import { resolveParams } from "../domain/params.ts";
import { deriveClusterRead } from "../domain/read.ts";
import { assertPhaseOrder, nowIso } from "../domain/session.ts";
import { finite, metricPairs, readText, required, unknownVerb } from "./args.ts";

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
      setClusterParam(db, cluster.id, required(param, "param"), finite(raw, "value"));
      return { cluster: cluster.key, params: getClusterParams(db, cluster.id) };
    }
    if (verb === "rm") {
      removeCluster(db, required(argv[0], "key"));
      return { removed: argv[0] };
    }

    // The cluster_read phase. `list` is taken by the roster above, so the
    // session's reads are `reads`.
    if (verb === "record" || verb === "reads") {
      const [key, ...rest] = argv;
      const { values } = parseArgs({
        args: verb === "reads" ? argv : rest,
        options: {
          metric: { type: "string", multiple: true },
          date: { type: "string" }, force: { type: "boolean" },
        },
      });

      if (verb === "reads") {
        const date = readSessionDate(db, values.date, nowIso());
        const reads = listClusterReads(db, date);
        return { session_date: date, count: reads.length, reads };
      }

      const now = nowIso();
      const session = resolveSession(db, values.date, now);
      assertPhaseOrder(session, "cluster_read", values.force === true);
      const cluster = requireClusterByKey(db, required(key, "cluster"));
      // bias and judgement are metrics like any other, but both are mandatory:
      // a cluster read with no number and no words is not a read.
      // Whatever was recorded goes through as-is; deriveClusterRead decides
      // which metrics it cannot do without and refuses the rest.
      const metrics = metricPairs(values.metric, "metric");
      // The cluster's conclusion leans on the whole macro read. Phase order
      // guarantees one exists — except under --force, where an empty read is
      // passed along rather than blocking the record.
      const macro = getMacro(db, session.session_date);
      const params = resolveParams(getClusterParams(db, cluster.id), getGlobalParams(db));

      recordClusterRead(db, session.session_date, cluster.id, {
        metrics,
        results: deriveClusterRead(metrics, macro, params),
      }, now);
      const reads = listClusterReads(db, session.session_date);
      // The phase is complete only once every cluster has been read. This is a
      // point-in-time check: the stamp is not invalidated by clusters added
      // later in the session, so a cluster added after the stamp leaves the
      // phase reported complete until someone records a read again. Accepted.
      if (reads.length >= listClusters(db).length) {
        stampPhase(db, session.session_date, "cluster_read", now);
      }
      return {
        session_date: session.session_date,
        recorded: cluster.key,
        read: reads.length,
        of: listClusters(db).length,
      };
    }

    throw unknownVerb(verb, "cluster", "add, list, show, set-param, rm, record, reads");
  } finally {
    db.close();
  }
}
