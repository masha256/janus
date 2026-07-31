import { parseArgs } from "node:util";
import { openDb } from "../db/connect.ts";
import { upsertMarkets, listMarkets } from "../db/repo/market.ts";
import { createLighterClient } from "../lighter/client.ts";
import { nowIso } from "../domain/session.ts";
import { JanusError } from "../output.ts";

export async function handle(verb: string | undefined, argv: string[]): Promise<unknown> {
  const db = openDb();
  try {
    if (verb === "sync") {
      const markets = await createLighterClient().fetchMarkets();
      const synced_at = nowIso();
      return { synced: upsertMarkets(db, markets, synced_at), synced_at };
    }
    if (verb === "list") {
      const { values } = parseArgs({
        args: argv,
        options: { search: { type: "string" }, status: { type: "string" } },
      });
      const markets = listMarkets(db, { search: values.search, status: values.status });
      return { count: markets.length, markets };
    }
    throw new JanusError("VALIDATION", `unknown verb "${verb}" for market; try: sync, list`);
  } finally {
    db.close();
  }
}
