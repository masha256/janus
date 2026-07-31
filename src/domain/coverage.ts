import { JanusError } from "../output.ts";
import type { Bar } from "../types.ts";
import type { Snapshot } from "../lighter/client.ts";
import { smaSeries, emaSeries } from "../indicators/ma.ts";
import { atr } from "../indicators/atr.ts";
import { maCross, priceVsMa } from "../indicators/cross.ts";

export type CoverageValues = {
  open: number; high: number; low: number; close: number; volume: number;
  mark_price: number | null; index_price: number | null; open_interest: number | null;
  daily_change_pct: number | null;
  sma20: number | null; sma50: number | null; sma200: number | null;
  ema12: number | null; ema26: number | null; atr14: number | null;
  px_vs_sma20: number | null; px_vs_sma50: number | null; px_vs_sma200: number | null;
  cross_50_200: "golden" | "death" | null; cross_50_200_age: number | null;
  cross_px_50: "above" | "below" | null; cross_px_50_age: number | null;
  bars_available: number; fetched_at: string;
};

const lastOf = (series: (number | null)[]): number | null => series.at(-1) ?? null;

/** Signed percentage distance from price to a moving average. */
const distance = (close: number, ma: number | null): number | null =>
  ma === null || ma === 0 ? null : ((close - ma) / ma) * 100;

export function computeCoverage(bars: Bar[], snapshot: Snapshot, fetchedAt: string): CoverageValues {
  const latest = bars.at(-1);
  if (latest === undefined) {
    throw new JanusError("INSUFFICIENT_HISTORY", "no daily bars returned for this market");
  }

  const closes = bars.map((b) => b.c);
  const sma20s = smaSeries(closes, 20);
  const sma50s = smaSeries(closes, 50);
  const sma200s = smaSeries(closes, 200);
  const cross = maCross(sma50s, sma200s);
  const side = priceVsMa(closes, sma50s);

  const sma20 = lastOf(sma20s);
  const sma50 = lastOf(sma50s);
  const sma200 = lastOf(sma200s);

  return {
    open: latest.o, high: latest.h, low: latest.l, close: latest.c, volume: latest.v,
    mark_price: snapshot.mark_price,
    index_price: snapshot.index_price,
    open_interest: snapshot.open_interest,
    daily_change_pct: snapshot.daily_price_change,
    sma20, sma50, sma200,
    ema12: lastOf(emaSeries(closes, 12)),
    ema26: lastOf(emaSeries(closes, 26)),
    atr14: atr(bars, 14),
    px_vs_sma20: distance(latest.c, sma20),
    px_vs_sma50: distance(latest.c, sma50),
    px_vs_sma200: distance(latest.c, sma200),
    cross_50_200: cross.state,
    cross_50_200_age: cross.age,
    cross_px_50: side.state,
    cross_px_50_age: side.age,
    bars_available: bars.length,
    fetched_at: fetchedAt,
  };
}
