import type { DatabaseSync } from "node:sqlite";
import type { OpenPosition, PositionState } from "../../domain/directive.ts";
import { type Metrics, metricsByEntity, replaceMetrics } from "./metric.ts";

export type QueueEntry = {
  asset_id: number;
  symbol: string;
  class: string;
  cluster_id: number | null;
  queue_reason: "flagged" | "open_trade" | "both";
};

export type ScoreRow = {
  /** The two standardised numbers the directive comes from. Always present, so: columns. */
  strength: number;
  conviction: number;
  directive: string;
  queue_reason: string;
  position_state: string;
  rationale: string | null;
  /** The factors the agent supplied. */
  metrics: Metrics;
  /** Everything else the formula concluded, such as the applied weights. */
  results: Metrics;
  /** Actionable sub-plan from the directive ladder. */
  plan?: import("../../domain/directive.ts").ScorePlan;
};

/**
 * Flagged this session, unioned with anything carrying an open trade. An open
 * position needs a directive daily whether or not it screened.
 */
export function scoreQueue(db: DatabaseSync, date: string): QueueEntry[] {
  return db
    .prepare(
      `SELECT a.id AS asset_id, a.symbol, a.class, a.cluster_id,
              CASE WHEN f.asset_id IS NOT NULL AND t.asset_id IS NOT NULL THEN 'both'
                   WHEN f.asset_id IS NOT NULL THEN 'flagged'
                   ELSE 'open_trade' END AS queue_reason
       FROM asset a
       LEFT JOIN (SELECT asset_id FROM screen WHERE session_date = ? AND flagged = 1) f ON f.asset_id = a.id
       LEFT JOIN (SELECT DISTINCT asset_id FROM trade WHERE status = 'open') t ON t.asset_id = a.id
       WHERE f.asset_id IS NOT NULL OR t.asset_id IS NOT NULL
       ORDER BY a.symbol`,
    )
    .all(date) as QueueEntry[];
}

/**
 * Side and open unit count for an asset's open trade, if any. An open trade
 * whose units have all closed (a data state Task 17 is meant to prevent by
 * flipping trade.status to 'closed') must not surface as a live position —
 * a directive formula treats any non-null side as "in a position", so units=0
 * with a side would wrongly unlock HOLD/TRIM/EXIT. Collapse that case to flat.
 */
export function positionOf(db: DatabaseSync, assetId: number): PositionState {
  const row = db
    .prepare(
      `SELECT t.direction, COUNT(u.id) AS units
       FROM trade t LEFT JOIN trade_unit u ON u.trade_id = t.id AND u.status = 'open'
       WHERE t.asset_id = ? AND t.status = 'open'
       GROUP BY t.id`,
    )
    .get(assetId) as { direction: "long" | "short"; units: number } | undefined;
  if (row === undefined || row.units === 0) return { side: null, units: 0 };
  return { side: row.direction, units: row.units };
}

/**
 * Every open position in the book, for formulas that weigh a decision against
 * what is already on. Same units=0 collapse as positionOf: a trade whose units
 * have all closed is not a live position.
 */
export function openPositions(db: DatabaseSync): OpenPosition[] {
  return db
    .prepare(
      `SELECT t.asset_id, a.symbol, t.direction AS side, COUNT(u.id) AS units
       FROM trade t
       JOIN asset a ON a.id = t.asset_id
       LEFT JOIN trade_unit u ON u.trade_id = t.id AND u.status = 'open'
       WHERE t.status = 'open'
       GROUP BY t.id
       HAVING units > 0
       ORDER BY a.symbol`,
    )
    .all() as OpenPosition[];
}

export function recordScore(
  db: DatabaseSync,
  date: string,
  assetId: number,
  row: ScoreRow,
  now: string,
): void {
  db.exec("BEGIN");
  try {
    db.prepare(
      `INSERT INTO score (session_date, asset_id, strength, conviction, directive, queue_reason, position_state, rationale, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_date, asset_id) DO UPDATE SET
         strength = excluded.strength, conviction = excluded.conviction,
         directive = excluded.directive,
         queue_reason = excluded.queue_reason, position_state = excluded.position_state,
         rationale = excluded.rationale, recorded_at = excluded.recorded_at`,
    ).run(date, assetId, row.strength, row.conviction, row.directive, row.queue_reason, row.position_state, row.rationale, now);
    const scope = { session_date: date, asset_id: assetId };
    replaceMetrics(db, "score_metric", scope, row.metrics);
    replaceMetrics(db, "score_result", scope, row.results);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** The N most recent scores for an asset before the given session, newest first. */
export function recentScores(
  db: DatabaseSync,
  assetId: number,
  beforeDate: string,
  limit: number,
): import("../../domain/score.ts").ScoreResult[] {
  const rows = db
    .prepare(
      `SELECT session_date, asset_id, strength, conviction, directive, queue_reason, position_state, rationale
       FROM score WHERE asset_id = ? AND session_date < ? ORDER BY session_date DESC LIMIT ?`,
    )
    .all(assetId, beforeDate, limit) as { session_date: string; asset_id: number; strength: number; conviction: number; directive: string; queue_reason: string; position_state: string; rationale: string | null }[];

  return rows.map((row) => {
    const metrics = metricsByEntity(db, "score_metric", "asset_id", row.session_date);
    const results = metricsByEntity(db, "score_result", "asset_id", row.session_date);
    const r = results.get(row.asset_id) ?? {};
    const plan = scorePlanFromResultsStatic(r);
    return {
      strength: row.strength,
      conviction: row.conviction,
      directive: row.directive as import("../../domain/directive.ts").Directive,
      plan: plan ?? {
        directive: row.directive as import("../../domain/directive.ts").Directive,
        reason: "recovered from legacy score",
        size_tier: "full",
        signal_gate: "pass",
        persistence_gate: "pass",
        trend_gate: "pass",
        binary_gate: "pass",
        heat_gate: "pass",
        flipflop_gate: "n/a",
      },
      results: r,
    };
  });
}

/** The most recent closed trade exit for an asset before the given session, if any. */
export function lastTradeExit(
  db: DatabaseSync,
  assetId: number,
  beforeDate: string,
): { session_date: string; side: "long" | "short"; units: number } | null {
  const row = db
    .prepare(
      `SELECT t.closed_on, t.direction, COUNT(u.id) AS units
       FROM trade t LEFT JOIN trade_unit u ON u.trade_id = t.id
       WHERE t.asset_id = ? AND t.status = 'closed' AND t.closed_on < ?
       GROUP BY t.id
       ORDER BY t.closed_on DESC, t.id DESC
       LIMIT 1`,
    )
    .get(assetId, beforeDate) as { closed_on: string; direction: "long" | "short"; units: number } | undefined;
  if (row === undefined || row.units === 0) return null;
  return {
    session_date: row.closed_on,
    side: row.direction,
    units: row.units,
  };
}

/** The most recent score for an asset before the given session, if any. */
export function previousScore(
  db: DatabaseSync,
  assetId: number,
  beforeDate: string,
): import("../../domain/score.ts").ScoreResult | null {
  const row = db
    .prepare(
      `SELECT * FROM score WHERE asset_id = ? AND session_date < ? ORDER BY session_date DESC LIMIT 1`,
    )
    .get(assetId, beforeDate) as { session_date: string; asset_id: number; strength: number; conviction: number; directive: string; queue_reason: string; position_state: string; rationale: string | null } | undefined;
  if (row === undefined) return null;
  const metrics = metricsByEntity(db, "score_metric", "asset_id", row.session_date);
  const results = metricsByEntity(db, "score_result", "asset_id", row.session_date);
    const r = results.get(row.asset_id) ?? {};
    const plan = scorePlanFromResultsStatic(r);
    return {
      strength: row.strength,
      conviction: row.conviction,
      directive: row.directive as import("../../domain/directive.ts").Directive,
      plan: plan ?? {
        directive: row.directive as import("../../domain/directive.ts").Directive,
        reason: "recovered from legacy score",
        size_tier: "full",
        signal_gate: "pass",
        persistence_gate: "pass",
        trend_gate: "pass",
        binary_gate: "pass",
        heat_gate: "pass",
        flipflop_gate: "n/a",
      },
      results: r,
    };
  }

function scorePlanFromResultsStatic(
  results: Record<string, unknown>,
): import("../../domain/directive.ts").ScorePlan | undefined {
  const directive = results["plan_directive"] as import("../../domain/directive.ts").Directive | undefined;
  if (directive === undefined) return undefined;
  const size_tier = results["size_tier"] as import("../../domain/directive.ts").ScorePlan["size_tier"] | undefined;
  if (size_tier === undefined) return undefined;
  const plan: import("../../domain/directive.ts").ScorePlan = {
    directive,
    reason: String(results["directive_reason"] ?? ""),
    size_tier,
    signal_gate: (results["signal_gate"] as import("../../domain/directive.ts").ScorePlan["signal_gate"]) ?? "fail",
    persistence_gate: (results["persistence_gate"] as import("../../domain/directive.ts").ScorePlan["persistence_gate"]) ?? "insufficient_history",
    trend_gate: (results["trend_gate"] as import("../../domain/directive.ts").ScorePlan["trend_gate"]) ?? "fail",
    binary_gate: (results["binary_gate"] as import("../../domain/directive.ts").ScorePlan["binary_gate"]) ?? "pass",
    heat_gate: (results["heat_gate"] as import("../../domain/directive.ts").ScorePlan["heat_gate"]) ?? "pass",
    flipflop_gate: (results["flipflop_gate"] as import("../../domain/directive.ts").ScorePlan["flipflop_gate"]) ?? "n/a",
    regime_trigger: (results["regime_trigger"] as import("../../domain/directive.ts").ScorePlan["regime_trigger"]) ?? "none",
    persistence_rule: (results["persistence_rule"] as import("../../domain/directive.ts").ScorePlan["persistence_rule"]) ?? undefined,
  };
  const entrySide = results["entry_side"] as "long" | "short" | undefined;
  if (entrySide !== undefined) {
    plan.entry_plan = {
      side: entrySide,
      max_units: Number(results["entry_max_units"] ?? 0),
    };
  }
  const stopAction = results["stop_action"] as NonNullable<import("../../domain/directive.ts").ScorePlan["stop_plan"]>["action"] | undefined;
  if (stopAction !== undefined) {
    plan.stop_plan = {
      action: stopAction,
      affected_units: String(results["stop_affected_units"] ?? "all") as NonNullable<import("../../domain/directive.ts").ScorePlan["stop_plan"]>["affected_units"],
      rationale: String(results["stop_rationale"] ?? ""),
    };
  }
  const trimTarget = results["trim_target_units"] as number | undefined;
  if (trimTarget !== undefined) {
    plan.trim_plan = {
      target_units: Number(trimTarget),
      which: String(results["trim_which"] ?? "oldest") as NonNullable<import("../../domain/directive.ts").ScorePlan["trim_plan"]>["which"],
    };
  }
  return plan;
}

export function getScore(
  db: DatabaseSync,
  date: string,
  assetId: number,
): { session_date: string; asset_id: number; symbol: string; class: string; strength: number; conviction: number; directive: string; queue_reason: string; position_state: string; rationale: string | null; metrics: Metrics; results: Metrics; plan: import("../../domain/directive.ts").ScorePlan | undefined } | undefined {
  const row = db
    .prepare(
      `SELECT a.symbol, a.class, s.* FROM score s
       JOIN asset a ON a.id = s.asset_id
       WHERE s.session_date = ? AND s.asset_id = ?`,
    )
    .get(date, assetId) as { session_date: string; asset_id: number; symbol: string; class: string; strength: number; conviction: number; directive: string; queue_reason: string; position_state: string; rationale: string | null } | undefined;
  if (row === undefined) return undefined;
  const metrics = metricsByEntity(db, "score_metric", "asset_id", date);
  const results = metricsByEntity(db, "score_result", "asset_id", date);
  const r = results.get(row.asset_id) ?? {};
  const plan = scorePlanFromResultsStatic(r);
  return { ...row, metrics: metrics.get(row.asset_id) ?? {}, results: r, plan };
}

export function listScores(db: DatabaseSync, date: string): unknown[] {
  const scores = db
    .prepare(
      `SELECT a.symbol, a.class, s.* FROM score s
       JOIN asset a ON a.id = s.asset_id
       WHERE s.session_date = ? ORDER BY ABS(s.strength) DESC, a.symbol`,
    )
    .all(date) as { asset_id: number }[];
  const metrics = metricsByEntity(db, "score_metric", "asset_id", date);
  const results = metricsByEntity(db, "score_result", "asset_id", date);
  return scores.map((s) => ({
    ...s,
    metrics: metrics.get(s.asset_id) ?? {},
    results: results.get(s.asset_id) ?? {},
  }));
}
