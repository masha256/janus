import { Command } from "commander";
import { resolveSession, readSessionDate, stampPhase } from "../db/repo/session.ts";
import { eligibleAssets, requireSymbols } from "../db/repo/asset.ts";
import { upsertCoverage, listCoverage } from "../db/repo/coverage.ts";
import { computeCoverage } from "../domain/coverage.ts";
import { createLighterClient } from "../lighter/client.ts";
import { assertPhaseOrder, nowIso } from "../domain/session.ts";
import { csv, unknownVerb } from "./args.ts";
import { type Emit, handler, withDb } from "./command.ts";
import { JanusError } from "../output.ts";
import type { AssetRow } from "../db/repo/asset.ts";

type RunOpts = { asset?: string; date?: string; force?: boolean };

/** Narrow the eligible set to an explicit symbol list, rejecting the whole call on any miss. */
function select(eligible: AssetRow[], symbols: string[] | undefined): AssetRow[] {
  if (symbols === undefined) return eligible;
  // Dedup: --asset BTC,BTC would otherwise fetch twice and report covered: 2
  // while the upsert collapses both into a single row.
  const wanted = [...new Set(symbols.map((s) => s.toUpperCase()))];
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

export function build(emit: Emit): Command {
  const cmd = new Command("coverage")
    .description("Market data for the session (phase 3) — the only phase that uses the network")
    .action(() => { throw unknownVerb(undefined, "coverage", "run, list"); });

  cmd.command("run")
    .description("Fetch candles and a snapshot for every eligible asset")
    .option("--asset <SYM[,SYM...]>", "restrict to these symbols; never completes the phase")
    .option("--date <YYYY-MM-DD>", "address an existing session")
    .option("--force", "run out of phase order")
    .action(async (opts: RunOpts) => emit(await run(opts)));

  cmd.command("list")
    .description("The coverage recorded for a session")
    .option("--asset <SYM[,SYM...]>", "restrict to these symbols")
    .option("--date <YYYY-MM-DD>", "defaults to today, New York")
    .action(async (opts: { asset?: string; date?: string }) => emit(await list(opts)));

  return cmd;
}

function run(opts: RunOpts): Promise<unknown> {
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

    // A full run (no --asset) completes the phase even when some assets were
    // skipped: a skipped asset has no data to record, and blocking on one
    // would deadlock the pipeline behind a permanently zero-bar market that
    // eligibleAssets keeps in scope because an open trade holds it there.
    // `skipped` in the payload is how the agent learns coverage is partial.
    const full = symbols === undefined;
    if (full) stampPhase(db, session.session_date, "coverage", now);

    return {
      session_date: session.session_date,
      covered: rows.length,
      eligible: eligible.length,
      skipped,
      phase_complete: full,
    };
  });
}

function list(opts: { asset?: string; date?: string }): Promise<unknown> {
  return withDb((db) => {
    const date = readSessionDate(db, opts.date, nowIso());
    const rows = listCoverage(db, date, requireSymbols(db, csv(opts.asset)));
    return { session_date: date, count: rows.length, coverage: rows };
  });
}

export const handle = handler(build);
