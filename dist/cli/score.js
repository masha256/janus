import { Command } from "commander";
import { resolveSession, readSessionDate, stampPhase } from "../db/repo/session.js";
import { requireAssetBySymbol } from "../db/repo/asset.js";
import { getClusterParams, getGlobalParams } from "../db/repo/cluster.js";
import { scoreQueue, positionOf, openPositions, recordScore, listScores, previousScore, getScore, recentScores, lastTradeExit, } from "../db/repo/score.js";
import { getMacro, getClusterRead } from "../db/repo/phase.js";
import { listCoverage, getCoverage } from "../db/repo/coverage.js";
import { listScreen, getScreen } from "../db/repo/screen.js";
import { resolveParams } from "../domain/params.js";
import { deriveScore } from "../domain/score.js";
import { formatPosition, planResults } from "../domain/directive.js";
import { assertPhaseOrder, nowIso } from "../domain/session.js";
import { bookHeat, openTradeForAsset } from "../db/repo/trade.js";
import { pairs, readText, required, unknownVerb } from "./args.js";
import { collect, handler, withDb } from "./command.js";
import { JanusError } from "../output.js";
import { scorePlanFromResults } from "../domain/directive.js";
export function build(emit) {
    const cmd = new Command("score")
        .description("The weighted decision for everything in the queue (phase 5)")
        .action(() => { throw unknownVerb(undefined, "score", "queue, record, show, list"); });
    cmd.command("queue")
        .description("What needs scoring: flagged this session, plus anything holding an open trade")
        .option("--date <YYYY-MM-DD>", "defaults to today, New York")
        .action(async (opts) => emit(await queue(opts.date)));
    cmd.command("record")
        .description("Score one queued asset")
        .argument("[symbol]", "market symbol")
        .option("--factor <KEY=VALUE>", "a scoring factor, -2 to 2; repeatable", collect)
        .option("--rationale <TEXT>", "free text; - reads stdin")
        .option("--date <YYYY-MM-DD>", "address an existing session")
        .option("--force", "run out of phase order")
        .action(async (symbol, opts) => emit(await record(symbol, opts)));
    cmd.command("show")
        .description("Reprint today's stored score and plan for one asset")
        .argument("[symbol]", "market symbol")
        .option("--date <YYYY-MM-DD>", "address an existing session")
        .action(async (symbol, opts) => emit(await show(symbol, opts.date)));
    cmd.command("list")
        .description("The scores recorded for a session, by absolute direction first")
        .option("--date <YYYY-MM-DD>", "defaults to today, New York")
        .action(async (opts) => emit(await list(opts.date)));
    return cmd;
}
function queue(date) {
    return withDb((db) => {
        const on = readSessionDate(db, date, nowIso());
        const entries = scoreQueue(db, on);
        const coverage = listCoverage(db, on);
        const screens = listScreen(db, on, {});
        const bySymbol = (rows) => new Map(rows.map((r) => [r.symbol, r]));
        const cov = bySymbol(coverage);
        const scr = bySymbol(screens);
        return {
            session_date: on,
            count: entries.length,
            queue: entries.map((q) => ({
                ...q,
                position: formatPosition(positionOf(db, q.asset_id)),
                coverage: cov.get(q.symbol) ?? null,
                screen: scr.get(q.symbol) ?? null,
            })),
        };
    });
}
function record(symbol, opts) {
    return withDb((db) => {
        const now = nowIso();
        const session = resolveSession(db, opts.date, now);
        assertPhaseOrder(session, "score", opts.force === true);
        const asset = requireAssetBySymbol(db, required(symbol, "symbol").toUpperCase());
        const entries = scoreQueue(db, session.session_date);
        const entry = entries.find((q) => q.asset_id === asset.id);
        if (entry === undefined) {
            throw new JanusError("NOT_FLAGGED", `${asset.symbol} is not in the scoring queue for ${session.session_date}`);
        }
        const factors = pairs(opts.factor, "factor");
        if (Object.keys(factors).length === 0) {
            throw new JanusError("VALIDATION", "at least one --factor key=value is required");
        }
        const params = resolveParams(getClusterParams(db, asset.cluster_id), getGlobalParams(db));
        // Everything the session already concluded, top down, plus the whole book.
        // The previous score is loaded so the persistence rule can resist flip-flopping.
        const previous = previousScore(db, asset.id, session.session_date);
        // The window must cover the deepest gate that reads it, not just persistence.
        const recentDays = Math.max(params["signal_persist_days"] ?? 2, params["decay_persist_days"] ?? 2);
        const recent = recentScores(db, asset.id, session.session_date, recentDays);
        const screen = getScreen(db, session.session_date, asset.id);
        const context = {
            macro: getMacro(db, session.session_date),
            cluster: asset.cluster_id === null
                ? null
                : getClusterRead(db, session.session_date, asset.cluster_id),
            screen,
            positions: openPositions(db),
            asset: {
                symbol: asset.symbol,
                class: asset.class,
                cluster_id: asset.cluster_id,
                coverage: getCoverage(db, session.session_date, asset.id),
            },
            session_date: session.session_date,
            recent_scores: recent,
            last_exit: lastTradeExit(db, asset.id, session.session_date),
            binary: screen === null ? null : { date: screen.binary_date, reason: screen.binary_reason },
            account_capital: params["account_capital"] ?? 0,
            current_heat: bookHeat(db),
            previous_score: previous,
            open_trade: openTradeForAsset(db, asset.id),
        };
        const { direction, conviction, directive, plan, results } = deriveScore(factors, context, params);
        const position = positionOf(db, asset.id);
        recordScore(db, session.session_date, asset.id, {
            direction, conviction, directive,
            queue_reason: entry.queue_reason,
            position_state: formatPosition(position),
            rationale: readText(opts.rationale) ?? null,
            // The factors as given; everything else the formula concluded alongside.
            metrics: factors,
            results: { ...results, ...planResults(plan), plan_directive: plan.directive },
            plan,
        }, now);
        const scored = listScores(db, session.session_date).length;
        const complete = scored >= entries.length;
        if (complete)
            stampPhase(db, session.session_date, "score", now);
        return {
            session_date: session.session_date,
            symbol: asset.symbol,
            direction, conviction, directive,
            position: formatPosition(position),
            queue_reason: entry.queue_reason,
            metrics: factors,
            results,
            plan,
            scored, of: entries.length,
            phase_complete: complete,
        };
    });
}
function show(symbol, date) {
    return withDb((db) => {
        const on = readSessionDate(db, date, nowIso());
        const asset = requireAssetBySymbol(db, required(symbol, "symbol").toUpperCase());
        const entry = scoreQueue(db, on).find((q) => q.asset_id === asset.id);
        if (entry === undefined) {
            throw new JanusError("NOT_FLAGGED", `${asset.symbol} is not in the scoring queue for ${on}`);
        }
        const row = getScore(db, on, asset.id);
        if (row === undefined) {
            throw new JanusError("NOT_FOUND", `${asset.symbol} has not been scored for ${on}; run score record first`);
        }
        return {
            session_date: on,
            symbol: row.symbol,
            class: row.class,
            direction: row.direction,
            conviction: row.conviction,
            directive: row.directive,
            position: row.position_state,
            queue_reason: row.queue_reason,
            metrics: row.metrics,
            results: row.results,
            plan: row.plan,
        };
    });
}
function list(date) {
    return withDb((db) => {
        const on = readSessionDate(db, date, nowIso());
        const scores = listScores(db, on);
        return { session_date: on, count: scores.length, scores };
    });
}
export const handle = handler(build);
