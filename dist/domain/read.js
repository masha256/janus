import { num, requireNum, requireText } from "./metrics.js";
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
/**
 * v1 placeholders, in the spirit of deriveScore: each takes the raw metric bag
 * as recorded and returns the bag to serialize into the matching `_read_result`
 * table. Every constant is a tunable parameter, so calibration does not need a
 * code change, and replacing either formula is a single-file edit — nothing
 * outside reads them.
 */
/**
 * The macro read: how far to lean, and how much risk that justifies. This
 * formula needs `score` and `confidence`; a different one would need something
 * else, which is why the requirement lives here and not in the CLI.
 */
export function deriveMacroRead(metrics, params) {
    const score = requireNum(metrics, "score", -2, 2);
    const confidence = requireNum(metrics, "confidence", 0, 2);
    // confidence runs 0..2, so half of it is a 0..1 haircut on the raw score:
    // a 2.0 conviction read keeps its score, a 0.0 one concludes nothing.
    const tilt = clamp(score * (confidence / 2), -2, 2);
    const budget = params["risk_budget_base"] + params["risk_budget_tilt"] * tilt;
    return { tilt, risk_budget: clamp(budget, 0, 1) };
}
/**
 * A cluster read: its own bias blended with the session's macro tilt, so a
 * constructive cluster in a hostile tape lands somewhere honest in between.
 * `aligned` is 1 only when cluster and macro genuinely agree on direction.
 * The whole macro read is in hand, metrics included, for formulas that want
 * more than the tilt.
 */
export function deriveClusterRead(metrics, macro, params) {
    const bias = requireNum(metrics, "bias", -2, 2);
    requireText(metrics, "judgement");
    const macroTilt = num(macro.results, "tilt");
    const wBias = params["cluster_bias_weight"];
    const wMacro = params["cluster_macro_weight"];
    const total = Math.abs(wBias) + Math.abs(wMacro);
    const tilt = total === 0 ? 0 : clamp((wBias * bias + wMacro * macroTilt) / total, -2, 2);
    const aligned = Math.sign(bias) !== 0 && Math.sign(bias) === Math.sign(macroTilt) ? 1 : 0;
    return { tilt, aligned };
}
