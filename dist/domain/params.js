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
export const DEFAULT_PARAMS = {
    beta_factor: 1.0,
    screen_threshold: 1.0,
    w_catalyst: 0.25,
    w_sentiment: 0.25,
    w_trend: 0.3,
    w_regime: 0.15,
    w_secular: 0.05,
    fear_premium: 1.25,
    divergence_boost: 0.5,
    min_history_bars: 200,
    max_units: 3,
    // signalGate — strength and conviction thresholds.
    signal_strength_initiate: 1.0,
    signal_conviction_initiate: 6,
    signal_strength_add: 1.0,
    signal_conviction_add: 7,
    signal_strength_exit: 1.0,
    // persistenceGate — how many run-days the signalGate must have passed.
    signal_persist_days: 1,
    // trendGate — MA cushions and late-trend caution thresholds.
    trend_sma20_cushion_long: 0,
    trend_sma20_cushion_short: 0,
    trend_sma50_cushion_long: 1.0,
    trend_sma50_cushion_short: -1.0,
    require_golden_for_long: 1,
    require_death_for_short: 1,
    late_trend_ma_distance: 20,
    late_trend_crowding_extreme: 85,
    // binaryGate — cooldown after a known binary event.
    binary_cooldown_days: 14,
    // flipflopGate — cooldown and opposite-direction re-entry rules.
    flipflop_cooldown_days: 5,
    flipflop_opposite_strength_min: 0.6,
    flipflop_opposite_persist_days: 3,
    // heatGate — account-level risk heat and per-position sizing caps.
    account_capital: 100000,
    max_heat_pct: 15,
    per_trade_max_risk_pct: 5,
    per_asset_max_notional_pct: 20,
    // stop-ladder defaults.
    stop_atr_multiple: 2,
    breakeven_trigger_r: 1,
    partial_trigger_r: 1.5,
    partial_exit_fraction: 0.5,
    trailing_atr_multiple: 2,
    max_time_stop_days: 42,
    // directive ladder — regime triggers and persistence actionability.
    conv_hold: 4,
    regime_trigger_long_max: 1.5,
    regime_trigger_short_min: -1.5,
    regime_force_exit_threshold: 1.8,
    actionable_catalyst_min: 1.5,
    actionable_strength_delta: 1.5,
};
export function resolveParams(cluster, global) {
    return { ...DEFAULT_PARAMS, ...global, ...cluster };
}
