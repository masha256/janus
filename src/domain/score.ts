import { JanusError } from "../output.ts";
import { type Metrics, num } from "./metrics.ts";
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
 * v1 placeholder. `strength` is the weighted mean of the metrics; `conviction`
 * rewards signal strength and inter-metric agreement equally. The context is
 * reported on rather than acted on: the weighted mean stands on its own, and
 * the alignment flags record whether the top-down reads back it up.
 *
 * `directive` is a stub — every score returns NONE until the real ladder lands.
 * When it does, it belongs here, with the whole context already in hand.
 *
 * Replacing any of this is a single-file change — nothing outside reads it.
 */
export function deriveScore(
  metrics: Metrics,
  context: ScoreContext,
  params: Record<string, number>,
): ScoreResult {
  // A score metric has to be a number in range — this formula takes a weighted
  // mean of them. Narrowing here is what lets the rest do arithmetic safely.
  const values: Record<string, number> = {};
  const applied: Record<string, number> = {};
  for (const [key, value] of Object.entries(metrics)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < -2 || value > 2) {
      throw new JanusError(
        "VALIDATION",
        `factor ${key} must be a number between -2 and 2, got ${value}`,
      );
    }
    values[key] = value;
    applied[key] = params[`w_${key}`] ?? 0;
  }

  // The weight actually applied to each factor is a conclusion, not an
  // observation, so it rides along in the results.
  const weights: Metrics = {};
  for (const [key, w] of Object.entries(applied)) weights[`w_${key}`] = w;

  const weighted = Object.entries(applied).filter(([, w]) => w !== 0);
  const totalWeight = weighted.reduce((a, [, w]) => a + Math.abs(w), 0);
  if (totalWeight === 0) {
    return {
      strength: 0,
      conviction: 1,
      directive: deriveDirective(),
      results: { ...weights, ...alignment(0, context) },
    };
  }

  const strength = clamp(
    weighted.reduce((a, [k, w]) => a + w * values[k]!, 0) / totalWeight,
    -2,
    2,
  );
  const agree =
    Math.abs(weighted.reduce((a, [k, w]) => a + Math.sign(w * values[k]!) * Math.abs(w), 0)) /
    totalWeight;
  const conviction = clamp(
    Math.round(1 + 9 * (0.5 * (Math.abs(strength) / 2) + 0.5 * agree)),
    1,
    10,
  );

  return {
    strength,
    conviction,
    directive: deriveDirective(),
    results: { ...weights, ...alignment(strength, context) },
  };
}

/**
 * Stub. The ladder that turns strength, conviction, and the open position into
 * INITIATE/ADD/HOLD/TRIM/EXIT is still to be written; until then every score
 * concludes NONE rather than guessing.
 *
 * ponytail: stubbed directive. The `d_*`, `conv_*`, and `max_units` parameters
 * are reserved for the real ladder and read by nothing until it lands — delete
 * them from DEFAULT_PARAMS if it turns out they are not the shape it wants.
 */
function deriveDirective(): Directive {
  return "NONE";
}

/**
 * Does the session's top-down read back this decision up? 1 when the tilt
 * agrees in direction, 0 when it does not or when either side is flat. An
 * unclustered asset has no cluster read, so `cluster_aligned` stays 0.
 */
function alignment(strength: number, context: ScoreContext): Metrics {
  const agrees = (tilt: number): number =>
    Math.sign(strength) !== 0 && Math.sign(strength) === Math.sign(tilt) ? 1 : 0;
  return {
    macro_aligned: agrees(num(context.macro.results, "tilt")),
    cluster_aligned: context.cluster === null ? 0 : agrees(num(context.cluster.results, "tilt")),
  };
}
