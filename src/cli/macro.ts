import { parseArgs } from "node:util";
import { openDb } from "../db/connect.ts";
import { resolveSession, readSessionDate, stampPhase } from "../db/repo/session.ts";
import { recordMacro, getMacro } from "../db/repo/phase.ts";
import { listClusters, getGlobalParams } from "../db/repo/cluster.ts";
import { resolveParams } from "../domain/params.ts";
import { deriveMacroRead } from "../domain/read.ts";
import { assertPhaseOrder, nowIso } from "../domain/session.ts";
import { metricPairs, oneOf, readText, required, unknownVerb } from "./args.ts";

const STATES = ["RISK_ON", "NEUTRAL", "RISK_OFF"] as const;

export async function handle(verb: string | undefined, argv: string[]): Promise<unknown> {
  const db = openDb();
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        state: { type: "string" }, summary: { type: "string" },
        metric: { type: "string", multiple: true },
        date: { type: "string" }, force: { type: "boolean" },
      },
    });

    if (verb === "record") {
      const now = nowIso();
      const session = resolveSession(db, values.date, now);
      assertPhaseOrder(session, "macro", values.force === true);
      // Whatever was recorded goes through as-is; deriveMacroRead decides which
      // metrics it cannot do without and refuses the rest.
      const metrics = metricPairs(values.metric, "metric");
      // The macro read is session-wide, so it resolves against the global rung only.
      const params = resolveParams({}, getGlobalParams(db));

      recordMacro(db, session.session_date, {
        state: oneOf(values.state, "state", STATES),
        summary: required(readText(values.summary), "summary"),
        metrics,
        results: deriveMacroRead(metrics, params),
      }, now);
      stampPhase(db, session.session_date, "macro", now);
      const stamped = ["macro"];
      // A phase with nothing to read is vacuously complete. Without this, a
      // session with no clusters could never stamp cluster_read_at, because
      // cluster record requires a cluster key that does not exist.
      if (listClusters(db).length === 0) {
        stampPhase(db, session.session_date, "cluster_read", now);
        stamped.push("cluster_read");
      }
      return {
        session_date: session.session_date,
        stamped,
        ...getMacro(db, session.session_date),
      };
    }
    if (verb === "reads") {
      const date = readSessionDate(db, values.date, nowIso());
      return { session_date: date, ...getMacro(db, date) };
    }
    throw unknownVerb(verb, "macro", "record, reads");
  } finally {
    db.close();
  }
}
