import { parseArgs } from "node:util";
import { openDb } from "../db/connect.ts";
import { resolveSession, readSessionDate, stampPhase } from "../db/repo/session.ts";
import { requireAssetBySymbol } from "../db/repo/asset.ts";
import { getClusterParams, getGlobalParams } from "../db/repo/cluster.ts";
import { recordScreen, listScreen, countCoverage, countScreened } from "../db/repo/screen.ts";
import { resolveParams } from "../domain/params.ts";
import { deriveScreen } from "../domain/screen.ts";
import { assertPhaseOrder, nowIso } from "../domain/session.ts";
import { metricPairs, readText, required, unknownVerb } from "./args.ts";
import { JanusError } from "../output.ts";

export async function handle(verb: string | undefined, argv: string[]): Promise<unknown> {
  const db = openDb();
  try {
    const [symbol, ...rest] = argv;
    const { values } = parseArgs({
      args: verb === "list" ? argv : rest,
      options: {
        rationale: { type: "string" }, metric: { type: "string", multiple: true },
        flagged: { type: "boolean" }, date: { type: "string" }, force: { type: "boolean" },
      },
    });

    if (verb === "record") {
      const now = nowIso();
      const session = resolveSession(db, values.date, now);
      assertPhaseOrder(session, "screen", values.force === true);
      const asset = requireAssetBySymbol(db, required(symbol, "symbol").toUpperCase());

      const hasCoverage = db
        .prepare("SELECT 1 FROM coverage WHERE session_date = ? AND asset_id = ?")
        .get(session.session_date, asset.id);
      if (hasCoverage === undefined) {
        throw new JanusError("NO_COVERAGE", `${asset.symbol} has no coverage for ${session.session_date}`);
      }

      const params = resolveParams(getClusterParams(db, asset.cluster_id), getGlobalParams(db));

      // Whatever was recorded goes through as-is; deriveScreen decides which
      // metrics it cannot do without, and what they mean for the flag.
      const metrics = metricPairs(values.metric, "metric");
      const { flagged, results } = deriveScreen(metrics, params);

      recordScreen(db, session.session_date, asset.id, {
        flagged,
        rationale: readText(values.rationale) ?? null,
        metrics,
        results,
      }, now);

      // The phase completes once every covered asset has been screened.
      const complete = countScreened(db, session.session_date) >= countCoverage(db, session.session_date);
      if (complete) stampPhase(db, session.session_date, "screen", now);

      return {
        session_date: session.session_date,
        symbol: asset.symbol,
        metrics, results, flagged,
        screened: countScreened(db, session.session_date),
        of: countCoverage(db, session.session_date),
        phase_complete: complete,
      };
    }

    if (verb === "list") {
      const date = readSessionDate(db, values.date, nowIso());
      const rows = listScreen(db, date, { flaggedOnly: values.flagged });
      return { session_date: date, count: rows.length, screens: rows };
    }

    throw unknownVerb(verb, "screen", "record, list");
  } finally {
    db.close();
  }
}
