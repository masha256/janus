import { parseArgs } from "node:util";
import { openDb } from "../db/connect.ts";
import { getSession, listSessions } from "../db/repo/session.ts";
import { eligibleAssets } from "../db/repo/asset.ts";
import { nextPhase, todayNY, PHASES } from "../domain/session.ts";
import { JanusError } from "../output.ts";

export async function handle(verb: string | undefined, argv: string[]): Promise<unknown> {
  const db = openDb();
  try {
    if (verb === "status") {
      const { values } = parseArgs({ args: argv, options: { date: { type: "string" } } });
      const date = values.date ?? todayNY();
      const session = getSession(db, date);
      if (session === undefined) {
        return { session_date: date, exists: false, next_phase: "regime", eligible_assets: eligibleAssets(db).length };
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
    }
    if (verb === "list") {
      const { values } = parseArgs({ args: argv, options: { limit: { type: "string" } } });
      const limit = Number(values.limit ?? 20);
      if (!Number.isInteger(limit) || limit < 1) {
        throw new JanusError("VALIDATION", `--limit must be a positive integer, got ${values.limit}`);
      }
      const sessions = listSessions(db, limit);
      return { count: sessions.length, sessions };
    }
    throw new JanusError("VALIDATION", `unknown verb "${verb}" for session; try: status, list`);
  } finally {
    db.close();
  }
}
