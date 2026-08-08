import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db/connect.ts";
import { migrate } from "../db/migrate.ts";
import { listMarkets } from "../db/repo/market.ts";
import { handle } from "./market.ts";

// market set opens its own db via JANUS_DB, so a real temp file is needed to
// observe what it wrote.
function freshDbFile(): string {
  const file = join(mkdtempSync(join(tmpdir(), "janus-market-test-")), "janus.db");
  const db = openDb(file);
  migrate(db);
  db.close();
  return file;
}

const run = (verb: string, args: string[]): Promise<unknown> => handle(verb, args);

test("market set seeds a catalog row and re-runs update it in place", async () => {
  process.env["JANUS_DB"] = freshDbFile();

  await run("set", ["sim"]);
  await run("set", ["OTHER"]);
  await run("set", ["SIM", "--price-decimals", "5", "--status", "delisted"]);

  const db = openDb(process.env["JANUS_DB"]!);
  const markets = listMarkets(db, {});
  db.close();

  assert.deepEqual(markets.map((m) => [m.symbol, m.market_id]), [["OTHER", 2], ["SIM", 1]]);
  const sim = markets[1]!;
  assert.equal(sim.price_decimals, 5);
  assert.equal(sim.status, "delisted");
  assert.equal(sim.market_type, "perp");
  assert.equal(sim.listed_at, "2020-01-01");
});
