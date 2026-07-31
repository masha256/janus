import { parseArgs } from "node:util";
import { openDb } from "../db/connect.ts";
import { resolveSession, stampPhase } from "../db/repo/session.ts";
import { recordRegime, getRegime } from "../db/repo/phase.ts";
import { assertPhaseOrder, nowIso } from "../domain/session.ts";
import { num, oneOf, readText, required, pairs } from "./args.ts";
import { JanusError } from "../output.ts";

const STATES = ["RISK_ON", "NEUTRAL", "RISK_OFF"] as const;

export async function handle(verb: string | undefined, argv: string[]): Promise<unknown> {
  const db = openDb();
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        state: { type: "string" }, score: { type: "string" }, confidence: { type: "string" },
        summary: { type: "string" }, metric: { type: "string", multiple: true },
        date: { type: "string" }, force: { type: "boolean" },
      },
    });

    if (verb === "record") {
      const now = nowIso();
      const session = resolveSession(db, values.date, now);
      assertPhaseOrder(session, "regime", values.force === true);
      recordRegime(db, session.session_date, {
        state: oneOf(values.state, "state", STATES),
        score: num(values.score, "score", -2, 2),
        confidence: num(values.confidence, "confidence", 0, 2),
        summary: required(readText(values.summary), "summary"),
        metrics: pairs(values.metric, "metric"),
      }, now);
      stampPhase(db, session.session_date, "regime", now);
      return { session_date: session.session_date, ...(getRegime(db, session.session_date) as object) };
    }
    if (verb === "show") {
      const session = resolveSession(db, values.date, nowIso());
      return { session_date: session.session_date, ...(getRegime(db, session.session_date) as object) };
    }
    throw new JanusError("VALIDATION", `unknown verb "${verb}" for regime; try: record, show`);
  } finally {
    db.close();
  }
}
