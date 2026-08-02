import { requireNum } from "./metrics.js";
/**
 * In-file floors for params the resolution chain did not supply. The chain is
 * cluster_param → global_param → domain/params.ts DEFAULT_PARAMS, so these
 * only bind when neither the deployment nor the defaults were changed —
 * they are the last resort, not the source of tuning: real defaults live in
 * DEFAULT_PARAMS and are what tests pin.
 */
const SCREEN_THRESHOLD_FALLBACK = 1.0;
const BETA_FACTOR_FALLBACK = 1.0;
/**
 * Screening: score is 1..10, confidence is 0..1, and screen_score is
 * score * confidence. The asset flags when screen_score >= screen_threshold.
 * The threshold is returned as a result so it is snapshotted with the row —
 * retuning `screen_threshold` later must not rewrite history.
 *
 * The screen also stores the regime source it used: if the asset belongs to a
 * cluster, the cluster read's `regime` metric is preferred; otherwise the
 * macro read's `regime` is used. From that source it derives `regime_smile`
 * using `beta_factor`, which scoring later reads to judge top-down alignment.
 */
export function deriveScreen(metrics, macro, cluster, params) {
    const score = requireNum(metrics, "score", 1, 10);
    const confidence = requireNum(metrics, "confidence", 0, 1);
    const threshold = params["screen_threshold"] ?? SCREEN_THRESHOLD_FALLBACK;
    const screenScore = score * confidence;
    const regimeSource = cluster ?? macro;
    const regime = requireNum(regimeSource.metrics, "regime", -2, 2);
    const betaFactor = params["beta_factor"] ?? BETA_FACTOR_FALLBACK;
    const regimeSmile = computeRegimeSmile(regime, betaFactor);
    return {
        flagged: screenScore >= threshold,
        results: {
            screen_score: screenScore,
            threshold,
            regime,
            beta_factor: betaFactor,
            regime_smile: regimeSmile,
        },
    };
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
