import { JanusError } from "../output.ts";

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/**
 * v1 placeholder. `d` is the weighted mean of the factors; `conv` rewards signal
 * strength and inter-factor agreement equally. Replacing this is a single-file
 * change — nothing outside reads the formula.
 */
export function deriveScore(
  factors: Record<string, number>,
  params: Record<string, number>,
): { d: number; conv: number; applied: Record<string, number> } {
  const applied: Record<string, number> = {};
  for (const [key, value] of Object.entries(factors)) {
    if (!Number.isFinite(value) || value < -2 || value > 2) {
      throw new JanusError("VALIDATION", `factor ${key} must be between -2 and 2, got ${value}`);
    }
    applied[key] = params[`w_${key}`] ?? 0;
  }

  const weighted = Object.entries(applied).filter(([, w]) => w !== 0);
  const totalWeight = weighted.reduce((a, [, w]) => a + Math.abs(w), 0);
  if (totalWeight === 0) return { d: 0, conv: 1, applied };

  const d = clamp(
    weighted.reduce((a, [k, w]) => a + w * factors[k]!, 0) / totalWeight,
    -2,
    2,
  );
  const agree =
    Math.abs(weighted.reduce((a, [k, w]) => a + Math.sign(w * factors[k]!) * Math.abs(w), 0)) /
    totalWeight;
  const conv = clamp(Math.round(1 + 9 * (0.5 * (Math.abs(d) / 2) + 0.5 * agree)), 1, 10);

  return { d, conv, applied };
}
