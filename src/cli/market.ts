import { Command } from "commander";
import { upsertMarkets, listMarkets } from "../db/repo/market.ts";
import { createLighterClient } from "../lighter/client.ts";
import { nowIso } from "../domain/session.ts";
import { unknownVerb } from "./args.ts";
import { type Emit, handler, withDb } from "./command.ts";

type ListOpts = { search?: string; status?: string };

export function build(emit: Emit): Command {
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
    .action(async (opts: ListOpts) => emit(await list(opts)));

  return cmd;
}

function sync(): Promise<unknown> {
  return withDb(async (db) => {
    // See coverage.ts: JANUS_LIGHTER_URL lets tests (and any future replay
    // tooling) point this at a stub instead of the real Lighter API.
    const markets = await createLighterClient(process.env["JANUS_LIGHTER_URL"]).fetchMarkets();
    const synced_at = nowIso();
    return { synced: upsertMarkets(db, markets, synced_at), synced_at };
  });
}

function list(opts: ListOpts): Promise<unknown> {
  return withDb((db) => {
    const markets = listMarkets(db, { search: opts.search, status: opts.status });
    return { count: markets.length, markets };
  });
}

export const handle = handler(build);
