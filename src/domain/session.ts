import { JanusError } from "../output.ts";

export const PHASES = ["regime", "cluster_read", "coverage", "screen", "score"] as const;
export type Phase = (typeof PHASES)[number];

export type SessionRow = {
  session_date: string;
  opened_at: string;
  regime_at: string | null;
  cluster_read_at: string | null;
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

/** Throws PHASE_ORDER naming the first incomplete predecessor. Re-running a done phase is fine. */
export function assertPhaseOrder(session: SessionRow, phase: Phase, force: boolean): void {
  if (force) return;
  for (const earlier of PHASES) {
    if (earlier === phase) return;
    if (session[phaseColumn(earlier) as keyof SessionRow] === null) {
      throw new JanusError(
        "PHASE_ORDER",
        `${earlier} not complete for ${session.session_date}; run it first or pass --force`,
      );
    }
  }
}
