import { requireNum } from "./metrics.js";
/**
 * Screening: score is 1..10, confidence is 0..1, and screen_score is
 * score * confidence. The asset flags when screen_score >= screen_threshold.
 * The threshold is returned as a result so it is snapshotted with the row —
 * retuning `screen_threshold` later must not rewrite history.
 */
export function deriveScreen(metrics, params) {
    const score = requireNum(metrics, "score", 1, 10);
    const confidence = requireNum(metrics, "confidence", 0, 1);
    const threshold = params["screen_threshold"] ?? 1.0;
    const screenScore = score * confidence;
    return { flagged: screenScore >= threshold, results: { screen_score: screenScore, threshold } };
}
