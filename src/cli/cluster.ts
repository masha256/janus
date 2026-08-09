import { Command } from "commander";
import {
  addCluster, listClusters, requireClusterByKey, setClusterParam,
  getClusterParams, getGlobalParams, removeCluster, setClusterDescription,
} from "../db/repo/cluster.ts";
import { listAssets } from "../db/repo/asset.ts";
import { recordClusterRead, listClusterReads, getMacro } from "../db/repo/phase.ts";
import { resolveSession, readSessionDate, stampPhase } from "../db/repo/session.ts";
import { GLOBAL_ONLY_PARAMS, resolveParams } from "../domain/params.ts";
import { deriveClusterRead } from "../domain/read.ts";
import { assertPhaseOrder, nowIso } from "../domain/session.ts";
import { finite, metricPairs, readText, required, unknownVerb } from "./args.ts";
import { JanusError } from "../output.ts";
import { collect, type Emit, handler, withDb } from "./command.ts";

const VERBS = "add, list, show, set-description, set-param, rm, record, reads";

type RecordOpts = { summary?: string; metric: string[]; date?: string; force?: boolean };

export function build(emit: Emit): Command {
  const cmd = new Command("cluster")
    .description("Clusters: the roster grouping, and the session's read of each one")
    // passThroughOptions on the positional-value verbs needs this on the parent.
    .enablePositionalOptions()
    .action(() => { throw unknownVerb(undefined, "cluster", VERBS); });

  cmd.command("add")
    .description("Create a cluster")
    .argument("[key]", "short key, e.g. majors")
    .option("--name <NAME>", "display name")
    .option("--description <TEXT>", "one-line description; - reads stdin")
    .option("--notes <TEXT>", "free text; - reads stdin")
    .action(async (key: string | undefined, opts: { name?: string; description?: string; notes?: string }) =>
      emit(await withDb((db) => addCluster(
        db, required(key, "key"), required(opts.name, "name"), readText(opts.description) ?? null, readText(opts.notes) ?? null, nowIso(),
      ))));

  cmd.command("set-description")
    .description("Update a cluster's description")
    .argument("[key]", "cluster key")
    .option("--description <TEXT>", "one-line description; - reads stdin", collect)
    .action(async (key: string | undefined, opts: { description?: string }) => emit(await setDescription(key, opts.description)));

  cmd.command("list")
    .description("List clusters — the roster, not the session's reads")
    .action(async () => emit(await withDb((db) => {
      const clusters = listClusters(db);
      return { count: clusters.length, clusters };
    })));

  cmd.command("show")
    .description("One cluster with its parameters and members")
    .argument("[key]", "cluster key")
    .action(async (key: string | undefined) => emit(await show(key)));

  cmd.command("set-param")
    .description("Write a parameter that applies to this cluster's assets only")
    .argument("[key]", "cluster key")
    .argument("[param]", "parameter name, e.g. w_catalyst")
    .argument("[value]", "any finite number; weights may be negative")
    // Positional so a negative value needs no escaping; passThroughOptions is
    // what stops commander reading `-2` as an option.
    .passThroughOptions()
    .action(async (key?: string, param?: string, value?: string) => emit(await setParam(key, param, value)));

  cmd.command("rm")
    .description("Remove a cluster; its assets survive, unfiled")
    .argument("[key]", "cluster key")
    .action(async (key: string | undefined) => emit(await withDb((db) => {
      removeCluster(db, required(key, "key"));
      return { removed: key };
    })));

  cmd.command("record")
    .description("Record this session's read of one cluster (phase 2)")
    .argument("[cluster]", "cluster key")
    .option("--summary <TEXT>", "one line on the tape; - reads stdin")
    .option("--metric <KEY=VALUE>", "what the read observed; repeatable", collect)
    .option("--date <YYYY-MM-DD>", "address an existing session")
    .option("--force", "run out of phase order")
    .action(async (key: string | undefined, opts: RecordOpts) => emit(await record(key, opts)));

  cmd.command("reads")
    .description("This session's cluster reads")
    .option("--date <YYYY-MM-DD>", "defaults to today, New York")
    .action(async (opts: { date?: string }) => emit(await reads(opts.date)));

  return cmd;
}

function show(key: string | undefined): Promise<unknown> {
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

function setParam(
  key: string | undefined,
  param: string | undefined,
  value: string | undefined,
): Promise<unknown> {
  return withDb((db) => {
    const cluster = requireClusterByKey(db, required(key, "key"));
    const name = required(param, "param");
    if (GLOBAL_ONLY_PARAMS.has(name)) {
      throw new JanusError(
        "VALIDATION",
        `${name} is account-scope and cannot be set per cluster; use \`janus param set\``,
      );
    }
    setClusterParam(db, cluster.id, name, finite(value, "value"));
    return { cluster: cluster.key, params: getClusterParams(db, cluster.id) };
  });
}

function setDescription(key: string | undefined, description: string | undefined): Promise<unknown> {
  return withDb((db) => {
    const text = readText(description);
    const cluster = setClusterDescription(db, required(key, "key"), text);
    return {
      cluster: cluster.key,
      description: cluster.description,
      updated: nowIso(),
    };
  });
}

function record(key: string | undefined, opts: RecordOpts): Promise<unknown> {
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
      summary: readText(opts.summary) ?? undefined,
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

function reads(date?: string): Promise<unknown> {
  return withDb((db) => {
    const on = readSessionDate(db, date, nowIso());
    const rows = listClusterReads(db, on);
    return { session_date: on, count: rows.length, reads: rows };
  });
}

export const handle = handler(build);
