import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCoverage } from "./coverage.js";
const FETCHED = "2026-07-31T12:00:00Z";
const snapshot = {
    mark_price: 101, index_price: 100.5, last_trade_price: 101,
    daily_price_low: 99, daily_price_high: 102, daily_price_change: 1.25, open_interest: 5000,
};
/** A rising series: close goes 100, 101, 102 ... so every MA sits below price. */
const rising = (n) => Array.from({ length: n }, (_, i) => ({
    t: 1_700_000_000_000 + i * 86_400_000,
    o: 100 + i, h: 101 + i, l: 99 + i, c: 100 + i, v: 10, i: 1000,
}));
test("uses the last bar for the OHLCV columns", () => {
    const c = computeCoverage(rising(5), snapshot, FETCHED);
    assert.equal(c.close, 104);
    assert.equal(c.high, 105);
    assert.equal(c.low, 103);
    assert.equal(c.bars_available, 5);
    assert.equal(c.fetched_at, FETCHED);
});
test("copies the snapshot fields through", () => {
    const c = computeCoverage(rising(5), snapshot, FETCHED);
    assert.equal(c.mark_price, 101);
    assert.equal(c.index_price, 100.5);
    assert.equal(c.open_interest, 5000);
    assert.equal(c.daily_change_pct, 1.25);
});
test("indicators are null until enough history exists", () => {
    const c = computeCoverage(rising(30), snapshot, FETCHED);
    assert.notEqual(c.sma20, null, "20 bars is enough for sma20");
    assert.equal(c.sma50, null, "30 bars is not enough for sma50");
    assert.equal(c.sma200, null);
    assert.equal(c.px_vs_sma50, null, "distance is null when the ma is null");
    assert.equal(c.cross_50_200, null);
});
test("a full history populates every indicator", () => {
    const c = computeCoverage(rising(250), snapshot, FETCHED);
    for (const k of ["sma20", "sma50", "sma200", "ema12", "ema26", "atr14"]) {
        assert.notEqual(c[k], null, `${k} should be computed`);
    }
    assert.equal(c.cross_50_200, "golden", "a rising series keeps sma50 above sma200");
    assert.equal(c.cross_px_50, "above");
    assert.ok(c.px_vs_sma20 > 0, "price above its ma yields a positive distance");
});
test("percentage distance is signed and expressed in percent", () => {
    const c = computeCoverage(rising(250), snapshot, FETCHED);
    // close 349, sma20 = mean(330..349) = 339.5 → (349 - 339.5) / 339.5 * 100
    assert.equal(Number(c.px_vs_sma20.toFixed(4)), Number((((349 - 339.5) / 339.5) * 100).toFixed(4)));
});
test("an empty bar list is rejected rather than written as a hole", () => {
    assert.throws(() => computeCoverage([], snapshot, FETCHED), (e) => e.code === "INSUFFICIENT_HISTORY");
});
