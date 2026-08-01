import { parseArgs } from "node:util";
import { openDb } from "../db/connect.ts";
import { upsertMarkets, listMarkets } from "../db/repo/market.ts";
import { createLighterClient } from "../lighter/client.ts";
import { nowIso } from "../domain/session.ts";
import { unknownVerb } from "./args.ts";

export async function handle(verb: string | undefined, argv: string[]): Promise<unknown> {
  const db = openDb();
  try {
    if (verb === "sync") {
      // See coverage.ts: JANUS_LIGHTER_URL lets tests (and any future replay
      // tooling) point this at a stub instead of the real Lighter API.
      const markets = await createLighterClient(process.env["JANUS_LIGHTER_URL"]).fetchMarkets();
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
    throw unknownVerb(verb, "market", "sync, list");
  } finally {
    db.close();
  }
}
