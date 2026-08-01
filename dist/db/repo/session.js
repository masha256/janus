import { JanusError } from "../../output.js";
import { phaseColumn, todayNY } from "../../domain/session.js";
export function getSession(db, date) {
    return db.prepare("SELECT * FROM session WHERE session_date = ?").get(date);
}
export function requireSession(db, date) {
    const row = getSession(db, date);
    if (row === undefined)
        throw new JanusError("SESSION_MISSING", `no session for ${date}`);
    return row;
}
export function ensureSession(db, date, now) {
    db.prepare("INSERT OR IGNORE INTO session (session_date, opened_at) VALUES (?, ?)").run(date, now);
    return requireSession(db, date);
}
/**
 * `--date` addresses an existing session and never creates one. Omitting it
 * targets today, creating the session on demand — there is no separate open step.
 */
export function resolveSession(db, dateFlag, now) {
    if (dateFlag !== undefined)
        return requireSession(db, dateFlag);
    return ensureSession(db, todayNY(new Date(now)), now);
}
/**
 * The read-only counterpart of resolveSession: the date a read should query,
 * without creating a session. `janus score list` on a fresh database must not
 * make a session appear — only a phase command opens one.
 */
export function readSessionDate(db, dateFlag, now) {
    if (dateFlag !== undefined)
        return requireSession(db, dateFlag).session_date;
    return todayNY(new Date(now));
}
export function listSessions(db, limit) {
    return db
        .prepare("SELECT * FROM session ORDER BY session_date DESC LIMIT ?")
        .all(limit);
}
export function stampPhase(db, date, phase, at) {
    // phaseColumn returns one of five fixed literals, so interpolation is safe here.
    db.prepare(`UPDATE session SET ${phaseColumn(phase)} = ? WHERE session_date = ?`).run(at, date);
}
