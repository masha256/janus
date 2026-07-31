import { parseArgs } from "node:util";
import { openDb } from "../db/connect.ts";
import { resolveSession, stampPhase } from "../db/repo/session.ts";
import { recordClusterRead, listClusterReads } from "../db/repo/phase.ts";
import { requireClusterByKey, listClusters } from "../db/repo/cluster.ts";
import { assertPhaseOrder, nowIso } from "../domain/session.ts";
import { num, readText, required } from "./args.ts";
import { JanusError } from "../output.ts";

export async function handle(verb: string | undefined, argv: string[]): Promise<unknown> {
  const db = openDb();
  try {
    const [key, ...rest] = argv;
    const { values } = parseArgs({
      args: verb === "list" ? argv : rest,
      options: {
        bias: { type: "string" }, judgement: { type: "string" },
        date: { type: "string" }, force: { type: "boolean" },
      },
    });

    if (verb === "record") {
      const now = nowIso();
      const session = resolveSession(db, values.date, now);
      assertPhaseOrder(session, "cluster_read", values.force === true);
      const cluster = requireClusterByKey(db, required(key, "cluster"));
      recordClusterRead(
        db, session.session_date, cluster.id,
        num(values.bias, "bias", -2, 2),
        required(readText(values.judgement), "judgement"),
        now,
      );
      const reads = listClusterReads(db, session.session_date);
      // The phase is complete only once every cluster has been read.
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
    if (verb === "list") {
      const session = resolveSession(db, values.date, nowIso());
      const reads = listClusterReads(db, session.session_date);
      return { session_date: session.session_date, count: reads.length, reads };
    }
    throw new JanusError("VALIDATION", `unknown verb "${verb}" for cluster-read; try: record, list`);
  } finally {
    db.close();
  }
}
