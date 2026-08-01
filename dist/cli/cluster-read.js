import { parseArgs } from "node:util";
import { openDb } from "../db/connect.js";
import { resolveSession, readSessionDate, stampPhase } from "../db/repo/session.js";
import { recordClusterRead, listClusterReads } from "../db/repo/phase.js";
import { requireClusterByKey, listClusters } from "../db/repo/cluster.js";
import { assertPhaseOrder, nowIso } from "../domain/session.js";
import { metricNum, metricPairs, metricText, required, unknownVerb } from "./args.js";
export async function handle(verb, argv) {
    const db = openDb();
    try {
        const [key, ...rest] = argv;
        const { values } = parseArgs({
            args: verb === "list" ? argv : rest,
            options: {
                metric: { type: "string", multiple: true },
                date: { type: "string" }, force: { type: "boolean" },
            },
        });
        if (verb === "record") {
            const now = nowIso();
            const session = resolveSession(db, values.date, now);
            assertPhaseOrder(session, "cluster_read", values.force === true);
            const cluster = requireClusterByKey(db, required(key, "cluster"));
            // bias and judgement are metrics like any other, but both are mandatory:
            // a cluster read with no number and no words is not a read.
            const metrics = metricPairs(values.metric, "metric");
            metricNum(metrics, "bias", -2, 2);
            metricText(metrics, "judgement");
            recordClusterRead(db, session.session_date, cluster.id, metrics, now);
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
        if (verb === "list") {
            const date = readSessionDate(db, values.date, nowIso());
            const reads = listClusterReads(db, date);
            return { session_date: date, count: reads.length, reads };
        }
        throw unknownVerb(verb, "cluster-read", "record, list");
    }
    finally {
        db.close();
    }
}
