import { Command } from "commander";
import { openBook } from "../db/repo/trade.js";
import { getGlobalParams } from "../db/repo/cluster.js";
import { resolveParams } from "../domain/params.js";
import { deriveHeatReport } from "../domain/heat.js";
import { todayNY } from "../domain/session.js";
import { handler, withDb } from "./command.js";
export function build(emit) {
    return new Command("heat")
        .description("Portfolio risk against the book-wide and per-asset guards, with a per-cluster split")
        .action(async () => emit(await heat()));
}
function heat() {
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
