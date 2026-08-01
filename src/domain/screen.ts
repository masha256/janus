import { type Metrics, requireNum } from "./metrics.ts";

/**
 * v1 placeholder. An asset flags when its score reaches the threshold in force,
 * inclusively. The threshold is returned as a result so it is snapshotted with
 * the row — retuning `screen_flag_threshold` later must not rewrite history.
 * The metrics this needs are declared here, not in the CLI.
 */
export function deriveScreen(
  metrics: Metrics,
  params: Record<string, number>,
): { flagged: boolean; results: Metrics } {
  const score = requireNum(metrics, "score", -2, 2);
  requireNum(metrics, "confidence", 0, 2);
  const threshold = params["screen_flag_threshold"]!;
  return { flagged: score >= threshold, results: { threshold } };
}
