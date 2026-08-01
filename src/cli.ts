#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { emit, fail } from "./output.ts";
import { strict, type Build } from "./cli/command.ts";
import * as init from "./cli/init.ts";
import * as market from "./cli/market.ts";
import * as cluster from "./cli/cluster.ts";
import * as param from "./cli/param.ts";
import * as asset from "./cli/asset.ts";
import * as session from "./cli/session.ts";
import * as macro from "./cli/macro.ts";
import * as coverage from "./cli/coverage.ts";
import * as screen from "./cli/screen.ts";
import * as score from "./cli/score.ts";
import * as trade from "./cli/trade.ts";

const NOUNS: Build[] = [
  init.build, market.build, cluster.build, param.build, asset.build,
  session.build, macro.build, coverage.build, screen.build, score.build, trade.build,
];

// Same relative path from src/cli.ts and dist/cli.js, so the version never drifts.
const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

// Handled before commander sees it, for two reasons: an argv that fails to
// parse at all still has to produce a human-shaped error for a human, and the
// passThroughOptions verbs (param set, cluster set-param) would otherwise take
// a trailing --human as one of their positional arguments.
const human = process.argv.includes("--human");
const argv = process.argv.filter((a) => a !== "--human");

async function main(): Promise<void> {
  let result: unknown;
  const program = new Command("janus")
    .description(
      "State manager for a discretionary trading system on Lighter perpetuals.\n" +
      "Records what was decided and why; it never places, modifies, or cancels an order.\n\n" +
      "Every command prints one JSON object unless --human is passed.",
    )
    .version(version)
    // Required by the passThroughOptions verbs nested below (param set,
    // cluster set-param), which is how a negative value stays positional.
    .enablePositionalOptions()
    .showHelpAfterError("(run with --help for usage)");

  for (const build of NOUNS) program.addCommand(build((data) => { result = data; }));

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

main().catch((e: unknown) => {
  // --help and --version are handled by commander, which reports them as a
  // thrown error with a zero exit code once the text has been written.
  if (e instanceof Error && (e as { exitCode?: number }).exitCode === 0) return;
  fail(e, human);
});
