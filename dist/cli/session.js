import { Command } from "commander";
import { ensureSession, getSession, listSessions } from "../db/repo/session.js";
import { eligibleAssets } from "../db/repo/asset.js";
import { nextPhase, todayNY, PHASES, nowIso } from "../domain/session.js";
import { unknownVerb } from "./args.js";
import { handler, withDb } from "./command.js";
import { JanusError } from "../output.js";
export function build(emit) {
    const cmd = new Command("session")
        .description("Where the daily pipeline stands")
        .action(() => { throw unknownVerb(undefined, "session", "status, list"); });
    cmd.command("status")
        .description("Phase completion and counts for one session")
        .option("--date <YYYY-MM-DD>", "defaults to today, New York")
        .action(async (opts) => emit(await status(opts.date)));
    cmd.command("list")
        .description("Recent sessions, most recent first")
        .option("--limit <N>", "how many to return (default 20)")
        .action(async (opts) => emit(await list(opts.limit)));
    cmd.command("open")
        .description("Create a session for a past date (for backfill/testing only)")
        .option("--date <YYYY-MM-DD>", "date to open; required")
        .action(async (opts) => emit(await openSession(opts.date)));
    return cmd;
}
function openSession(date) {
    if (date === undefined) {
        throw new JanusError("VALIDATION", "--date is required for session open");
    }
    return withDb((db) => {
        const now = nowIso();
        const existing = getSession(db, date);
        if (existing !== undefined) {
            throw new JanusError("VALIDATION", `session ${date} already exists`);
        }
        const session = ensureSession(db, date, now);
        return { session_date: session.session_date, opened_at: now };
    });
}
function status(date = todayNY()) {
    return withDb((db) => {
        const session = getSession(db, date);
        if (session === undefined) {
            return {
                session_date: date, exists: false, next_phase: "macro",
                eligible_assets: eligibleAssets(db).length,
            };
        }
        const counts = db.prepare(`SELECT
         (SELECT COUNT(*) FROM coverage WHERE session_date = ?1) AS coverage,
         (SELECT COUNT(*) FROM screen   WHERE session_date = ?1) AS screened,
         (SELECT COUNT(*) FROM screen   WHERE session_date = ?1 AND flagged = 1) AS flagged,
         (SELECT COUNT(*) FROM score    WHERE session_date = ?1) AS scored`).get(date);
        return {
            session_date: date,
            exists: true,
            phases: Object.fromEntries(PHASES.map((p) => [p, session[`${p}_at`]])),
            next_phase: nextPhase(session),
            eligible_assets: eligibleAssets(db).length,
            counts,
        };
    });
}
function list(raw) {
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
