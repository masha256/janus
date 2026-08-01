import { Command } from "commander";
import { resolveSession, readSessionDate, stampPhase } from "../db/repo/session.js";
import { recordMacro, getMacro } from "../db/repo/phase.js";
import { listClusters, getGlobalParams } from "../db/repo/cluster.js";
import { resolveParams } from "../domain/params.js";
import { deriveMacroRead } from "../domain/read.js";
import { assertPhaseOrder, nowIso } from "../domain/session.js";
import { metricPairs, readText, required, unknownVerb } from "./args.js";
import { collect, handler, withDb } from "./command.js";
export function build(emit) {
    const cmd = new Command("macro")
        .description("The session's macro read (phase 1)")
        .action(() => { throw unknownVerb(undefined, "macro", "record, reads"); });
    cmd.command("record")
        .description("Record the macro read; completes phase 1")
        .option("--summary <TEXT>", "one line on the tape; - reads stdin")
        .option("--metric <KEY=VALUE>", "what the read observed; repeatable", collect)
        .option("--date <YYYY-MM-DD>", "address an existing session")
        .option("--force", "run out of phase order")
        .action(async (opts) => emit(await record(opts)));
    cmd.command("reads")
        .description("The macro read for a session, with its metrics and results")
        .option("--date <YYYY-MM-DD>", "defaults to today, New York")
        .action(async (opts) => emit(await reads(opts.date)));
    return cmd;
}
function record(opts) {
    return withDb((db) => {
        const now = nowIso();
        const session = resolveSession(db, opts.date, now);
        assertPhaseOrder(session, "macro", opts.force === true);
        // Whatever was recorded goes through as-is; deriveMacroRead decides which
        // metrics it cannot do without and refuses the rest.
        const metrics = metricPairs(opts.metric, "metric");
        // The macro read is session-wide, so it resolves against the global rung only.
        const params = resolveParams({}, getGlobalParams(db));
        recordMacro(db, session.session_date, {
            summary: required(readText(opts.summary), "summary"),
            metrics,
            results: deriveMacroRead(metrics, params),
        }, now);
        stampPhase(db, session.session_date, "macro", now);
        const stamped = ["macro"];
        // A phase with nothing to read is vacuously complete. Without this, a
        // session with no clusters could never stamp cluster_at, because
        // cluster record requires a cluster key that does not exist.
        if (listClusters(db).length === 0) {
            stampPhase(db, session.session_date, "cluster", now);
            stamped.push("cluster");
        }
        return { session_date: session.session_date, stamped, ...getMacro(db, session.session_date) };
    });
}
function reads(date) {
    return withDb((db) => {
        const on = readSessionDate(db, date, nowIso());
        return { session_date: on, ...getMacro(db, on) };
    });
}
export const handle = handler(build);
