import { JanusError } from "../output.js";
import { num } from "./metrics.js";
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
/**
 * v1 placeholder. `strength` is the weighted mean of the metrics; `conviction`
 * rewards signal strength and inter-metric agreement equally. The context is
 * reported on rather than acted on: the weighted mean stands on its own, and
 * the alignment flags record whether the top-down reads back it up.
 *
 * `directive` is a stub — every score returns NONE until the real ladder lands.
 * When it does, it belongs here, with the whole context already in hand.
 *
 * Replacing any of this is a single-file change — nothing outside reads it.
 */
export function deriveScore(metrics, context, params) {
    // A score metric has to be a number in range — this formula takes a weighted
    // mean of them. Narrowing here is what lets the rest do arithmetic safely.
    const values = {};
    const applied = {};
    for (const [key, value] of Object.entries(metrics)) {
        if (typeof value !== "number" || !Number.isFinite(value) || value < -2 || value > 2) {
            throw new JanusError("VALIDATION", `factor ${key} must be a number between -2 and 2, got ${value}`);
        }
        values[key] = value;
        applied[key] = params[`w_${key}`] ?? 0;
    }
    // The weight actually applied to each factor is a conclusion, not an
    // observation, so it rides along in the results.
    const weights = {};
    for (const [key, w] of Object.entries(applied))
        weights[`w_${key}`] = w;
    const weighted = Object.entries(applied).filter(([, w]) => w !== 0);
    const totalWeight = weighted.reduce((a, [, w]) => a + Math.abs(w), 0);
    if (totalWeight === 0) {
        return {
            strength: 0,
            conviction: 1,
            directive: deriveDirective(),
            results: { ...weights, ...alignment(0, context) },
        };
    }
    const strength = clamp(weighted.reduce((a, [k, w]) => a + w * values[k], 0) / totalWeight, -2, 2);
    const agree = Math.abs(weighted.reduce((a, [k, w]) => a + Math.sign(w * values[k]) * Math.abs(w), 0)) /
        totalWeight;
    const conviction = clamp(Math.round(1 + 9 * (0.5 * (Math.abs(strength) / 2) + 0.5 * agree)), 1, 10);
    return {
        strength,
        conviction,
        directive: deriveDirective(),
        results: { ...weights, ...alignment(strength, context) },
    };
}
/**
 * Stub. The ladder that turns strength, conviction, and the open position into
 * INITIATE/ADD/HOLD/TRIM/EXIT is still to be written; until then every score
 * concludes NONE rather than guessing.
 *
 * ponytail: stubbed directive. The `d_*`, `conv_*`, and `max_units` parameters
 * are reserved for the real ladder and read by nothing until it lands — delete
 * them from DEFAULT_PARAMS if it turns out they are not the shape it wants.
 */
function deriveDirective() {
    return "NONE";
}
/**
 * Does the session's top-down read back this decision up? 1 when the tilt
 * agrees in direction, 0 when it does not or when either side is flat. An
 * unclustered asset has no cluster read, so `cluster_aligned` stays 0.
 */
function alignment(strength, context) {
    const agrees = (tilt) => Math.sign(strength) !== 0 && Math.sign(strength) === Math.sign(tilt) ? 1 : 0;
    return {
        macro_aligned: agrees(num(context.macro.results, "tilt")),
        cluster_aligned: context.cluster === null ? 0 : agrees(num(context.cluster.results, "tilt")),
    };
}
