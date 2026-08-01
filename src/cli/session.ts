import { Command } from "commander";
import { getSession, listSessions } from "../db/repo/session.ts";
import { eligibleAssets } from "../db/repo/asset.ts";
import { nextPhase, todayNY, PHASES } from "../domain/session.ts";
import { unknownVerb } from "./args.ts";
import { type Emit, handler, withDb } from "./command.ts";
import { JanusError } from "../output.ts";

export function build(emit: Emit): Command {
  const cmd = new Command("session")
    .description("Where the daily pipeline stands")
    .action(() => { throw unknownVerb(undefined, "session", "status, list"); });

  cmd.command("status")
    .description("Phase completion and counts for one session")
    .option("--date <YYYY-MM-DD>", "defaults to today, New York")
    .action(async (opts: { date?: string }) => emit(await status(opts.date)));

  cmd.command("list")
    .description("Recent sessions, most recent first")
    .option("--limit <N>", "how many to return (default 20)")
    .action(async (opts: { limit?: string }) => emit(await list(opts.limit)));

  return cmd;
}

function status(date = todayNY()): Promise<unknown> {
  return withDb((db) => {
    const session = getSession(db, date);
    if (session === undefined) {
      return {
        session_date: date, exists: false, next_phase: "macro",
        eligible_assets: eligibleAssets(db).length,
      };
    }
    const counts = db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM coverage WHERE session_date = ?1) AS coverage,
         (SELECT COUNT(*) FROM screen   WHERE session_date = ?1) AS screened,
         (SELECT COUNT(*) FROM screen   WHERE session_date = ?1 AND flagged = 1) AS flagged,
         (SELECT COUNT(*) FROM score    WHERE session_date = ?1) AS scored`,
    ).get(date);
    return {
      session_date: date,
      exists: true,
      phases: Object.fromEntries(PHASES.map((p) => [p, session[`${p}_at` as keyof typeof session]])),
      next_phase: nextPhase(session),
      eligible_assets: eligibleAssets(db).length,
      counts,
    };
  });
}

function list(raw: string | undefined): Promise<unknown> {
  const limit = Number(raw ?? 20);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new JanusError("VALIDATION", `--limit must be a positive integer, got ${raw}`);
  }
  return withDb((db) => {
    const sessions = listSessions(db, limit);
    return { count: sessions.length, sessions };
  });
}

export const handle = handler(build);
