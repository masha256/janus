/**
 * Hardcoded floor of the cluster-first / global-fallback chain. A factor weight
 * absent from every layer means that factor is recorded but does not move `d`.
 */
export const DEFAULT_PARAMS = {
    d_initiate: 1.0,
    conv_initiate: 6,
    d_add: 1.0,
    conv_add: 7,
    conv_hold: 4,
    d_exit: 1.0,
    max_units: 4,
    screen_flag_threshold: 1.0,
    risk_budget_base: 0.5,
    risk_budget_tilt: 0.25,
    cluster_bias_weight: 1.0,
    cluster_macro_weight: 0.5,
    w_catalyst: 1.0,
    w_trend: 1.0,
    w_secular: 1.0,
    w_crowding: -1.0,
};
export function resolveParams(cluster, global) {
    return { ...DEFAULT_PARAMS, ...global, ...cluster };
}
