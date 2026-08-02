import { Command } from "commander";
import { addCluster, listClusters, requireClusterByKey, setClusterParam, getClusterParams, getGlobalParams, removeCluster, } from "../db/repo/cluster.js";
import { listAssets } from "../db/repo/asset.js";
import { recordClusterRead, listClusterReads, getMacro } from "../db/repo/phase.js";
import { resolveSession, readSessionDate, stampPhase } from "../db/repo/session.js";
import { resolveParams } from "../domain/params.js";
import { deriveClusterRead } from "../domain/read.js";
import { assertPhaseOrder, nowIso } from "../domain/session.js";
import { finite, metricPairs, readText, required, unknownVerb } from "./args.js";
import { JanusError } from "../output.js";
import { collect, handler, withDb } from "./command.js";
const VERBS = "add, list, show, set-param, rm, record, reads";
export function build(emit) {
    const cmd = new Command("cluster")
        .description("Clusters: the roster grouping, and the session's read of each one")
        // passThroughOptions on the positional-value verbs needs this on the parent.
        .enablePositionalOptions()
        .action(() => { throw unknownVerb(undefined, "cluster", VERBS); });
    cmd.command("add")
        .description("Create a cluster")
        .argument("[key]", "short key, e.g. majors")
        .option("--name <NAME>", "display name")
        .option("--notes <TEXT>", "free text; - reads stdin")
        .action(async (key, opts) => emit(await withDb((db) => addCluster(db, required(key, "key"), required(opts.name, "name"), readText(opts.notes) ?? null, nowIso()))));
    cmd.command("list")
        .description("List clusters — the roster, not the session's reads")
        .action(async () => emit(await withDb((db) => {
        const clusters = listClusters(db);
        return { count: clusters.length, clusters };
    })));
    cmd.command("show")
        .description("One cluster with its parameters and members")
        .argument("[key]", "cluster key")
        .action(async (key) => emit(await show(key)));
    cmd.command("set-param")
        .description("Write a parameter that applies to this cluster's assets only")
        .argument("[key]", "cluster key")
        .argument("[param]", "parameter name, e.g. w_catalyst")
        .argument("[value]", "any finite number; weights may be negative")
        // Positional so a negative value needs no escaping; passThroughOptions is
        // what stops commander reading `-2` as an option.
        .passThroughOptions()
        .action(async (key, param, value) => emit(await setParam(key, param, value)));
    cmd.command("rm")
        .description("Remove a cluster; its assets survive, unfiled")
        .argument("[key]", "cluster key")
        .action(async (key) => emit(await withDb((db) => {
        removeCluster(db, required(key, "key"));
        return { removed: key };
    })));
    cmd.command("record")
        .description("Record this session's read of one cluster (phase 2)")
        .argument("[cluster]", "cluster key")
        .option("--metric <KEY=VALUE>", "what the read observed; repeatable", collect)
        .option("--date <YYYY-MM-DD>", "address an existing session")
        .option("--force", "run out of phase order")
        .action(async (key, opts) => emit(await record(key, opts)));
    cmd.command("reads")
        .description("This session's cluster reads")
        .option("--date <YYYY-MM-DD>", "defaults to today, New York")
        .action(async (opts) => emit(await reads(opts.date)));
    return cmd;
}
function show(key) {
    return withDb((db) => {
        const cluster = requireClusterByKey(db, required(key, "key"));
        return {
            cluster,
            params: getClusterParams(db, cluster.id),
            resolved: resolveParams(getClusterParams(db, cluster.id), getGlobalParams(db)),
            assets: listAssets(db, { clusterKey: cluster.key }).map((a) => a.symbol),
        };
    });
}
function setParam(key, param, value) {
    return withDb((db) => {
        const cluster = requireClusterByKey(db, required(key, "key"));
        setClusterParam(db, cluster.id, required(param, "param"), finite(value, "value"));
        return { cluster: cluster.key, params: getClusterParams(db, cluster.id) };
    });
}
function record(key, opts) {
    return withDb((db) => {
        const now = nowIso();
        const session = resolveSession(db, opts.date, now);
        assertPhaseOrder(session, "cluster", opts.force === true);
        const cluster = requireClusterByKey(db, required(key, "cluster"));
        // Whatever was recorded goes through as-is; deriveClusterRead decides
        // which metrics it cannot do without and refuses the rest.
        const metrics = metricPairs(opts.metric, "metric");
        const params = resolveParams(getClusterParams(db, cluster.id), getGlobalParams(db));
        recordClusterRead(db, session.session_date, cluster.id, {
            metrics,
            results: deriveClusterRead(metrics, { metrics: {}, results: {} }, params),
        }, now);
        const reads = listClusterReads(db, session.session_date);
        // The phase is complete only once every cluster has been read. This is a
        // point-in-time check: the stamp is not invalidated by clusters added
        // later in the session, so a cluster added after the stamp leaves the
        // phase reported complete until someone records a read again. Accepted.
        if (reads.length >= listClusters(db).length) {
            stampPhase(db, session.session_date, "cluster", now);
        }
        return {
            session_date: session.session_date,
            recorded: cluster.key,
            read: reads.length,
            of: listClusters(db).length,
        };
    });
}
function reads(date) {
    return withDb((db) => {
        const on = readSessionDate(db, date, nowIso());
        const rows = listClusterReads(db, on);
        return { session_date: on, count: rows.length, reads: rows };
    });
}
export const handle = handler(build);
