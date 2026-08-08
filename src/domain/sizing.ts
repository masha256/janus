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
 * Budget $ = Capital × Max Risk % × (Conviction / 10)
 * Size $   = Budget $ / Stop Distance %, capped at the per-asset notional cap
 * Risk $   = Size $ × Stop Distance %  (the budget only when the cap does not bind)
 * Heat $   = Risk $  (before the stop moves to breakeven)
 *
 * Risk is derived back from the *capped* size, never from the budget: a capped
 * position cannot lose the budget it was sized against. Reporting the budget
 * would overstate `initial_risk` — every R milestone in the ladder is measured
 * against it — and overcharge the heat gate.
 */
export function sizeFromRiskAndStop(inputs: SizingInputs): SizingResult {
  const { capital, maxRiskPct, conviction, stopDistancePct, perAssetMaxNotionalPct } = inputs;
  const budgetDollars = capital * (maxRiskPct / 100) * (conviction / 10);
  const positionSizeDollars = stopDistancePct > 0 ? budgetDollars / stopDistancePct : 0;
  const perAssetCapDollars = capital * (perAssetMaxNotionalPct / 100);
  const cappedPositionSizeDollars = Math.min(positionSizeDollars, perAssetCapDollars);
  const riskDollars = cappedPositionSizeDollars * stopDistancePct;
  return {
    riskDollars,
    positionSizeDollars,
    cappedPositionSizeDollars,
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

// Heat lives in trade-math.ts (unitHeat/unitsHeat) and db/repo/trade.ts
// (bookHeat, over the open book). This module sizes a position; it does not
// measure one.
