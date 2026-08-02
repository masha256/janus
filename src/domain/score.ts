import { JanusError } from "../output.ts";
import { type Metrics, num, requireNum } from "./metrics.ts";
import type { Read } from "./read.ts";
import type { Directive, OpenPosition } from "./directive.ts";
import type { CoverageValues } from "./coverage.ts";

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/** A phase read as the formula sees it: what it observed, what it concluded. */
export type Screen = Read & { flagged: boolean };

/**
 * Everything the session knows at scoring time. The reads come top down; the
 * screen is null for an asset that reached the queue on an open trade rather
 * than a flag; `positions` is every open position in the book, not just this
 * asset's, so a formula can weigh the decision against what is already on.
 */
export type ScoreContext = {
  macro: Read;
  cluster: Read | null;
  screen: Screen | null;
  positions: OpenPosition[];
  asset: {
    symbol: string;
    class: string;
    cluster_id: number | null;
    coverage: CoverageValues | null;
  };
};

export type ScoreResult = {
  /** The standardised decision inputs, named for what they mean. */
  strength: number;
  conviction: number;
  /** What to do about the position. */
  directive: Directive;
  /** Everything else the formula concluded, serialized into score_result. */
  results: Metrics;
};

/**
 * deriveScore turns the agent's scoring metrics into a direction and conviction.
 *
 * Inputs:
 *   catalyst     -2..+2
 *   trend        -2..+2
 *   secular      -2..+2
 *   crowding     1..100
 *   capitulation true/false
 *   divergence   true/false
 *   confidence   0..1
 *
 * Sentiment is derived from crowding with a divergence booster.
 * Direction is the weighted sum of catalyst, sentiment, trend, the session's regime_smile, and secular, clamped
 * to [-2, 2].
 * Conviction fuses the magnitude of direction confidence: 1 + 9 * ((|D|/2)^0.8 * (Q^0.2)).
 */
export function deriveScore(
  metrics: Metrics,
  context: ScoreContext,
  params: Record<string, number>,
): ScoreResult {
  const catalyst = requireFactor(metrics, "catalyst");
  const trend = requireFactor(metrics, "trend");
  const secular = requireFactor(metrics, "secular");
  const crowding = requireCrowding(metrics);
  const capitulation = Boolean(metrics["capitulation"]);
  const divergence = Boolean(metrics["divergence"]);
  const confidence = requireNum(metrics, "confidence", 0, 1);

  const { sentiment, summary } = sentimentFromCrowding(crowding, trend, capitulation, divergence);

  const regimeSmile = num(context.cluster?.results ?? {}, "regime_smile") ?? 0;

  const wCat = params["w_catalyst"] ?? 0;
  const wSent = params["w_sentiment"] ?? 0;
  const wTrend = params["w_trend"] ?? 0;
  const wRegime = params["w_regime"] ?? 0;
  const wSecular = params["w_secular"] ?? 0;

  const direction = clamp(
    wCat * catalyst + wSent * sentiment + wTrend * trend + wRegime * regimeSmile + wSecular * secular,
    -2,
    2,
  );

  const conviction = clamp(
    1 + 9 * ((Math.abs(direction) / 2) ** 0.8 * (confidence ** 0.2)),
    1,
    10,
  );

  return {
    strength: direction,
    conviction: Math.round(conviction),
    directive: deriveDirective(),
    results: {
      w_catalyst: wCat,
      w_sentiment: wSent,
      w_trend: wTrend,
      w_regime: wRegime,
      w_secular: wSecular,
      sentiment,
      sentiment_summary: summary,
    },
  };
}

function requireFactor(metrics: Metrics, key: string): number {
  const value = metrics[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < -2 || value > 2) {
    throw new JanusError(
      "VALIDATION",
      `factor ${key} must be a number between -2 and 2, got ${value}`,
    );
  }
  return value;
}

function requireCrowding(metrics: Metrics): number {
  const value = metrics["crowding"];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1 || value > 100) {
    throw new JanusError(
      "VALIDATION",
      `crowding must be a number between 1 and 100, got ${value}`,
    );
  }
  return value;
}

function sentimentFromCrowding(
  P: number,
  trend: number,
  capitulation: boolean,
  divergence: boolean,
): { sentiment: number; summary: string } {
  let base: number;
  let summary: string;
  if (capitulation || P <= 12) {
    base = 2.0;
    summary = "<=12 / capitulation - true panic";
  } else if (P < 25) {
    base = 1.0;
    summary = "12-25 - fear";
  } else if (P < 40) {
    base = 0.75 * (40 - P) / 15.0;
    summary = "25-40 - getting fearful (linear)";
  } else if (P < 65) {
    const s = trend > 0 ? 1.0 : (trend < 0 ? -1.0 : 0.0);
    base = 0.4 * s;
    summary = "40-65 - calm middle (+0.4 x sign(Trend))";
  } else if (P < 85) {
    base = -1.0 * (P - 65) / 20.0;
    summary = "65-85 - getting crowded (linear)";
  } else if (P < 95) {
    base = -1.5;
    summary = "85-95 - greed, fade";
  } else {
    base = -2.0;
    summary = ">=95 - true euphoria, fade hard";
  }

  let sentiment = base;
  if (divergence) {
    if (base === 0) {
      summary += " (divergence booster skipped: SC_base = 0, no fade direction)";
    } else {
      sentiment = clamp(base + Math.sign(base) * 0.5, -2.0, 2.0);
      summary += " + divergence booster";
    }
  }
  return { sentiment, summary };
}


/**
 * Stub. The ladder that turns strength, conviction, and the open position into
 * INITIATE/ADD/HOLD/TRIM/EXIT is still to be written; until then every score
 * concludes NONE rather than guessing.
 */
function deriveDirective(): Directive {
  return "NONE";
}
