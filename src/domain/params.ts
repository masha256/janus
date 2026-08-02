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
 */
export const DEFAULT_PARAMS: Record<string, number> = {
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
};

export function resolveParams(
  cluster: Record<string, number>,
  global: Record<string, number>,
): Record<string, number> {
  return { ...DEFAULT_PARAMS, ...global, ...cluster };
}
