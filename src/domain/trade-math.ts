export type UnitRow = {
  seq: number;
  entry_price: number;
  notional: number;
  risk: number;
  stop: number;
  status: "open" | "closed";
  exit_price: number | null;
  funding: number;
  tag: string | null;
  // Sizing / ladder fields (optional for backwards compatibility).
  partial_exited?: number;
  breakeven_moved_at?: string | null;
  time_stop_date?: string | null;
};

export type TradeSummary = {
  open_units: number;
  closed_units: number;
  total_notional: number;
  avg_entry: number | null;
  open_risk: number;
  realized_pnl: number;
  total_funding: number;
  net_pnl: number;
  r_multiple: number | null;
  net_r_multiple: number | null;
};

const sizeOf = (u: UnitRow): number => u.notional / u.entry_price;

/**
 * Heat for a unit, floored at zero. A stop at or beyond entry contributes
 * no heat, matching the idea that breakeven/favorable stops free up capacity.
 */
export function unitHeat(unit: UnitRow, direction: "long" | "short"): number {
  const sign = direction === "long" ? 1 : -1;
  const size = sizeOf(unit);
  return Math.max(0, size * (unit.entry_price - unit.stop) * sign);
}

/**
 * Total heat across open units. Closed units contribute nothing.
 */
export function unitsHeat(units: UnitRow[], direction: "long" | "short"): number {
  return units
    .filter((u) => u.status === "open")
    .reduce((sum, u) => sum + unitHeat(u, direction), 0);
}

/**
 * Everything here is computed on read. Nothing is stored denormalized, so
 * correcting a unit can never leave a stale total behind.
 *
 * Funding is measured at exit, not forecast at entry. It is folded into
 * `net_pnl` and `net_r_multiple` while `realized_pnl` and `r_multiple` stay
 * price-only so an operator can compare edge versus carry separately.
 */
export function tradeSummary(
  direction: "long" | "short",
  initialRisk: number,
  units: UnitRow[],
): TradeSummary {
  const sign = direction === "long" ? 1 : -1;
  const open = units.filter((u) => u.status === "open");
  const closed = units.filter((u) => u.status === "closed");

  const total_notional = open.reduce((a, u) => a + u.notional, 0);
  const openSize = open.reduce((a, u) => a + sizeOf(u), 0);
  const open_risk = open.reduce((a, u) => a + sizeOf(u) * (u.entry_price - u.stop) * sign, 0);
  const realized_pnl = closed.reduce(
    (a, u) => a + sizeOf(u) * ((u.exit_price ?? u.entry_price) - u.entry_price) * sign,
    0,
  );
  const total_funding = closed.reduce((a, u) => a + (u.funding ?? 0), 0);
  const net_pnl = realized_pnl + total_funding;

  return {
    open_units: open.length,
    closed_units: closed.length,
    total_notional,
    avg_entry: openSize === 0 ? null : total_notional / openSize,
    open_risk,
    realized_pnl,
    total_funding,
    net_pnl,
    r_multiple: closed.length === 0 || initialRisk === 0 ? null : realized_pnl / initialRisk,
    net_r_multiple: closed.length === 0 || initialRisk === 0 ? null : net_pnl / initialRisk,
  };
}
