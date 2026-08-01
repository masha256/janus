/**
 * Hardcoded floor of the cluster-first / global-fallback chain. A factor weight
 * absent from every layer means that factor is recorded but does not move `d`.
 */
export const DEFAULT_PARAMS = {
    beta_factor: 1.0,
    screen_threshold: 1.0,
    w_catalyst: 1.0,
    w_sentiment: 1.0,
    w_trend: 1.0,
    w_secular: 1.0,
    max_units: 3,
};
export function resolveParams(cluster, global) {
    return { ...DEFAULT_PARAMS, ...global, ...cluster };
}
