import type { UnitRow } from "./trade-math.ts";

export type SizingInputs = {
  capital: number;
  maxRiskPct: number;
  conviction: number;
  stopDistancePct: number;
  perAssetMaxNotionalPct: number;
};

export type SizingResult = {
  riskDollars: number;
  positionSizeDollars: number;
  cappedPositionSizeDollars: number;
  perAssetCapDollars: number;
  heatDollars: number;
};

/**
 * Position sizing based on risk and stop distance.
 *
 * Risk $  = Capital × Max Risk % × (Conviction / 10)
 * Size $  = Risk $ / Stop Distance %
 * Heat $  = Risk $  (before the stop moves to breakeven)
 */
export function sizeFromRiskAndStop(inputs: SizingInputs): SizingResult {
  const { capital, maxRiskPct, conviction, stopDistancePct, perAssetMaxNotionalPct } = inputs;
  const riskDollars = capital * (maxRiskPct / 100) * (conviction / 10);
  const positionSizeDollars = stopDistancePct > 0 ? riskDollars / stopDistancePct : 0;
  const perAssetCapDollars = capital * (perAssetMaxNotionalPct / 100);
  return {
    riskDollars,
    positionSizeDollars,
    cappedPositionSizeDollars: Math.min(positionSizeDollars, perAssetCapDollars),
    perAssetCapDollars,
    heatDollars: riskDollars,
  };
}

/**
 * Derive a stop price from an ATR-based stop distance.
 */
export function stopFromAtr(
  entry: number,
  atr: number,
  multiple: number,
  side: "long" | "short",
): number {
  const distance = atr * multiple;
  return side === "long" ? entry - distance : entry + distance;
}

/**
 * Stop distance as a fraction of entry price, always positive.
 */
export function stopDistancePct(entry: number, stop: number, side: "long" | "short"): number {
  if (entry <= 0) return 0;
  const raw = side === "long" ? (entry - stop) / entry : (stop - entry) / entry;
  return Math.max(0, raw);
}

/**
 * Heat for a single unit, floored at zero (breakeven or better stops contribute no heat).
 */
export function unitHeat(unit: UnitRow, direction: "long" | "short"): number {
  const sign = direction === "long" ? 1 : -1;
  const size = unit.notional / unit.entry_price;
  const distance = (unit.entry_price - unit.stop) * sign;
  return Math.max(0, size * distance);
}

/**
 * Total heat across a set of units. A closed unit contributes no heat.
 */
export function unitsHeat(units: UnitRow[], direction: "long" | "short"): number {
  return units
    .filter((u) => u.status === "open")
    .reduce((sum, u) => sum + unitHeat(u, direction), 0);
}

/**
 * Sum of risk dollars across multiple open trades.
 * Each trade object supplies its direction and open units.
 */
export function bookHeat(
  trades: { direction: "long" | "short"; units: UnitRow[] }[],
): number {
  return trades.reduce((sum, t) => sum + unitsHeat(t.units, t.direction), 0);
}
