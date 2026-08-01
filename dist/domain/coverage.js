import { JanusError } from "../output.js";
import { smaSeries, emaSeries } from "../indicators/ma.js";
import { atr } from "../indicators/atr.js";
import { maCross, priceVsMa } from "../indicators/cross.js";
const lastOf = (series) => series.at(-1) ?? null;
/** Signed percentage distance from price to a moving average. */
const distance = (close, ma) => ma === null || ma === 0 ? null : ((close - ma) / ma) * 100;
export function computeCoverage(bars, snapshot, fetchedAt) {
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
