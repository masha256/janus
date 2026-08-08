import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveScore, type ScoreContext } from "./score.ts";
import { DEFAULT_PARAMS } from "./params.ts";
import type { Metrics } from "./metrics.ts";

/** A context that concludes nothing: the metrics alone decide direction and conviction. */
const flat: ScoreContext = {
  macro: { metrics: {}, results: {} },
  cluster: null,
  screen: { flagged: false, metrics: { score: 1 }, results: { screen_score: 0.5, threshold: 4, regime: 0, regime_smile: 0 } },
  positions: [],
  asset: { symbol: "BTC", class: "crypto", cluster_id: null, coverage: null },
  session_date: "2026-07-31",
};

const ctx = (macroRegime: number, clusterRegime: number | null): ScoreContext => ({
  ...flat,
  macro: { metrics: { regime: macroRegime }, results: {} },
  cluster: clusterRegime === null
    ? null
    : { metrics: { regime: clusterRegime }, results: {} },
  asset: { ...flat.asset, cluster_id: clusterRegime === null ? null : 1 },
  screen: {
    flagged: true,
    metrics: { score: 5 },
    results: {
      screen_score: 5,
      threshold: 4,
      regime: clusterRegime ?? macroRegime,
      regime_smile: 0.6 * (clusterRegime ?? macroRegime),
    },
  },
});

function m(
  catalyst: number,
  trend: number,
  secular: number,
  crowding: number,
  capitulation: boolean,
  divergence: boolean,
  confidence = 1,
): Metrics {
  return { catalyst, trend, secular, crowding, capitulation, divergence, confidence };
}

test("direction is the weighted mean of factors normalised by total |weight|", () => {
  const got = deriveScore(
    m(2, 1, -1, 50, false, false),
    flat,
    DEFAULT_PARAMS,
  );
  // P=50 -> calm middle, trend>0 -> sentiment = 0.4 * 1.25 fear premium = 0.5
  // weights: catalyst 0.25, sentiment 0.25, trend 0.3, regime 0.15, secular 0.05
  // weighted sum = 0.25*2 + 0.25*0.5 + 0.3*1 + 0.15*0 + 0.05*(-1) = 0.875
  // total |weight| = 1.0, so direction = 0.875
  assert.ok(Math.abs(got.direction - 0.875) < 1e-12, `got ${got.direction}`);
  assert.equal(got.results["regime"], 0);
  assert.equal(got.results["regime_smile"], 0);
  assert.ok(Math.abs((got.results["weighted_sum"] as number) - 0.875) < 1e-12);
  assert.equal(got.results["total_abs_weight"], 1.0);
});

test("direction stays in range when weights do not sum to 1", () => {
  // Every weight doubled: raw sum would be 1.75, but the normalised mean is unchanged.
  const doubled = Object.fromEntries(
    Object.entries(DEFAULT_PARAMS).map(([k, v]) => [k, k.startsWith("w_") ? v * 2 : v]),
  );
  const got = deriveScore(m(2, 1, -1, 50, false, false), flat, doubled);
  assert.ok(Math.abs(got.direction - 0.875) < 1e-12, `got ${got.direction}`);
  assert.equal(got.results["total_abs_weight"], 2.0);
});

test("sentiment bands match the crowding lookup, with the fear premium applied to the buy side", () => {
  const cases: [number, number, string][] = [
    [5, 2.0, "<=12 / capitulation - true panic"],
    [20, 1.25, "12-25 - fear"],
    [30, 0.625, "25-40 - getting fearful (linear)"],
    [50, 0.5, "40-65 - calm middle (+0.4 x sign(Trend))"],
    [75, -0.5, "65-85 - getting crowded (linear)"],
    [90, -1.5, "85-95 - greed, fade"],
    [98, -2.0, ">=95 - true euphoria, fade hard"],
  ];
  for (const [crowding, expected, band] of cases) {
    const got = deriveScore(
      m(0, 1, 0, crowding, false, false),
      flat,
      { ...DEFAULT_PARAMS, w_catalyst: 0, w_trend: 0, w_secular: 0, w_regime: 0, w_sentiment: 1 },
    );
    assert.ok(Math.abs(got.direction - expected) < 1e-12, `crowding ${crowding}: got ${got.direction}, want ${expected}`);
    assert.equal(got.results["sentiment_summary"], band);
  }
});

test("the fear premium is asymmetric: buy side amplified, sell side untouched", () => {
  const longPanic = deriveScore(
    m(0, 1, 0, 5, false, false),
    flat,
    { ...DEFAULT_PARAMS, w_catalyst: 0, w_trend: 0, w_secular: 0, w_regime: 0, w_sentiment: 1 },
  );
  assert.equal(longPanic.results["sentiment"], 2.0); // 2.0 * 1.25, clamped at 2

  const fear = deriveScore(
    m(0, 1, 0, 20, false, false),
    flat,
    { ...DEFAULT_PARAMS, w_catalyst: 0, w_trend: 0, w_secular: 0, w_regime: 0, w_sentiment: 1 },
  );
  assert.equal(fear.results["sentiment"], 1.25); // 1.0 * 1.25

  const greed = deriveScore(
    m(0, 1, 0, 90, false, false),
    flat,
    { ...DEFAULT_PARAMS, w_catalyst: 0, w_trend: 0, w_secular: 0, w_regime: 0, w_sentiment: 1 },
  );
  assert.equal(greed.results["sentiment"], -1.5); // unchanged

  const fearZero = deriveScore(
    m(0, 1, 0, 20, false, false),
    flat,
    { ...DEFAULT_PARAMS, fear_premium: 1.0, w_catalyst: 0, w_trend: 0, w_secular: 0, w_regime: 0, w_sentiment: 1 },
  );
  assert.equal(fearZero.results["sentiment"], 1.0); // premium 1.0 turns it off
});

test("divergence boosts the sentiment in the same direction", () => {
  const fearful = deriveScore(
    m(0, 1, 0, 20, false, false),
    flat,
    { ...DEFAULT_PARAMS, w_catalyst: 0, w_trend: 0, w_secular: 0, w_regime: 0, w_sentiment: 1 },
  );
  assert.equal(fearful.direction, 1.25);

  const boosted = deriveScore(
    m(0, 1, 0, 20, false, true),
    flat,
    { ...DEFAULT_PARAMS, w_catalyst: 0, w_trend: 0, w_secular: 0, w_regime: 0, w_sentiment: 1 },
  );
  assert.equal(boosted.direction, 1.75); // (1.0 * 1.25) + 0.5
  assert.match(String(boosted.results["sentiment_summary"]), /divergence booster/);
});

test("divergence booster size is a cluster-tunable param", () => {
  const bigger = deriveScore(
    m(0, 1, 0, 20, false, true),
    flat,
    { ...DEFAULT_PARAMS, divergence_boost: 1.0, w_catalyst: 0, w_trend: 0, w_secular: 0, w_regime: 0, w_sentiment: 1 },
  );
  assert.equal(bigger.direction, 2.0); // (1.0 * 1.25) + 1.0, clamped at 2
  assert.equal(bigger.results["divergence_boost"], 1.0);

  const off = deriveScore(
    m(0, 1, 0, 20, false, true),
    flat,
    { ...DEFAULT_PARAMS, divergence_boost: 0, w_catalyst: 0, w_trend: 0, w_secular: 0, w_regime: 0, w_sentiment: 1 },
  );
  assert.equal(off.direction, 1.25); // 1.0 * 1.25, no boost
});

test("confidence is the scoring metric's own 0..1 quality, not inherited from the screen", () => {
  const highConf = deriveScore(
    m(2, 0, 0, 50, false, false, 1),
    ctx(0, null),
    DEFAULT_PARAMS,
  );
  const lowConf = deriveScore(
    m(2, 0, 0, 50, false, false, 0.3),
    ctx(0, null),
    DEFAULT_PARAMS,
  );
  assert.ok(highConf.conviction > lowConf.conviction, "higher confidence raises conviction");
  assert.equal(highConf.results["confidence"], 1);
  assert.equal(lowConf.results["confidence"], 0.3);
});

test("absent confidence means no information, giving conviction floor", () => {
  const metrics = m(2, 0, 0, 50, false, false);
  delete metrics["confidence"];
  const got = deriveScore(metrics, flat, DEFAULT_PARAMS);
  assert.equal(got.conviction, 1);
  assert.equal(got.results["confidence"], 0);
});

test("screen confidence is not inherited when scoring confidence is absent", () => {
  const metrics = m(2, 0, 0, 50, false, false);
  delete metrics["confidence"];
  const withScreenConf: ScoreContext = {
    ...flat,
    screen: {
      flagged: false,
      metrics: { score: 5, confidence: 1 }, // screen judged a different question at 1.0
      results: { screen_score: 5, threshold: 4, regime: 0, regime_smile: 0 },
    },
  };
  const got = deriveScore(metrics, withScreenConf, DEFAULT_PARAMS);
  assert.equal(got.results["confidence"], 0, "screen confidence must not leak into scoring");
  assert.equal(got.conviction, 1);
});

test("agreement is snapshotted: 1 when all aligned, less when factors cancel", () => {
  const aligned = deriveScore(
    m(2, 2, 2, 5, false, false), // crowding 5 -> panic -> +2.0 * 1.25 = +2.0 sentiment
    flat,
    DEFAULT_PARAMS,
  );
  assert.ok(Math.abs((aligned.results["agreement"] as number) - 1) < 1e-12);

  // catalyst +2 vs trend -2, sentiment +0.4 (crowding 50), regime 0, secular 0
  const mixed = deriveScore(
    m(2, -2, 0, 50, false, false),
    flat,
    DEFAULT_PARAMS,
  );
  const agreement = mixed.results["agreement"] as number;
  assert.ok(agreement < 1 && agreement >= 0, `agreement ${agreement}`);
  assert.ok(agreement < 0.2, `heavily cancelling factors should score low agreement, got ${agreement}`);
});

test("deriveScore rejects invalid factors and crowding", () => {
  assert.throws(() => deriveScore(m(3, 0, 0, 50, false, false), flat, DEFAULT_PARAMS), /catalyst/);
  assert.throws(() => deriveScore(m(0, 0, 0, 0, false, false), flat, DEFAULT_PARAMS), /crowding/);
  assert.throws(() => deriveScore(m(0, 0, 0, 101, false, false), flat, DEFAULT_PARAMS), /crowding/);
});

test("deriveScore requires a screen with regime and regime_smile", () => {
  assert.throws(
    () => deriveScore(m(2, 0, 0, 50, false, false), { ...flat, screen: null }, DEFAULT_PARAMS),
    /screen must be recorded before scoring/,
  );
  assert.throws(
    () => deriveScore(
      m(2, 0, 0, 50, false, false),
      { ...flat, screen: { flagged: false, metrics: { score: 1 }, results: { screen_score: 0.5, threshold: 4 } } },
      DEFAULT_PARAMS,
    ),
    /regime/,
  );
});

test("a quiet second day still INITIATES when trend and sentiment persist", () => {
  // Day 1: real catalyst drives a flag and a strong score, but persistence fails.
  const day1: import("./score.ts").ScoreResult = {
    direction: 1.2, conviction: 8, directive: "STAND_ASIDE",
    plan: {
      directive: "STAND_ASIDE", reason: "prior signal", size_tier: "blocked",
      signal_gate: "pass", persistence_gate: "fail", trend_gate: "pass",
      binary_gate: "pass", heat_gate: "pass", flipflop_gate: "n/a",
    },
    results: {},
  };
  // Day 2: no fresh headline, but yesterday's catalyst is still driving flow
  // (1.0), the trend is still strong, and sentiment is slightly fearful.
  // With signal_direction_initiate = 0.9 and the persistence rule satisfied,
  // this must INITIATE rather than stand aside.
  const got = deriveScore(
    m(1.0, 2, 0.5, 35, false, false),
    ctxWithPosition({ side: null, units: 0 }, coverage(), day1),
    DEFAULT_PARAMS,
  );
  assert.equal(got.directive, "INITIATE", `expected INITIATE, got ${got.directive}`);
  assert.equal(got.plan.persistence_gate, "pass");
});

test("top-down alignment uses regime_smile", () => {
  // With catalyst/trend/secular flat and regime the only live weight, direction is regime_smile.
  // Regime 1.5 -> regime_smile 0.9, so direction is positive and aligns with it.
  const bullish = deriveScore(
    m(0, 0, 0, 50, false, false),
    ctx(1.5, 1.5),
    { ...DEFAULT_PARAMS, w_regime: 5, w_sentiment: 0, w_catalyst: 0, w_trend: 0, w_secular: 0 },
  );
  assert.ok(bullish.direction > 0, `direction ${bullish.direction}`);
  assert.ok(Math.abs(bullish.direction - 0.9) < 1e-12, `normalised direction ${bullish.direction}`);
  assert.ok(Math.abs((bullish.results["regime_smile"] as number) - 0.9) < 1e-12, `got ${bullish.results["regime_smile"]}`);

  // Without a cluster, the screen would have used the macro regime, so an
  // unclustered asset still sees the same regime_smile when macro matches.
  const macroOnly = deriveScore(
    m(0, 0, 0, 50, false, false),
    ctx(1.5, null),
    { ...DEFAULT_PARAMS, w_regime: 5, w_sentiment: 0, w_catalyst: 0, w_trend: 0, w_secular: 0 },
  );
  assert.ok(macroOnly.direction > 0, `direction ${macroOnly.direction}`);
  assert.ok(Math.abs((macroOnly.results["regime_smile"] as number) - 0.9) < 1e-12, `got ${macroOnly.results["regime_smile"]}`);
});

test("a flat asset with no edge and no trend gate stays STAND_ASIDE", () => {
  assert.equal(
    deriveScore(
      m(0, 0, 0, 50, false, false),
      flat,
      DEFAULT_PARAMS,
    ).directive,
    "STAND_ASIDE",
  );
});

function coverage(over: Partial<import("./coverage.ts").CoverageValues> = {}): import("./coverage.ts").CoverageValues {
  return {
    open: 0, high: 0, low: 0, close: 100, volume: 0,
    mark_price: 100, index_price: 100, open_interest: 0, daily_change_pct: 0,
    sma20: 98, sma50: 95, sma200: 90, ema12: 99, ema26: 96, atr14: 5,
    px_vs_sma20: 2, px_vs_sma50: 5, px_vs_sma200: 10,
    cross_50_200: "golden", cross_50_200_age: 10, cross_px_50: "above", cross_px_50_age: 10,
    bars_available: 250, fetched_at: "2026-07-31T12:00:00Z",
    ...over,
  };
}

const longPos = (units = 1): import("./directive.ts").PositionState => ({ side: "long", units });
const shortPos = (units = 1): import("./directive.ts").PositionState => ({ side: "short", units });

function ctxWithPosition(
  pos: import("./directive.ts").PositionState,
  cov: import("./coverage.ts").CoverageValues | null = coverage(),
  prev: import("./score.ts").ScoreResult | null = null,
): import("./score.ts").ScoreContext {
  return {
    ...flat,
    positions: pos.side === null
      ? []
      : [{ asset_id: 1, symbol: "BTC", side: pos.side, units: pos.units }],
    asset: { ...flat.asset, coverage: cov },
    previous_score: prev,
    recent_scores: prev === null ? [] : [prev],
  };
}

test("flat + strong bullish + trend gate pass + persisted -> INITIATE", () => {
  const prev: import("./score.ts").ScoreResult = {
    direction: 1.8, conviction: 9, directive: "STAND_ASIDE",
    plan: {
      directive: "STAND_ASIDE", reason: "prior signal", size_tier: "blocked",
      signal_gate: "pass", persistence_gate: "fail", trend_gate: "pass",
      binary_gate: "pass", heat_gate: "pass", flipflop_gate: "n/a",
    },
    results: {},
  };
  const got = deriveScore(
    m(2, 2, 2, 50, false, false),
    ctxWithPosition({ side: null, units: 0 }, coverage(), prev),
    DEFAULT_PARAMS,
  );
  assert.equal(got.directive, "INITIATE");
  assert.equal(got.plan.directive, "INITIATE");
  assert.equal(got.plan.trend_gate, "pass");
  assert.equal(got.plan.entry_plan?.side, "long");
});

test("the sizing plan scales with today's conviction, not the previous score's", () => {
  const prev: import("./score.ts").ScoreResult = {
    direction: 1.8, conviction: 9, directive: "STAND_ASIDE",
    plan: {
      directive: "STAND_ASIDE", reason: "prior signal", size_tier: "blocked",
      signal_gate: "pass", persistence_gate: "fail", trend_gate: "pass",
      binary_gate: "pass", heat_gate: "pass", flipflop_gate: "n/a",
    },
    results: {},
  };
  // Lift the per-asset cap so the budget, not the cap, decides the size —
  // otherwise both convictions clamp to the same capped notional and the bug
  // hides. Stop is 2 x atr 5 below a mark of 100, so the distance is 10%.
  const params = { ...DEFAULT_PARAMS, per_asset_max_notional_pct: 100 };
  const got = deriveScore(
    m(2, 2, 2, 50, false, false),
    ctxWithPosition({ side: null, units: 0 }, coverage(), prev),
    params,
  );
  assert.equal(got.conviction, 7, "today's conviction");
  // 100000 * 5% * 0.7 = 3500 budget / 0.10 = 35000. Yesterday's 9 would give 45000.
  assert.equal(got.plan.sizing_plan?.suggested_notional, 35000);
  assert.equal(got.plan.sizing_plan?.risk_dollars, 3500);
});

test("flat + strong bullish + trend gate fail -> STAND_ASIDE", () => {
  const got = deriveScore(
    m(2, 2, 2, 50, false, false),
    ctxWithPosition({ side: null, units: 0 }, coverage({ px_vs_sma20: -2, px_vs_sma50: -5 })),
    DEFAULT_PARAMS,
  );
  assert.equal(got.directive, "STAND_ASIDE");
  assert.equal(got.plan.trend_gate, "fail");
  assert.equal(got.plan.entry_plan, undefined);
});

test("flat + strong bullish + trend gate starter + persisted -> INITIATE with starter tier", () => {
  const prev: import("./score.ts").ScoreResult = {
    direction: 1.8, conviction: 9, directive: "STAND_ASIDE",
    plan: {
      directive: "STAND_ASIDE", reason: "prior signal", size_tier: "blocked",
      signal_gate: "pass", persistence_gate: "fail", trend_gate: "pass",
      binary_gate: "pass", heat_gate: "pass", flipflop_gate: "n/a",
    },
    results: {},
  };
  const params = { ...DEFAULT_PARAMS, per_asset_max_notional_pct: 100 };
  const got = deriveScore(
    m(2, 2, 2, 50, false, false),
    ctxWithPosition({ side: null, units: 0 }, coverage({ px_vs_sma20: 2, px_vs_sma50: -1 }), prev),
    params,
  );
  assert.equal(got.directive, "INITIATE");
  assert.equal(got.plan.trend_gate, "starter");
  assert.equal(got.plan.size_tier, "starter");
  assert.equal(got.plan.entry_plan?.side, "long");

  const full = deriveScore(
    m(2, 2, 2, 50, false, false),
    ctxWithPosition({ side: null, units: 0 }, coverage({ px_vs_sma20: 2, px_vs_sma50: 2 }), prev),
    params,
  );
  assert.equal(full.plan.trend_gate, "pass");
  assert.equal(full.plan.size_tier, "full");
  assert.ok(full.plan.sizing_plan, "full tier has sizing plan");
  assert.ok(got.plan.sizing_plan, "starter tier has sizing plan");
  const gotSizing = got.plan.sizing_plan!;
  const fullSizing = full.plan.sizing_plan!;
  assert.equal(
    gotSizing.suggested_notional,
    fullSizing.suggested_notional * 0.5,
    "starter notional is fraction of full notional",
  );
  assert.equal(
    gotSizing.risk_dollars,
    fullSizing.risk_dollars * 0.5,
    "starter risk is fraction of full risk",
  );
});

test("holding long + score flips hard -> EXIT", () => {
  const got = deriveScore(
    m(-2, -2, -2, 50, false, false),
    ctxWithPosition(longPos(2)),
    DEFAULT_PARAMS,
  );
  assert.equal(got.directive, "EXIT");
  assert.equal(got.plan.stop_plan?.action, "hold");
});

test("holding long + low conviction -> TRIM if more than one unit", () => {
  const got = deriveScore(
    m(1, 0, 0, 50, false, false, 0.3),
    ctxWithPosition(longPos(2)),
    DEFAULT_PARAMS,
  );
  assert.equal(got.directive, "TRIM");
  assert.equal(got.plan.trim_plan?.target_units, 1);
});

test("holding long + low conviction + only one unit -> HOLD", () => {
  const got = deriveScore(
    m(1, 0, 0, 50, false, false, 0.3),
    ctxWithPosition(longPos(1)),
    DEFAULT_PARAMS,
  );
  assert.equal(got.directive, "HOLD");
});

test("holding long + still aligned + working -> HOLD (most days)", () => {
  const got = deriveScore(
    m(1, 1, 1, 50, false, false),
    ctxWithPosition(longPos(1)),
    DEFAULT_PARAMS,
  );
  assert.equal(got.directive, "HOLD");
  // Not a plain all-clear: the add was held back, and the reason says by what.
  assert.equal(got.plan.reason, "thesis intact; add blocked by signal, persistence gate(s)");
});

test("holding long at the unit cap -> HOLD names the cap, not a blocked gate", () => {
  const prev: import("./score.ts").ScoreResult = {
    direction: 1.8, conviction: 9, directive: "HOLD",
    plan: {
      directive: "HOLD", reason: "thesis intact", size_tier: "full",
      signal_gate: "pass", persistence_gate: "pass", trend_gate: "pass",
      binary_gate: "pass", heat_gate: "pass", flipflop_gate: "n/a",
    },
    results: {},
  };
  const got = deriveScore(
    m(2, 2, 2, 50, false, false),
    ctxWithPosition(longPos(3), coverage(), prev),
    DEFAULT_PARAMS,
  );
  assert.equal(got.directive, "HOLD");
  assert.equal(got.plan.size_tier, "full");
  assert.equal(got.plan.reason, "thesis intact; at max 3 units");
});

test("holding long + regime extreme bullish forces EXIT", () => {
  const screen: import("./score.ts").Screen = {
    ...flat.screen!,
    results: { ...flat.screen!.results, regime: 2, regime_smile: 2 },
  };
  const ctx: import("./score.ts").ScoreContext = {
    ...ctxWithPosition(longPos(1)),
    screen,
  };
  const got = deriveScore(m(1, 1, 1, 50, false, false), ctx, DEFAULT_PARAMS);
  assert.equal(got.directive, "EXIT");
  assert.equal(got.plan.regime_trigger, "extreme_bull");
});

test("persistence rule downgrades fresh EXIT to TRIM without actionable signal", () => {
  const prev: import("./score.ts").ScoreResult = {
    direction: 1.2, conviction: 8, directive: "HOLD",
    plan: {
      directive: "HOLD", reason: "thesis intact", size_tier: "full",
      signal_gate: "pass", persistence_gate: "pass", trend_gate: "pass",
      binary_gate: "pass", heat_gate: "pass", flipflop_gate: "n/a",
    },
    results: {},
  };
  // Raise actionable_direction_delta so the direction delta alone does not count
  // as a fresh signal; no catalyst/divergence/capitulation is present either.
  const params = { ...DEFAULT_PARAMS, actionable_direction_delta: 5 };
  const got = deriveScore(
    m(-1, -2, -2, 50, false, false),
    ctxWithPosition(longPos(2), coverage(), prev),
    params,
  );
  assert.equal(got.directive, "TRIM");
  assert.equal(got.plan.persistence_rule, "maintain");
});

test("persistence rule allows EXIT when divergence is actionable", () => {
  const prev: import("./score.ts").ScoreResult = {
    direction: 1.2, conviction: 8, directive: "HOLD",
    plan: {
      directive: "HOLD", reason: "thesis intact", size_tier: "full",
      signal_gate: "pass", persistence_gate: "pass", trend_gate: "pass",
      binary_gate: "pass", heat_gate: "pass", flipflop_gate: "n/a",
    },
    results: {},
  };
  const params = { ...DEFAULT_PARAMS, actionable_direction_delta: 0.5 };
  const got = deriveScore(
    m(-1, -2, -2, 50, false, true),
    ctxWithPosition(longPos(2), coverage(), prev),
    params,
  );
  assert.equal(got.directive, "EXIT");
  assert.equal(got.plan.persistence_rule, "fresh_signal");
});

/**
 * BTC long, one open unit: entry 100, notional 1000 (size 10), risk 100.
 *
 * `stop` matters more than it looks. The ladder checks the breakeven rung
 * before partial or runner, and it fires whenever the oldest unit's stop is
 * still below entry. A fixture left at stop 90 therefore returns `breakeven`
 * no matter how far price has run. Pass stop 100 — already at breakeven — to
 * let a test reach the later rungs.
 */
function contextWithOpenTrade(opts: {
  mark: number;
  atr14: number;
  stop?: number;
  partialExited?: boolean;
  openedOn?: string;
}): ScoreContext {
  return {
    ...ctx(0, null),
    positions: [{ asset_id: 1, symbol: "BTC", side: "long", units: 1 }],
    asset: { ...flat.asset, coverage: coverage({ mark_price: opts.mark, atr14: opts.atr14 }) },
    open_trade: {
      direction: "long",
      units: [{
        seq: 1,
        entry_price: 100,
        notional: 1000,
        risk: 100,
        stop: opts.stop ?? 90,
        status: "open",
        exit_price: null,
        funding: 0,
        tag: null,
        partial_exited: opts.partialExited === true ? 1 : 0,
      }],
      entry_price: 100,
      initial_risk: 100,
      opened_on: opts.openedOn ?? "2026-07-01",
    },
  };
}

/** Flat, gates passing, so the INITIATE branch's own stop_plan is what we see. */
function contextFlat(): ScoreContext {
  const prev: import("./score.ts").ScoreResult = {
    direction: 1.8, conviction: 9, directive: "STAND_ASIDE",
    plan: {
      directive: "STAND_ASIDE", reason: "prior signal", size_tier: "blocked",
      signal_gate: "pass", persistence_gate: "fail", trend_gate: "pass",
      binary_gate: "pass", heat_gate: "pass", flipflop_gate: "n/a",
    },
    results: {},
  };
  return { ...ctxWithPosition({ side: null, units: 0 }, coverage(), prev), open_trade: null };
}

const holdMetrics = m(0, 1, 0, 50, false, false);
const exitMetrics = m(-2, -2, -2, 50, false, false);
const initiateMetrics = m(2, 2, 1, 50, false, false);
/** Still long, but conviction lands under conv_hold / the decay floor. */
const lowConvictionMetrics = m(1, 0, 0, 50, false, false, 0.3);
const PARAMS = DEFAULT_PARAMS;

test("a HOLD takes its stop_plan from the ladder", () => {
  // stop 100 = already at breakeven, mark 130 = +3R with a partial banked,
  // so the ladder lands on the runner rung.
  const c = contextWithOpenTrade({ mark: 130, atr14: 5, stop: 100, partialExited: true });
  const { plan } = deriveScore(holdMetrics, c, PARAMS);
  assert.equal(plan.directive, "HOLD");
  assert.equal(plan.stop_plan?.event, "runner");
  assert.equal(plan.stop_plan?.action, "trail");
  // mark 130 - 2 * atr 5 = 120, floored at entry 100
  assert.equal(plan.stop_plan?.new_stop, 120);
  assert.notEqual(plan.stop_plan?.rationale, "review stop/exit plan, no change today");
});

test("a stop still below entry puts the ladder on the breakeven rung", () => {
  const c = contextWithOpenTrade({ mark: 130, atr14: 5, stop: 90 });
  const { plan } = deriveScore(holdMetrics, c, PARAMS);
  assert.equal(plan.stop_plan?.event, "breakeven");
  assert.equal(plan.stop_plan?.action, "move_to_breakeven");
  assert.equal(plan.stop_plan?.new_stop, 100);
});

test("a ladder time_stop escalates a HOLD to EXIT", () => {
  // opened 2026-01-01 against session_date 2026-07-31 is well past 42 days
  const c = contextWithOpenTrade({ mark: 105, atr14: 5, stop: 100, openedOn: "2026-01-01" });
  const { plan } = deriveScore(holdMetrics, c, PARAMS);
  assert.equal(plan.directive, "EXIT");
  assert.equal(plan.stop_plan?.event, "time_stop");
  assert.match(plan.reason, /\(ladder: position open \d+ days, time stop reached\)/);
});

test("an EXIT directive keeps its own stop_plan", () => {
  const c = contextWithOpenTrade({ mark: 130, atr14: 5, stop: 100, partialExited: true });
  const { plan } = deriveScore(exitMetrics, c, PARAMS);
  assert.equal(plan.directive, "EXIT");
  assert.equal(plan.stop_plan?.rationale, "exit entire position");
  assert.equal(plan.stop_plan?.event, undefined, "the ladder must not overwrite an EXIT");
});

test("with no open trade the entry plan is unchanged", () => {
  const { plan } = deriveScore(initiateMetrics, contextFlat(), PARAMS);
  assert.equal(plan.directive, "INITIATE");
  assert.equal(plan.stop_plan?.rationale, "initial stop set at entry");
  assert.equal(plan.stop_plan?.event, undefined);
});

test("a banked partial moves the ladder off the partial rung", () => {
  const noPartial = contextWithOpenTrade({ mark: 130, atr14: 5, stop: 100, partialExited: false });
  assert.equal(deriveScore(holdMetrics, noPartial, PARAMS).plan.stop_plan?.event, "partial");
  const banked = contextWithOpenTrade({ mark: 130, atr14: 5, stop: 100, partialExited: true });
  assert.equal(deriveScore(holdMetrics, banked, PARAMS).plan.stop_plan?.event, "runner");
});

test("the partial rung passes the trim fraction through", () => {
  const c = contextWithOpenTrade({ mark: 130, atr14: 5, stop: 100, partialExited: false });
  const { plan } = deriveScore(holdMetrics, c, PARAMS);
  assert.equal(plan.stop_plan?.trim_fraction, 0.5);
  assert.equal(plan.stop_plan?.affected_units, "newest");
});

/** A prior same-side score strong enough to satisfy the persistence gate. */
const strongPrior: import("./score.ts").ScoreResult = {
  direction: 1.5, conviction: 8, directive: "ADD",
  plan: {
    directive: "ADD", reason: "prior", size_tier: "full",
    signal_gate: "pass", persistence_gate: "pass", trend_gate: "pass",
    binary_gate: "pass", heat_gate: "pass", flipflop_gate: "n/a",
  },
  results: {},
};

/** A prior same-side score with conviction under the decay floor. */
const decayingPrior: import("./score.ts").ScoreResult = {
  ...strongPrior, direction: 0.3, conviction: 2, directive: "TRIM",
};

test("an escalated EXIT drops the ADD's sizing_plan and entry_plan", () => {
  // Control: same fixture opened recently is an ADD that really does carry sizing.
  const fresh: ScoreContext = {
    ...contextWithOpenTrade({ mark: 130, atr14: 5, stop: 100, partialExited: true }),
    recent_scores: [strongPrior],
  };
  const control = deriveScore(initiateMetrics, fresh, PARAMS).plan;
  assert.equal(control.directive, "ADD");
  assert.ok(control.sizing_plan, "control ADD carries a sizing_plan to be dropped");

  // Same thing, 42+ days old: the ladder's time stop escalates it to EXIT.
  const stale: ScoreContext = {
    ...contextWithOpenTrade({
      mark: 130, atr14: 5, stop: 100, partialExited: true, openedOn: "2026-01-01",
    }),
    recent_scores: [strongPrior],
  };
  const { plan } = deriveScore(initiateMetrics, stale, PARAMS);
  assert.equal(plan.directive, "EXIT");
  assert.equal(plan.stop_plan?.event, "time_stop");
  assert.equal(plan.sizing_plan, undefined, "an exit-everything plan must not size a new add");
  assert.equal(plan.entry_plan, undefined);
});

test("an ADD keeps its lock-the-earlier-unit stop rule on the ladder's entry rung", () => {
  // One open unit, stop 90 still below entry 100, mark 105 = +0.5R: the ladder
  // lands on `entry` ("hold, full 1R at risk"), which would contradict adding.
  const c: ScoreContext = {
    ...contextWithOpenTrade({ mark: 105, atr14: 5, stop: 90 }),
    recent_scores: [strongPrior],
  };
  const { plan } = deriveScore(initiateMetrics, c, PARAMS);
  assert.equal(plan.directive, "ADD");
  assert.equal(plan.stop_plan?.action, "move_to_breakeven");
  assert.equal(plan.stop_plan?.affected_units, "oldest");
  assert.equal(plan.stop_plan?.event, undefined, "the entry rung must not overwrite an ADD's stop rule");
});

test("an escalated EXIT drops the TRIM's trim_plan", () => {
  const twoUnits = (recent: import("./score.ts").ScoreResult[]): ScoreContext => ({
    ...contextWithOpenTrade({ mark: 130, atr14: 5, stop: 100, partialExited: true }),
    positions: [{ asset_id: 1, symbol: "BTC", side: "long", units: 2 }],
    recent_scores: recent,
  });

  // Control: low conviction alone is a TRIM that really does carry a trim_plan.
  const control = deriveScore(lowConvictionMetrics, twoUnits([]), PARAMS).plan;
  assert.equal(control.directive, "TRIM");
  assert.equal(control.trim_plan?.target_units, 1, "control TRIM carries a trim_plan to be dropped");

  // A second sub-floor day on the same side trips decayGate, so the ladder escalates.
  const { plan } = deriveScore(lowConvictionMetrics, twoUnits([decayingPrior]), PARAMS);
  assert.equal(plan.directive, "EXIT");
  assert.equal(plan.stop_plan?.event, "decay_exit");
  assert.equal(plan.trim_plan, undefined, "an exit-everything plan must not also trim to N-1");
});

// ---------------------------------------------------------------------------
// Gate inputs come from the score's factors, not the screen row.
//
// `crowding`, `capitulation`, and `divergence` are all `score record --factor`
// inputs. They were previously read off `context.screen.metrics`, where nothing
// ever writes them — so crowding sat at its 50 default forever and the two
// booleans were permanently false. These pin the source.
// ---------------------------------------------------------------------------

/** Extended trend: far enough above the 200-day for the late-trend check to matter. */
const extended = () => coverage({ px_vs_sma20: 2, px_vs_sma50: 5, px_vs_sma200: 25 });

test("late_trend fires off the score's crowding factor", () => {
  const got = deriveScore(
    m(2, 2, 1, 88, false, false),
    ctxWithPosition({ side: null, units: 0 }, extended()),
    DEFAULT_PARAMS,
  );
  assert.ok(got.direction > 0, `needs a long side to reach the long branch, got ${got.direction}`);
  assert.equal(got.plan.trend_gate, "late_trend");
});

test("crowding below the extreme leaves an extended trend at pass", () => {
  const got = deriveScore(
    m(2, 2, 1, 50, false, false),
    ctxWithPosition({ side: null, units: 0 }, extended()),
    DEFAULT_PARAMS,
  );
  assert.equal(got.plan.trend_gate, "pass");
});

test("crowding on the screen row cannot drive late_trend", () => {
  // The regression: screen metrics are not a gate input. An extreme crowding
  // reading recorded there must be ignored, leaving the score's own 50.
  const base = ctxWithPosition({ side: null, units: 0 }, extended());
  const got = deriveScore(
    m(2, 2, 1, 50, false, false),
    { ...base, screen: { ...base.screen!, metrics: { score: 5, crowding: 99 } } },
    DEFAULT_PARAMS,
  );
  assert.equal(got.plan.trend_gate, "pass");
});

test("the divergence factor makes a TRIM actionable instead of downgrading it", () => {
  const held: import("./score.ts").ScoreResult = {
    direction: 0.5, conviction: 6, directive: "HOLD",
    plan: {
      directive: "HOLD", reason: "thesis intact", size_tier: "full",
      signal_gate: "pass", persistence_gate: "pass", trend_gate: "pass",
      binary_gate: "pass", heat_gate: "pass", flipflop_gate: "n/a",
    },
    results: {},
  };
  const ctx2 = ctxWithPosition(longPos(2), coverage(), held);

  // Conviction collapses with no fresh evidence: the persistence rule holds the
  // position rather than acting on a quiet day.
  const quiet = deriveScore(m(0, 0, 0, 50, false, false), ctx2, DEFAULT_PARAMS);
  assert.equal(quiet.plan.directive, "HOLD");
  assert.equal(quiet.plan.persistence_rule, "maintain");

  // Same collapse, but a divergence was observed — that is actionable, so the
  // TRIM stands.
  const diverging = deriveScore(m(0, 0, 0, 50, false, true), ctx2, DEFAULT_PARAMS);
  assert.equal(diverging.plan.directive, "TRIM");
  assert.equal(diverging.plan.persistence_rule, "fresh_signal");
  assert.equal(diverging.plan.trim_plan?.target_units, 1);
});
