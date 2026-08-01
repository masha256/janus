import { Command } from "commander";
import { upsertMarkets, listMarkets } from "../db/repo/market.js";
import { createLighterClient } from "../lighter/client.js";
import { nowIso } from "../domain/session.js";
import { unknownVerb } from "./args.js";
import { handler, withDb } from "./command.js";
export function build(emit) {
    const cmd = new Command("market")
        .description("The Lighter market catalog")
        .action(() => { throw unknownVerb(undefined, "market", "sync, list"); });
    cmd.command("sync")
        .description("Refresh the catalog from Lighter (read-only network call)")
        .action(async () => emit(await sync()));
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
function list(opts) {
    return withDb((db) => {
        const markets = listMarkets(db, { search: opts.search, status: opts.status });
        return { count: markets.length, markets };
    });
}
export const handle = handler(build);
