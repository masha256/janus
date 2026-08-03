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
 * Directive ladder thresholds are also here. `strength_*` are on the same ±2
 * strength scale as the score; `conv_*` are on the 1..10 conviction scale.
 * Trend gate parameters make the MA structure a hard entry/scaling condition,
 * while regime trigger thresholds keep the extreme-contrarian override configurable.
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
    // Directive ladder (strength is -2..2, conviction is 1..10).
    strength_initiate: 1.0,
    conv_initiate: 6,
    strength_add: 1.0,
    conv_add: 7,
    conv_hold: 4,
    strength_exit: 1.0,
    // Trend gate as hard condition, not a factor.
    trend_gate_long: 1.0, // min px_vs_sma50 % to allow long entry/add
    trend_gate_short: -1.0, // max px_vs_sma50 % to allow short entry/add
    require_golden_for_long: 1, // 1 = true: forbid long when 50/200 is death
    require_death_for_short: 1, // 1 = true: forbid short when 50/200 is golden
    // Regime extreme-contrarian trigger thresholds.
    regime_trigger_long_max: 1.5, // block new longs when regime_smile >= this
    regime_trigger_short_min: -1.5, // block new shorts when regime_smile <= this
    regime_force_exit_threshold: 1.8, // force EXIT when regime_smile exceeds this against position
    // Persistence / anti flip-flop.
    flip_flop_lookback_days: 5,
    actionable_catalyst_min: 1.5,
    actionable_strength_delta: 2.5,
};
export function resolveParams(cluster, global) {
    return { ...DEFAULT_PARAMS, ...global, ...cluster };
}
