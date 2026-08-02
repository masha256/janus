/**
 * Hardcoded floor of the cluster-first / global-fallback chain. A factor weight
 * absent from every layer means that factor is recorded but does not move `d`.
 */
export const DEFAULT_PARAMS = {
    beta_factor: 1.0,
    screen_threshold: 1.0,
    w_catalyst: 0.3,
    w_sentiment: 0.25,
    w_trend: 0.25,
    w_regime: 0.15,
    w_secular: 0.05,
    max_units: 3,
};
export function resolveParams(cluster, global) {
    return { ...DEFAULT_PARAMS, ...global, ...cluster };
}
