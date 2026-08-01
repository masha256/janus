import { requireNum } from "./metrics.js";
/**
 * The macro read: a single `regime` metric in -2..2. No derived results are
 * produced yet; the result table stays empty until the scoring layer needs it.
 */
export function deriveMacroRead(metrics, _params) {
    requireNum(metrics, "regime", -2, 2);
    return {};
}
/**
 * A cluster read: the session's macro `regime` transformed into a bounded
 * `regime_smile` using `beta_factor`. The cluster read records no other derived
 * result.
 */
export function deriveClusterRead(_metrics, macro, params) {
    const regime = requireNum(macro.metrics, "regime", -2, 2);
    const beta = params["beta_factor"] ?? 1.0;
    return { regime_smile: computeRegimeSmile(regime, beta) };
}
function computeRegimeSmile(regime, beta) {
    const absR = Math.abs(regime);
    const core = 0.6 * regime * beta;
    if (absR < 1.3)
        return core;
    if (absR > 1.7)
        return -Math.sign(regime) * 1.2;
    const t = (absR - 1.3) / 0.4;
    const extreme = -Math.sign(regime) * 1.2;
    return (1 - t) * core + t * extreme;
}
