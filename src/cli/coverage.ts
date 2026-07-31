import { parseArgs } from "node:util";
import { openDb } from "../db/connect.ts";
import { resolveSession, stampPhase } from "../db/repo/session.ts";
import { eligibleAssets } from "../db/repo/asset.ts";
import { upsertCoverage, listCoverage } from "../db/repo/coverage.ts";
import { computeCoverage } from "../domain/coverage.ts";
import { createLighterClient } from "../lighter/client.ts";
import { assertPhaseOrder, nowIso } from "../domain/session.ts";
import { csv } from "./args.ts";
import { JanusError } from "../output.ts";
import type { AssetRow } from "../db/repo/asset.ts";

/** Narrow the eligible set to an explicit symbol list, rejecting the whole call on any miss. */
function select(eligible: AssetRow[], symbols: string[] | undefined): AssetRow[] {
  if (symbols === undefined) return eligible;
  const wanted = symbols.map((s) => s.toUpperCase());
  const bySymbol = new Map(eligible.map((a) => [a.symbol, a]));
  const missing = wanted.filter((s) => !bySymbol.has(s));
  if (missing.length > 0) {
    throw new JanusError(
      "VALIDATION",
      `not eligible for coverage: ${missing.join(", ")} (unknown, deactivated, or delisted)`,
    );
  }
  return wanted.map((s) => bySymbol.get(s)!);
}

export async function handle(verb: string | undefined, argv: string[]): Promise<unknown> {
  const db = openDb();
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        asset: { type: "string" }, date: { type: "string" }, force: { type: "boolean" },
      },
    });
    const symbols = csv(values.asset);

    if (verb === "run") {
      const now = nowIso();
      const session = resolveSession(db, values.date, now);
      assertPhaseOrder(session, "coverage", values.force === true);

      const eligible = eligibleAssets(db);
      const targets = select(eligible, symbols);
      const client = createLighterClient();

      const rows: { asset_id: number; values: ReturnType<typeof computeCoverage> }[] = [];
      const skipped: { symbol: string; reason: string }[] = [];
      for (const asset of targets) {
        const [bars, snapshot] = await Promise.all([
          client.fetchDailyBars(asset.market_id),
          client.fetchSnapshot(asset.market_id),
        ]);
        try {
          rows.push({ asset_id: asset.id, values: computeCoverage(bars, snapshot, now) });
        } catch (e) {
          if (e instanceof JanusError && e.code === "INSUFFICIENT_HISTORY") {
            skipped.push({ symbol: asset.symbol, reason: e.message });
            continue;
          }
          throw e;
        }
      }

      upsertCoverage(db, session.session_date, rows);

      // Only a full run that covered every eligible asset completes the phase.
      const full = symbols === undefined && skipped.length === 0;
      if (full) stampPhase(db, session.session_date, "coverage", now);

      return {
        session_date: session.session_date,
        covered: rows.length,
        eligible: eligible.length,
        skipped,
        phase_complete: full,
      };
    }

    if (verb === "list") {
      const session = resolveSession(db, values.date, nowIso());
      const rows = listCoverage(db, session.session_date, symbols);
      return { session_date: session.session_date, count: rows.length, coverage: rows };
    }

    throw new JanusError("VALIDATION", `unknown verb "${verb}" for coverage; try: run, list`);
  } finally {
    db.close();
  }
}
