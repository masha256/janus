import { JanusError } from "../output.js";
import { smaSeries, emaSeries } from "../indicators/ma.js";
import { atr } from "../indicators/atr.js";
import { maCross, priceVsMa } from "../indicators/cross.js";
const NO_FUNDING = { funding_rate: null, funding_ref: null };
/**
 * Lighter's own funding rate plus the median rate across the external
 * reference venues (`/funding-rates` carries binance/bybit/hyperliquid rows
 * for the same market). The median of the deep venues is the crowding
 * anchor; Lighter's own rate is the carry actually paid on the position and,
 * against the reference, a local-crowding divergence signal.
 */
export function deriveFundingPair(rows, marketId) {
    const forMarket = rows.filter((r) => r.market_id === marketId && r.rate !== null);
    const own = forMarket.find((r) => r.exchange === "lighter")?.rate ?? null;
    const ext = forMarket
        .filter((r) => r.exchange !== "lighter")
        .map((r) => r.rate)
        .sort((a, b) => a - b);
    const mid = ext.length === 0
        ? null
        : ext.length % 2 === 1
            ? ext[(ext.length - 1) / 2]
            : (ext[ext.length / 2 - 1] + ext[ext.length / 2]) / 2;
    return { funding_rate: own, funding_ref: mid };
}
const lastOf = (series) => series.at(-1) ?? null;
/** Signed percentage distance from price to a moving average. */
const distance = (close, ma) => ma === null || ma === 0 ? null : ((close - ma) / ma) * 100;
/** `funding` defaults to nulls: backfills and hand-written rows have no funding history to reconstruct. */
export function computeCoverage(bars, snapshot, fetchedAt, funding = NO_FUNDING) {
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
        funding_rate: funding.funding_rate,
        funding_ref: funding.funding_ref,
        bars_available: bars.length,
        fetched_at: fetchedAt,
    };
}
/** A bar's UTC calendar day. Lighter's daily candles are UTC-aligned. */
const barDate = (b) => new Date(b.t).toISOString().slice(0, 10);
/**
 * Rebuild the inputs `computeCoverage` needs for a *past* session date.
 *
 * A plain coverage run always reads the newest bar and a live snapshot, so
 * pointing it at an old date stamps today's prices under that date and quietly
 * invents history. Bars carry their own timestamps, though, and a run already
 * pulls ~400 days of them — so everything bar-derived (OHLC, the SMAs, ATR, the
 * MA distances and crosses) can be reconstructed exactly.
 *
 * The snapshot cannot: it is point-in-time with no history. What survives is
 * what the bar itself implies — the close stands in as the mark, since for a
 * daily-bar swing system that *is* the day's reference price, and it keeps the
 * stop ladder (which needs a mark to compute R) working on a backfilled day.
 * `open_interest` has no bar equivalent and stays null.
 *
 * Throws INSUFFICIENT_HISTORY when no bar is at or before the date, rather than
 * silently falling back to a later one.
 */
export function backfillInputs(bars, sessionDate) {
    const upTo = bars.filter((b) => barDate(b) <= sessionDate);
    const last = upTo.at(-1);
    if (last === undefined) {
        throw new JanusError("INSUFFICIENT_HISTORY", `no daily bar at or before ${sessionDate}; the window fetched starts later`);
    }
    const prior = upTo.at(-2);
    return {
        bars: upTo,
        snapshot: {
            mark_price: last.c,
            index_price: last.c,
            last_trade_price: last.c,
            daily_price_low: last.l,
            daily_price_high: last.h,
            daily_price_change: prior === undefined || prior.c === 0
                ? null
                : ((last.c - prior.c) / prior.c) * 100,
            open_interest: null,
        },
    };
}
