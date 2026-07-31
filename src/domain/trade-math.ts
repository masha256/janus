export type UnitRow = {
  seq: number;
  entry_price: number;
  notional: number;
  risk: number;
  stop: number;
  status: "open" | "closed";
  exit_price: number | null;
};

export type TradeSummary = {
  open_units: number;
  closed_units: number;
  total_notional: number;
  avg_entry: number | null;
  open_risk: number;
  realized_pnl: number;
  r_multiple: number | null;
};

const sizeOf = (u: UnitRow): number => u.notional / u.entry_price;

/**
 * Everything here is computed on read. Nothing is stored denormalized, so
 * correcting a unit can never leave a stale total behind.
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

  return {
    open_units: open.length,
    closed_units: closed.length,
    total_notional,
    avg_entry: openSize === 0 ? null : total_notional / openSize,
    open_risk,
    realized_pnl,
    r_multiple: closed.length === 0 || initialRisk === 0 ? null : realized_pnl / initialRisk,
  };
}
