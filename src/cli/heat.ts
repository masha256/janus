import { Command } from "commander";
import { openBook } from "../db/repo/trade.ts";
import { getGlobalParams } from "../db/repo/cluster.ts";
import { resolveParams } from "../domain/params.ts";
import { deriveHeatReport } from "../domain/heat.ts";
import { todayNY } from "../domain/session.ts";
import { type Emit, handler, withDb } from "./command.ts";

export function build(emit: Emit): Command {
  return new Command("heat")
    .description("Portfolio risk against the book-wide and per-asset guards, with a per-cluster split")
    .action(async () => emit(await heat()));
}

function heat(): Promise<unknown> {
  return withDb((db) => {
    // Global rung only. Heat is a property of the whole book, so resolving a
    // cluster's params here would measure every position against whichever
    // cluster happened to be asked — and cluster overrides of max_heat_pct do
    // not scope the limit to that cluster, they just tighten the book's.
    const params = resolveParams({}, getGlobalParams(db));
    return deriveHeatReport(openBook(db), params, todayNY());
  });
}

export const handle = handler(build);
