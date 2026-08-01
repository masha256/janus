import { JanusError } from "../output.js";
export const PHASES = ["macro", "cluster", "coverage", "screen", "score"];
/**
 * What each phase actually depends on, as opposed to where it sits in the
 * recommended order. `coverage` fetches market data and derives indicators from
 * it: nothing in that touches the macro or cluster reads, so it is free to run
 * first, or in parallel with them, or on a day the operator never reads at all.
 * Everything downstream still needs it, and `screen` still needs the reads.
 */
const REQUIRES = {
    macro: [],
    cluster: ["macro"],
    coverage: [],
    screen: ["cluster", "coverage"],
    score: ["screen"],
};
/** Depth-first, so an error names the earliest missing phase rather than the nearest. */
function prerequisites(phase) {
    return REQUIRES[phase].flatMap((earlier) => [...prerequisites(earlier), earlier]);
}
const NY_DATE = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
});
/** The session's calendar date, anchored to New York so the day boundary matches the close. */
export function todayNY(now) {
    return NY_DATE.format(now ?? new Date());
}
export function nowIso() {
    return new Date().toISOString();
}
export function phaseColumn(phase) {
    return `${phase}_at`;
}
export function nextPhase(session) {
    for (const phase of PHASES) {
        if (session[phaseColumn(phase)] === null)
            return phase;
    }
    return null;
}
/** Throws PHASE_ORDER naming the first incomplete prerequisite. Re-running a done phase is fine. */
export function assertPhaseOrder(session, phase, force) {
    if (force)
        return;
    for (const earlier of prerequisites(phase)) {
        if (session[phaseColumn(earlier)] === null) {
            throw new JanusError("PHASE_ORDER", `${earlier} not complete for ${session.session_date}; run it first or pass --force`);
        }
    }
}
