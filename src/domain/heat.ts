/**
 * Portfolio heat, as a report rather than a gate.
 *
 * The numbers here must agree with `heatGate` by construction, not by
 * coincidence: both read the same `bookHeat` sum, and both treat "no capital
 * declared" as non-blocking. A report that computed heat its own way would
 * eventually claim there is headroom on a morning the gate is refusing entries.
 */
import { daysBetween } from "./session.ts";

/** One open trade, flattened for the report. */
export type BookPosition = {
  symbol: string;
  cluster_key: string | null;
  direction: "long" | "short";
  open_units: number;
  /** Total notional across the trade's open units. */
  notional: number;
  heat: number;
  /** Entry date of the longest-held open unit; null if the trade has none. */
  first_entry_on: string | null;
};

export type AssetHeat = BookPosition & {
  /** Notional cap in dollars, or null when no capital is declared. */
  notional_cap: number | null;
  notional_used_pct: number | null;
  within_notional_cap: boolean;
  /** Open units whose stops are all at breakeven or better carry no heat. */
  free_carry: boolean;
  /**
   * Calendar days since the longest-held open unit was entered — the same
   * clock the time stop reads, so a position nearing `max_time_stop_days` is
   * visible here before the ladder acts on it.
   */
  days_in_trade: number | null;
};

export type ClusterHeat = {
  cluster_key: string | null;
  positions: number;
  notional: number;
  heat: number;
  /** This cluster's share of total book heat. Null when the book is flat or all free carry. */
  share_of_book_pct: number | null;
};

export type HeatReport = {
  capital: number;
  /**
   * False when `account_capital` is 0 or unset. Every limit below is null and
   * every verdict is `true` in that case — the same "warn but do not block"
   * stance heatGate takes, so the report never reads stricter than the gate.
   */
  capital_declared: boolean;
  book: {
    heat: number;
    notional: number;
    max_heat_pct: number;
    limit: number | null;
    used_pct: number | null;
    headroom: number | null;
    within_limit: boolean;
  };
  clusters: ClusterHeat[];
  assets: AssetHeat[];
  /** Every guard that is currently breached, named. Empty means all clear. */
  breaches: string[];
};

const pct = (part: number, whole: number): number | null =>
  whole > 0 ? (part / whole) * 100 : null;

export function deriveHeatReport(
  positions: BookPosition[],
  params: Record<string, number>,
  today: string,
): HeatReport {
  const capital = params["account_capital"] ?? 0;
  const maxHeatPct = params["max_heat_pct"] ?? 100;
  const perAssetPct = params["per_asset_max_notional_pct"] ?? 20;
  const declared = capital > 0;

  const bookHeat = positions.reduce((a, p) => a + p.heat, 0);
  const bookNotional = positions.reduce((a, p) => a + p.notional, 0);
  const heatLimit = declared ? capital * (maxHeatPct / 100) : null;
  const notionalCap = declared ? capital * (perAssetPct / 100) : null;

  const breaches: string[] = [];
  const withinBookLimit = heatLimit === null || bookHeat <= heatLimit;
  if (!withinBookLimit) {
    breaches.push(`book heat ${bookHeat.toFixed(0)} over the ${heatLimit!.toFixed(0)} limit`);
  }

  const assets: AssetHeat[] = positions.map((p) => {
    const within = notionalCap === null || p.notional <= notionalCap;
    if (!within) {
      breaches.push(
        `${p.symbol} notional ${p.notional.toFixed(0)} over the ${notionalCap!.toFixed(0)} per-asset cap`,
      );
    }
    return {
      ...p,
      notional_cap: notionalCap,
      notional_used_pct: notionalCap === null ? null : pct(p.notional, notionalCap),
      within_notional_cap: within,
      free_carry: p.open_units > 0 && p.heat === 0,
      days_in_trade: p.first_entry_on === null ? null : daysBetween(today, p.first_entry_on),
    };
  });

  const byCluster = new Map<string | null, ClusterHeat>();
  for (const p of positions) {
    const key = p.cluster_key;
    const row = byCluster.get(key) ??
      { cluster_key: key, positions: 0, notional: 0, heat: 0, share_of_book_pct: null };
    row.positions += 1;
    row.notional += p.notional;
    row.heat += p.heat;
    byCluster.set(key, row);
  }
  const clusters = [...byCluster.values()]
    .map((c) => ({ ...c, share_of_book_pct: pct(c.heat, bookHeat) }))
    .sort((a, b) => b.heat - a.heat);

  return {
    capital,
    capital_declared: declared,
    book: {
      heat: bookHeat,
      notional: bookNotional,
      max_heat_pct: maxHeatPct,
      limit: heatLimit,
      used_pct: heatLimit === null ? null : pct(bookHeat, heatLimit),
      headroom: heatLimit === null ? null : heatLimit - bookHeat,
      within_limit: withinBookLimit,
    },
    clusters,
    assets,
    breaches,
  };
}
