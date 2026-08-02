import { type Metrics, requireNum } from "./metrics.ts";

/** Everything a completed read carries: what it observed, and what it concluded. */
export type Read = { metrics: Metrics; results: Metrics };

/**
 * The macro read: a single `regime` metric in -2..2. No derived results are
 * produced yet; the result table stays empty until the scoring layer needs it.
 */
export function deriveMacroRead(metrics: Metrics, _params: Record<string, number>): Metrics {
  requireNum(metrics, "regime", -2, 2);
  return {};
}

/**
 * A cluster read: stores its own view of the top-down regime as `regime`
 * in -2..2. It deliberately does not compute `regime_smile`; that calculation
 * moves to the screen phase, which can pick the cluster view when one exists
 * and fall back to the macro view otherwise.
 */
export function deriveClusterRead(
  metrics: Metrics,
  _macro: Read,
  _params: Record<string, number>,
): Metrics {
  requireNum(metrics, "regime", -2, 2);
  return {};
}
