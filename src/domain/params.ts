/**
 * Hardcoded floor of the cluster-first / global-fallback chain. A factor weight
 * absent from every layer means that factor is recorded but does not move `d`.
 *
 * `fear_premium` scales the bullish side of the contrarian fade and
 * `divergence_boost` sizes the widening when a price/crowding divergence is
 * present; both live in `sentimentFromCrowding`. `min_history_bars` is the
 * roster entry requirement for assets added via `asset add` — anything shorter
 * cannot compute a 200-day MA, which a weeks-to-months swing thesis treats as
 * a hard gap.
 *
 * Gate parameters are also here. Each gate is a function in `domain/score.ts`
 * and reads its own thresholds from the resolved params.
 */
export const DEFAULT_PARAMS: Record<string, number> = {
  beta_factor: 1.0,
  screen_threshold: 4.0,
  // Contrarian lean: sentiment is the heaviest factor. Catalyst is deliberately
  // light — with a 10:00 ET news cutoff the system is structurally late to news.
  w_catalyst: 0.15,
  w_sentiment: 0.3,
  w_trend: 0.3,
  w_regime: 0.15,
  w_secular: 0.1,
  fear_premium: 1.25,
  divergence_boost: 0.5,
  min_history_bars: 200,
  max_units: 3,

  // signalGate — direction and conviction thresholds. Direction is the
  // selectivity lever; conviction is largely a function of |direction| already,
  // so its floor sits one notch below what a clean all-factors-aligned day
  // produces (~6) rather than exactly at it.
  signal_direction_initiate: 0.9,
  signal_conviction_initiate: 5,
  signal_direction_add: 1.0,
  signal_conviction_add: 6,
  signal_direction_exit: 1.0,

  // persistenceGate — how many run-days the signalGate must have passed.
  signal_persist_days: 2,

  // decayGate — conviction floor and how many run-days below it triggers decay.
  // The deadband is how far against us a prior day's direction must go to break
  // the streak; inside it the read is noise, not a flip.
  decay_conviction_floor: 4,
  decay_persist_days: 2,
  decay_direction_deadband: 0.1,

  // trendGate — explicit 20/50 MA band thresholds and late-trend caution.
  // Long: px_vs_sma20 > t20_long and px_vs_sma50 < t50_long -> starter;
  //       px_vs_sma20 > t20_long and px_vs_sma50 >= t50_long -> pass.
  // Short: px_vs_sma20 < t20_short and px_vs_sma50 > t50_short -> starter;
  //        px_vs_sma20 < t20_short and px_vs_sma50 <= t50_short -> pass.
  trend_sma20_threshold_long: 0,
  trend_sma50_threshold_long: 0,
  trend_sma20_threshold_short: 0,
  trend_sma50_threshold_short: 0,
  late_trend_ma_distance: 20,
  late_trend_crowding_extreme: 85,

  // binaryGate — cooldown after a known binary event.
  binary_cooldown_days: 14,

  // flipflopGate — cooldown and opposite-direction re-entry rules.
  flipflop_cooldown_days: 5,
  flipflop_opposite_direction_min: 0.6,
  flipflop_opposite_persist_days: 3,

  // heatGate — account-level risk heat and per-position sizing caps. The book
  // runs a few highly correlated clusters, so total heat is effectively one
  // position: keep it and the per-trade slice conservative.
  account_capital: 100000,
  max_heat_pct: 10,
  per_trade_max_risk_pct: 2.5,
  per_asset_max_notional_pct: 20,

  // Position sizing.
  // starter_size_fraction scales risk/notional when the trend gate returns starter.
  starter_size_fraction: 0.5,

  // stop-ladder defaults. The initial stop stays tight (2×ATR) but the runner
  // trail is wider (3×ATR): a weeks-to-months hold must survive normal
  // consolidations that a days-horizon trail would hand back.
  stop_atr_multiple: 2,
  breakeven_trigger_r: 1,
  partial_trigger_r: 1.5,
  partial_exit_fraction: 0.5,
  trailing_atr_multiple: 3,
  max_time_stop_days: 42,

  // directive ladder — regime triggers and persistence actionability.
  conv_hold: 4,
  regime_trigger_long_max: 1.5,
  regime_trigger_short_min: -1.5,
  regime_force_exit_threshold: 1.8,
  actionable_catalyst_min: 1.5,
  actionable_direction_delta: 1.5,
};

/**
 * Account-scope parameters the cluster rung must never override. heatGate
 * measures heat across the whole book, so a per-cluster ceiling would make the
 * same book pass or fail depending on which cluster's asset is being scored.
 * `cluster set-param` refuses these keys; the strip in resolveParams covers
 * rows written before that guard existed.
 */
export const GLOBAL_ONLY_PARAMS = new Set([
  "account_capital",
  "max_heat_pct",
  "per_trade_max_risk_pct",
]);

export function resolveParams(
  cluster: Record<string, number>,
  global: Record<string, number>,
): Record<string, number> {
  const clusterSafe = Object.fromEntries(
    Object.entries(cluster).filter(([k]) => !GLOBAL_ONLY_PARAMS.has(k)),
  );
  return { ...DEFAULT_PARAMS, ...global, ...clusterSafe };
}
