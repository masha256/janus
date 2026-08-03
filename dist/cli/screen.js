import { Command } from "commander";
import { resolveSession, readSessionDate, stampPhase } from "../db/repo/session.js";
import { requireAssetBySymbol } from "../db/repo/asset.js";
import { getClusterParams, getGlobalParams } from "../db/repo/cluster.js";
import { getMacro, getClusterRead } from "../db/repo/phase.js";
import { recordScreen, listScreen, countCoverage, countScreened } from "../db/repo/screen.js";
import { resolveParams } from "../domain/params.js";
import { deriveScreen } from "../domain/screen.js";
import { assertPhaseOrder, nowIso } from "../domain/session.js";
import { metricPairs, readText, required, unknownVerb } from "./args.js";
import { collect, handler, withDb } from "./command.js";
import { JanusError } from "../output.js";
export function build(emit) {
    const cmd = new Command("screen")
        .description("The per-asset read that decides what reaches the scoring queue (phase 4)")
        .action(() => { throw unknownVerb(undefined, "screen", "record, list"); });
    cmd.command("record")
        .description("Screen one covered asset")
        .argument("[symbol]", "market symbol")
        .option("--metric <KEY=VALUE>", "what the read observed; repeatable", collect)
        .option("--rationale <TEXT>", "free text; - reads stdin")
        .option("--binary-date <YYYY-MM-DD>", "date of a known binary event; blocks entry until passed")
        .option("--binary-reason <TEXT>", "description of the binary event")
        .option("--date <YYYY-MM-DD>", "address an existing session")
        .option("--force", "run out of phase order")
        .action(async (symbol, opts) => emit(await record(symbol, opts)));
    cmd.command("list")
        .description("The screens recorded for a session")
        .option("--flagged", "only the assets that flagged")
        .option("--date <YYYY-MM-DD>", "defaults to today, New York")
        .action(async (opts) => emit(await list(opts)));
    return cmd;
}
function record(symbol, opts) {
    return withDb((db) => {
        const now = nowIso();
        const session = resolveSession(db, opts.date, now);
        assertPhaseOrder(session, "screen", opts.force === true);
        const asset = requireAssetBySymbol(db, required(symbol, "symbol").toUpperCase());
        const hasCoverage = db
            .prepare("SELECT 1 FROM coverage WHERE session_date = ? AND asset_id = ?")
            .get(session.session_date, asset.id);
        if (hasCoverage === undefined) {
            throw new JanusError("NO_COVERAGE", `${asset.symbol} has no coverage for ${session.session_date}`);
        }
        const params = resolveParams(getClusterParams(db, asset.cluster_id), getGlobalParams(db));
        // The screen needs both the current session's macro and (when present)
        // cluster reads to decide which regime view to consume.
        const macro = getMacro(db, session.session_date);
        const cluster = asset.cluster_id === null
            ? null
            : getClusterRead(db, session.session_date, asset.cluster_id);
        // Whatever was recorded goes through as-is; deriveScreen decides which
        // metrics it cannot do without, and what they mean for the flag.
        const metrics = metricPairs(opts.metric, "metric");
        const { flagged, results } = deriveScreen(metrics, macro, cluster, params);
        recordScreen(db, session.session_date, asset.id, {
            flagged,
            rationale: readText(opts.rationale) ?? null,
            binary_date: opts.binaryDate ?? null,
            binary_reason: opts.binaryReason ?? null,
            metrics,
            results,
        }, now);
        // The phase completes once every covered asset has been screened.
        const complete = countScreened(db, session.session_date) >= countCoverage(db, session.session_date);
        if (complete)
            stampPhase(db, session.session_date, "screen", now);
        return {
            session_date: session.session_date,
            symbol: asset.symbol,
            metrics, results, flagged,
            binary_date: opts.binaryDate ?? null,
            binary_reason: opts.binaryReason ?? null,
            screened: countScreened(db, session.session_date),
            of: countCoverage(db, session.session_date),
            phase_complete: complete,
        };
    });
}
function list(opts) {
    return withDb((db) => {
        const date = readSessionDate(db, opts.date, nowIso());
        const rows = listScreen(db, date, { flaggedOnly: opts.flagged });
        return { session_date: date, count: rows.length, screens: rows };
    });
}
export const handle = handler(build);
