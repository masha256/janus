#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { emit, fail } from "./output.js";
import { strict } from "./cli/command.js";
import * as init from "./cli/init.js";
import * as market from "./cli/market.js";
import * as cluster from "./cli/cluster.js";
import * as param from "./cli/param.js";
import * as asset from "./cli/asset.js";
import * as session from "./cli/session.js";
import * as macro from "./cli/macro.js";
import * as coverage from "./cli/coverage.js";
import * as screen from "./cli/screen.js";
import * as score from "./cli/score.js";
import * as trade from "./cli/trade.js";
import * as heat from "./cli/heat.js";
const NOUNS = [
    init.build, market.build, cluster.build, param.build, asset.build,
    session.build, macro.build, coverage.build, screen.build, score.build, trade.build,
    heat.build,
];
// Same relative path from src/cli.ts and dist/cli.js, so the version never drifts.
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
// Handled before commander sees it, for two reasons: an argv that fails to
// parse at all still has to produce a human-shaped error for a human, and the
// passThroughOptions verbs (param set, cluster set-param) would otherwise take
// a trailing --human as one of their positional arguments.
const human = process.argv.includes("--human");
const argv = process.argv.filter((a) => a !== "--human");
async function main() {
    let result;
    const program = new Command("janus")
        .description("State manager for a discretionary trading system on Lighter perpetuals.\n" +
        "Records what was decided and why; it never places, modifies, or cancels an order.\n\n" +
        "Every command prints one JSON object unless --human is passed.")
        .version(version)
        // Required by the passThroughOptions verbs nested below (param set,
        // cluster set-param), which is how a negative value stays positional.
        .enablePositionalOptions()
        .showHelpAfterError("(run with --help for usage)");
    for (const build of NOUNS)
        program.addCommand(build((data) => { result = data; }));
    // Declared on every leaf so it appears in that command's own help. It is
    // stripped from argv above, so nothing ever reads the parsed value.
    for (const noun of program.commands) {
        for (const verb of noun.commands.length === 0 ? [noun] : noun.commands) {
            verb.option("--human", "render the result as text instead of JSON");
        }
    }
    strict(program, (s) => process.stdout.write(s));
    await program.parseAsync(argv);
    emit(result, human);
}
main().catch((e) => {
    // --help and --version are handled by commander, which reports them as a
    // thrown error with a zero exit code once the text has been written.
    if (e instanceof Error && e.exitCode === 0)
        return;
    fail(e, human);
});
