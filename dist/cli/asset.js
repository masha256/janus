import { Command } from "commander";
import { ASSET_CLASSES, addAsset, listAssets, requireAssetBySymbol, updateAsset, setAssetActive, removeAsset, } from "../db/repo/asset.js";
import { getMarketBySymbol } from "../db/repo/market.js";
import { resolveParams } from "../domain/params.js";
import { getGlobalParams } from "../db/repo/cluster.js";
import { nowIso } from "../domain/session.js";
import { readText, required, oneOf, unknownVerb } from "./args.js";
import { handler, withDb } from "./command.js";
import { JanusError } from "../output.js";
const CLASSES = ASSET_CLASSES.join(" | ");
export function build(emit) {
    const cmd = new Command("asset")
        .description("The roster: which markets janus tracks")
        .action(() => {
        throw unknownVerb(undefined, "asset", "add, list, show, set, activate, deactivate, rm");
    });
    cmd.command("add")
        .description("Add a market to the roster (rejects markets without enough cached history)")
        .argument("[symbol]", "market symbol, e.g. BTC")
        .option("--class <CLASS>", CLASSES)
        .option("--cluster <KEY>", "cluster to file it under")
        .option("--notes <TEXT>", "free text; - reads stdin")
        .action(async (symbol, opts) => emit(await add(symbol, opts)));
    cmd.command("list")
        .description("List roster entries")
        .option("--active", "only active entries")
        .option("--inactive", "only deactivated entries")
        .option("--cluster <KEY>", "only this cluster")
        .option("--class <CLASS>", CLASSES)
        .action(async (opts) => emit(await list(opts)));
    cmd.command("show")
        .description("Show one roster entry")
        .argument("[symbol]", "market symbol")
        .action(async (symbol) => emit(await withDb((db) => requireAssetBySymbol(db, upper(symbol)))));
    cmd.command("set")
        .description("Change an entry's cluster, class, or notes")
        .argument("[symbol]", "market symbol")
        .option("--cluster <KEY>", "move it to this cluster")
        .option("--class <CLASS>", CLASSES)
        .option("--notes <TEXT>", "free text; - reads stdin")
        .action(async (symbol, opts) => emit(await set(symbol, opts)));
    cmd.command("activate")
        .description("Return an entry to the eligible set")
        .argument("[symbol]", "market symbol")
        .action(async (symbol) => emit(await active(symbol, true)));
    cmd.command("deactivate")
        .description("Drop an entry out of the eligible set without deleting it")
        .argument("[symbol]", "market symbol")
        .action(async (symbol) => emit(await active(symbol, false)));
    cmd.command("rm")
        .description("Remove an entry; refused once it has trades")
        .argument("[symbol]", "market symbol")
        .action(async (symbol) => emit(await remove(symbol)));
    return cmd;
}
const upper = (symbol) => required(symbol, "symbol").toUpperCase();
/**
 * Last-resort floor for the roster-entry history requirement when the
 * param chain (cluster_param → global_param → domain/params.ts defaults)
 * supplied nothing. Real default lives in DEFAULT_PARAMS; this only binds if
 * both were bypassed. 200 = the daily bars a 200-day MA needs, non-negotiable
 * for a weeks-to-months swing thesis.
 */
const MIN_HISTORY_BARS_FALLBACK = 200;
const DAY_MS = 86_400_000;
function add(symbol, opts) {
    return withDb(async (db) => {
        const sym = upper(symbol);
        const market = getMarketBySymbol(db, sym);
        if (market === undefined) {
            throw new JanusError("NOT_FOUND", `no Lighter market ${sym}; run "janus market sync" first`);
        }
        const params = resolveParams({}, getGlobalParams(db));
        const minBars = params["min_history_bars"] ?? MIN_HISTORY_BARS_FALLBACK;
        // No network: market sync already cached this market's listed_at, and a bar
        // a day is a lower bound on what coverage could ever pull. If that number is
        // short, coverage would never repair it — so refuse here and let the
        // operator re-run market sync once the market has actually matured.
        const listedAtMs = Date.parse(market.listed_at);
        const daysAvailable = Number.isNaN(listedAtMs)
            ? 0
            : Math.floor((Date.now() - listedAtMs) / DAY_MS) + 1;
        if (daysAvailable < minBars) {
            throw new JanusError("INSUFFICIENT_HISTORY", `${sym} listed ${market.listed_at} gives ≈${daysAvailable} daily bars (< ${minBars}); the 200-day structure is load-bearing, so it cannot be added — re-run market sync if this is stale`);
        }
        return addAsset(db, sym, oneOf(opts.class, "class", ASSET_CLASSES), opts.cluster ?? null, readText(opts.notes) ?? null, nowIso());
    });
}
function list(opts) {
    return withDb((db) => {
        const active = opts.active === true ? true : opts.inactive === true ? false : undefined;
        const assets = listAssets(db, { active, cls: opts.class, clusterKey: opts.cluster });
        return { count: assets.length, assets };
    });
}
function set(symbol, opts) {
    return withDb((db) => {
        if (opts.class !== undefined)
            oneOf(opts.class, "class", ASSET_CLASSES);
        return updateAsset(db, upper(symbol), {
            cls: opts.class,
            clusterKey: opts.cluster,
            notes: readText(opts.notes),
        });
    });
}
function active(symbol, on) {
    return withDb((db) => setAssetActive(db, upper(symbol), on));
}
function remove(symbol) {
    return withDb((db) => {
        removeAsset(db, upper(symbol));
        return { removed: symbol };
    });
}
export const handle = handler(build);
