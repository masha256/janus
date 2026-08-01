import { parseArgs } from "node:util";
import { openDb } from "../db/connect.ts";
import { resolveSession, readSessionDate, stampPhase } from "../db/repo/session.ts";
import { requireAssetBySymbol } from "../db/repo/asset.ts";
import { getClusterParams, getGlobalParams } from "../db/repo/cluster.ts";
import { scoreQueue, positionOf, openPositions, recordScore, listScores } from "../db/repo/score.ts";
import { getMacro, getClusterRead } from "../db/repo/phase.ts";
import { listCoverage, getCoverage } from "../db/repo/coverage.ts";
import { listScreen, getScreen } from "../db/repo/screen.ts";
import { resolveParams } from "../domain/params.ts";
import { deriveScore } from "../domain/score.ts";
import { formatPosition } from "../domain/directive.ts";
import { assertPhaseOrder, nowIso } from "../domain/session.ts";
import { pairs, readText, required, unknownVerb } from "./args.ts";
import { JanusError } from "../output.ts";

export async function handle(verb: string | undefined, argv: string[]): Promise<unknown> {
  const db = openDb();
  try {
    const [symbol, ...rest] = argv;
    const { values } = parseArgs({
      args: verb === "record" ? rest : argv,
      options: {
        factor: { type: "string", multiple: true }, rationale: { type: "string" },
        date: { type: "string" }, force: { type: "boolean" },
      },
    });

    if (verb === "queue") {
      const date = readSessionDate(db, values.date, nowIso());
      const queue = scoreQueue(db, date);
      const coverage = listCoverage(db, date) as { symbol: string }[];
      const screens = listScreen(db, date, {}) as { symbol: string }[];
      const bySymbol = <T extends { symbol: string }>(rows: T[]): Map<string, T> =>
        new Map(rows.map((r) => [r.symbol, r]));
      const cov = bySymbol(coverage);
      const scr = bySymbol(screens);
      return {
        session_date: date,
        count: queue.length,
        queue: queue.map((q) => ({
          ...q,
          position: formatPosition(positionOf(db, q.asset_id)),
          coverage: cov.get(q.symbol) ?? null,
          screen: scr.get(q.symbol) ?? null,
        })),
      };
    }

    if (verb === "record") {
      const now = nowIso();
      const session = resolveSession(db, values.date, now);
      assertPhaseOrder(session, "score", values.force === true);
      const asset = requireAssetBySymbol(db, required(symbol, "symbol").toUpperCase());

      const queue = scoreQueue(db, session.session_date);
      const entry = queue.find((q) => q.asset_id === asset.id);
      if (entry === undefined) {
        throw new JanusError(
          "NOT_FLAGGED",
          `${asset.symbol} is not in the scoring queue for ${session.session_date}`,
        );
      }

      const factors = pairs(values.factor, "factor");
      if (Object.keys(factors).length === 0) {
        throw new JanusError("VALIDATION", "at least one --factor key=value is required");
      }

      const params = resolveParams(getClusterParams(db, asset.cluster_id), getGlobalParams(db));
      // Everything the session already concluded, top down, plus the whole book.
      const context = {
        macro: getMacro(db, session.session_date),
        cluster: asset.cluster_id === null
          ? null
          : getClusterRead(db, session.session_date, asset.cluster_id),
        screen: getScreen(db, session.session_date, asset.id),
        positions: openPositions(db),
        asset: {
          symbol: asset.symbol,
          class: asset.class,
          cluster_id: asset.cluster_id,
          coverage: getCoverage(db, session.session_date, asset.id),
        },
      };

      const { strength, conviction, directive, results } = deriveScore(factors, context, params);
      const position = positionOf(db, asset.id);

      recordScore(db, session.session_date, asset.id, {
        strength, conviction, directive,
        queue_reason: entry.queue_reason,
        position_state: formatPosition(position),
        rationale: readText(values.rationale) ?? null,
        // The factors as given; everything else the formula concluded alongside.
        metrics: factors,
        results,
      }, now);

      const scored = (listScores(db, session.session_date) as unknown[]).length;
      const complete = scored >= queue.length;
      if (complete) stampPhase(db, session.session_date, "score", now);

      return {
        session_date: session.session_date,
        symbol: asset.symbol,
        strength, conviction, directive,
        position: formatPosition(position),
        queue_reason: entry.queue_reason,
        metrics: factors,
        results,
        scored, of: queue.length,
        phase_complete: complete,
      };
    }

    if (verb === "list") {
      const date = readSessionDate(db, values.date, nowIso());
      const scores = listScores(db, date);
      return { session_date: date, count: scores.length, scores };
    }

    throw unknownVerb(verb, "score", "queue, record, list");
  } finally {
    db.close();
  }
}
