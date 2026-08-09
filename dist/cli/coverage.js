import { Command } from "commander";
import { ensureSession, resolveSession, readSessionDate, stampPhase } from "../db/repo/session.js";
import { eligibleAssets, requireAssetBySymbol, requireSymbols } from "../db/repo/asset.js";
import { upsertCoverage, listCoverage } from "../db/repo/coverage.js";
import { backfillInputs, computeCoverage, deriveFundingPair } from "../domain/coverage.js";
import { createLighterClient } from "../lighter/client.js";
import { assertPhaseOrder, nowIso, todayNY } from "../domain/session.js";
import { csv, finite, required, unknownVerb } from "./args.js";
import { handler, withDb } from "./command.js";
import { JanusError } from "../output.js";
/** Narrow the eligible set to an explicit symbol list, rejecting the whole call on any miss. */
function select(eligible, symbols) {
    if (symbols === undefined)
        return eligible;
    // Dedup: --asset BTC,BTC would otherwise fetch twice and report covered: 2
    // while the upsert collapses both into a single row.
    const wanted = [...new Set(symbols.map((s) => s.toUpperCase()))];
    const bySymbol = new Map(eligible.map((a) => [a.symbol, a]));
    const missing = wanted.filter((s) => !bySymbol.has(s));
    if (missing.length > 0) {
        throw new JanusError("VALIDATION", `not eligible for coverage: ${missing.join(", ")} (unknown, deactivated, or delisted)`);
    }
    return wanted.map((s) => bySymbol.get(s));
}
export function build(emit) {
    const cmd = new Command("coverage")
        .description("Market data for the session (phase 3) — the only phase that uses the network")
        .action(() => { throw unknownVerb(undefined, "coverage", "run, set, list"); });
    cmd.command("run")
        .description("Fetch candles and a snapshot for every eligible asset")
        .option("--asset <SYM[,SYM...]>", "restrict to these symbols; never completes the phase")
        .option("--date <YYYY-MM-DD>", "address an existing session")
        .option("--force", "run out of phase order")
        .action(async (opts) => emit(await run(opts)));
    cmd.command("set")
        .description("Write a coverage row by hand — for testing scenarios, not the daily pipeline")
        .argument("[symbol]", "market symbol")
        .requiredOption("--date <YYYY-MM-DD>", "session to write")
        .requiredOption("--close <N>", "the day's close; also the mark unless --mark is given")
        .option("--mark <N>", "mark price; defaults to close")
        .option("--atr <N>", "atr14, which the stop ladder needs to trail")
        .option("--px-vs-sma20 <N>", "percent distance to the 20-day")
        .option("--px-vs-sma50 <N>", "percent distance to the 50-day")
        .option("--px-vs-sma200 <N>", "percent distance to the 200-day")
        .option("--complete", "stamp the coverage phase, as a full run would")
        .action(async (symbol, opts) => emit(await set(symbol, opts)));
    cmd.command("list")
        .description("The coverage recorded for a session")
        .option("--asset <SYM[,SYM...]>", "restrict to these symbols")
        .option("--date <YYYY-MM-DD>", "defaults to today, New York")
        .action(async (opts) => emit(await list(opts)));
    return cmd;
}
/**
 * Hand-written coverage, so a test scenario can drive a designed price path
 * without a network round trip or a raw INSERT against the schema.
 *
 * Deliberately not part of the pipeline: the daily job uses `run`. This exists
 * because the alternative — documenting a 26-column INSERT in TESTING.md — rots
 * the moment the table changes, and because real history cannot place a ladder
 * milestone on a chosen day.
 */
function set(symbol, opts) {
    return withDb((db) => {
        const sym = required(symbol, "symbol").toUpperCase();
        const asset = requireAssetBySymbol(db, sym);
        const now = nowIso();
        const date = opts.date;
        ensureSession(db, date, now);
        const close = finite(opts.close, "close");
        const mark = opts.mark === undefined ? close : finite(opts.mark, "mark");
        const optional = (v, name) => v === undefined ? null : finite(v, name);
        const values = {
            open: close, high: close, low: close, close, volume: 0,
            mark_price: mark, index_price: mark, open_interest: null, daily_change_pct: null,
            sma20: null, sma50: null, sma200: null, ema12: null, ema26: null,
            atr14: optional(opts.atr, "atr"),
            px_vs_sma20: optional(opts.pxVsSma20, "px-vs-sma20"),
            px_vs_sma50: optional(opts.pxVsSma50, "px-vs-sma50"),
            px_vs_sma200: optional(opts.pxVsSma200, "px-vs-sma200"),
            cross_50_200: null, cross_50_200_age: null, cross_px_50: null, cross_px_50_age: null,
            funding_rate: null, funding_ref: null,
            bars_available: 0, fetched_at: now,
        };
        upsertCoverage(db, date, [{ asset_id: asset.id, values }]);
        if (opts.complete === true)
            stampPhase(db, date, "coverage", now);
        return { session_date: date, symbol: sym, values, phase_complete: opts.complete === true };
    });
}
function run(opts) {
    return withDb(async (db) => {
        const symbols = csv(opts.asset);
        const now = nowIso();
        const session = resolveSession(db, opts.date, now);
        assertPhaseOrder(session, "coverage", opts.force === true);
        const eligible = eligibleAssets(db);
        const targets = select(eligible, symbols);
        // createLighterClient already takes a baseUrl; JANUS_LIGHTER_URL lets tests
        // (and any future replay tooling) point it at a stub instead of the real API.
        const client = createLighterClient(process.env["JANUS_LIGHTER_URL"]);
        // A past session date is a backfill: the live snapshot describes today, not
        // that day, so reconstruct both inputs from the bars instead of stamping
        // today's prices under an old date. Funding has no history to reconstruct,
        // so a backfill leaves it null.
        const backfill = session.session_date < todayNY();
        // One call covers every market. Funding is enrichment for the crowding
        // factor, not core coverage, so a failed fetch degrades to nulls rather
        // than failing the run.
        let fundingRows = [];
        if (!backfill) {
            try {
                fundingRows = await client.fetchFundingRates();
            }
            catch {
                fundingRows = [];
            }
        }
        const rows = [];
        const skipped = [];
        for (const asset of targets) {
            const [allBars, liveSnapshot] = await Promise.all([
                client.fetchDailyBars(asset.market_id),
                backfill ? Promise.resolve(null) : client.fetchSnapshot(asset.market_id),
            ]);
            try {
                const { bars, snapshot } = backfill
                    ? backfillInputs(allBars, session.session_date)
                    : { bars: allBars, snapshot: liveSnapshot };
                rows.push({
                    asset_id: asset.id,
                    values: computeCoverage(bars, snapshot, now, deriveFundingPair(fundingRows, asset.market_id)),
                });
            }
            catch (e) {
                if (e instanceof JanusError && e.code === "INSUFFICIENT_HISTORY") {
                    skipped.push({ symbol: asset.symbol, reason: e.message });
                    continue;
                }
                throw e;
            }
        }
        upsertCoverage(db, session.session_date, rows);
        // A full run (no --asset) completes the phase even when some assets were
        // skipped: a skipped asset has no data to record, and blocking on one
        // would deadlock the pipeline behind a permanently zero-bar market that
        // eligibleAssets keeps in scope because an open trade holds it there.
        // `skipped` in the payload is how the agent learns coverage is partial.
        const full = symbols === undefined;
        if (full)
            stampPhase(db, session.session_date, "coverage", now);
        return {
            session_date: session.session_date,
            covered: rows.length,
            eligible: eligible.length,
            skipped,
            phase_complete: full,
        };
    });
}
function list(opts) {
    return withDb((db) => {
        const date = readSessionDate(db, opts.date, nowIso());
        const rows = listCoverage(db, date, requireSymbols(db, csv(opts.asset)));
        return { session_date: date, count: rows.length, coverage: rows };
    });
}
export const handle = handler(build);
