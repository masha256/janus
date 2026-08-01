import { JanusError } from "../output.ts";

export const PHASES = ["macro", "cluster", "coverage", "screen", "score"] as const;
export type Phase = (typeof PHASES)[number];

/**
 * What each phase actually depends on, as opposed to where it sits in the
 * recommended order. `coverage` fetches market data and derives indicators from
 * it: nothing in that touches the macro or cluster reads, so it is free to run
 * first, or in parallel with them, or on a day the operator never reads at all.
 * Everything downstream still needs it, and `screen` still needs the reads.
 */
const REQUIRES: Record<Phase, readonly Phase[]> = {
  macro: [],
  cluster: ["macro"],
  coverage: [],
  screen: ["cluster", "coverage"],
  score: ["screen"],
};

/** Depth-first, so an error names the earliest missing phase rather than the nearest. */
function prerequisites(phase: Phase): Phase[] {
  return REQUIRES[phase].flatMap((earlier) => [...prerequisites(earlier), earlier]);
}

export type SessionRow = {
  session_date: string;
  opened_at: string;
  macro_at: string | null;
  cluster_at: string | null;
  coverage_at: string | null;
  screen_at: string | null;
  score_at: string | null;
};

const NY_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The session's calendar date, anchored to New York so the day boundary matches the close. */
export function todayNY(now?: Date): string {
  return NY_DATE.format(now ?? new Date());
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function phaseColumn(phase: Phase): string {
  return `${phase}_at`;
}

export function nextPhase(session: SessionRow): Phase | null {
  for (const phase of PHASES) {
    if (session[phaseColumn(phase) as keyof SessionRow] === null) return phase;
  }
  return null;
}

/** Throws PHASE_ORDER naming the first incomplete prerequisite. Re-running a done phase is fine. */
export function assertPhaseOrder(session: SessionRow, phase: Phase, force: boolean): void {
  if (force) return;
  for (const earlier of prerequisites(phase)) {
    if (session[phaseColumn(earlier) as keyof SessionRow] === null) {
      throw new JanusError(
        "PHASE_ORDER",
        `${earlier} not complete for ${session.session_date}; run it first or pass --force`,
      );
    }
  }
}
