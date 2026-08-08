import { Command } from "commander";
import { upsertMarkets, listMarkets, nextMarketId, getMarketBySymbol } from "../db/repo/market.js";
import { createLighterClient } from "../lighter/client.js";
import { nowIso } from "../domain/session.js";
import { num, required, unknownVerb } from "./args.js";
import { handler, withDb } from "./command.js";
export function build(emit) {
    const cmd = new Command("market")
        .description("The Lighter market catalog")
        .action(() => { throw unknownVerb(undefined, "market", "sync, set, list"); });
    cmd.command("sync")
        .description("Refresh the catalog from Lighter (read-only network call)")
        .action(async () => emit(await sync()));
    cmd.command("set")
        .description("Write a catalog row by hand — for testing scenarios, not the daily pipeline")
        .argument("[symbol]", "market symbol")
        .option("--market-id <N>", "defaults to one past the highest known id")
        .option("--type <TYPE>", "market type", "perp")
        .option("--status <STATUS>", "market status", "active")
        .option("--price-decimals <N>", "price precision", "2")
        .option("--size-decimals <N>", "size precision", "4")
        .option("--listed-at <DATE>", "listing date; old enough for 200 daily bars", "2020-01-01")
        .action(async (symbol, opts) => emit(await set(symbol, opts)));
    cmd.command("list")
        .description("List known markets")
        .option("--search <TEXT>", "match part of a symbol")
        .option("--status <STATUS>", "filter by market status, e.g. active")
        .action(async (opts) => emit(await list(opts)));
    return cmd;
}
function sync() {
    return withDb(async (db) => {
        // See coverage.ts: JANUS_LIGHTER_URL lets tests (and any future replay
        // tooling) point this at a stub instead of the real Lighter API.
        const markets = await createLighterClient(process.env["JANUS_LIGHTER_URL"]).fetchMarkets();
        const synced_at = nowIso();
        return { synced: upsertMarkets(db, markets, synced_at), synced_at };
    });
}
/**
 * Hand-written catalog row, so a test scenario can seed a synthetic market
 * without a network round trip or a raw INSERT against the schema. Same reason
 * as `coverage set`: a documented INSERT rots the moment the table changes.
 */
function set(symbol, opts) {
    return withDb((db) => {
        const sym = required(symbol, "symbol").toUpperCase();
        const synced_at = nowIso();
        const market = {
            // Re-running on the same symbol updates that row: symbol is UNIQUE, so
            // handing it a fresh id would trip a raw constraint error instead.
            market_id: opts.marketId === undefined
                ? getMarketBySymbol(db, sym)?.market_id ?? nextMarketId(db)
                : num(opts.marketId, "market-id", 0, Number.MAX_SAFE_INTEGER),
            symbol: sym,
            market_type: opts.type,
            status: opts.status,
            price_decimals: num(opts.priceDecimals, "price-decimals", 0, 18),
            size_decimals: num(opts.sizeDecimals, "size-decimals", 0, 18),
            listed_at: opts.listedAt,
        };
        upsertMarkets(db, [market], synced_at);
        return { ...market, synced_at };
    });
}
function list(opts) {
    return withDb((db) => {
        const markets = listMarkets(db, { search: opts.search, status: opts.status });
        return { count: markets.length, markets };
    });
}
export const handle = handler(build);
