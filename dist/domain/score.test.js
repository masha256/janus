import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveScore } from "./score.js";
import { DEFAULT_PARAMS } from "./params.js";
/** A context that concludes nothing: the metrics alone decide strength and conviction. */
const flat = {
    macro: { metrics: {}, results: {} },
    cluster: null,
    screen: null,
    positions: [],
    asset: { symbol: "BTC", class: "crypto", cluster_id: null, coverage: null },
};
const ctx = (macroRegime, clusterRegime, confidence = 1) => ({
    ...flat,
    macro: { metrics: { regime: macroRegime }, results: {} },
    cluster: clusterRegime === null
        ? null
        : { metrics: { regime: clusterRegime }, results: { regime_smile: 0.6 * clusterRegime } },
    asset: { ...flat.asset, cluster_id: clusterRegime === null ? null : 1 },
    screen: { flagged: true, metrics: { score: 5, confidence }, results: { screen_score: 5 * confidence, threshold: 1 } },
});
function m(catalyst, trend, secular, crowding, capitulation, divergence) {
    return { catalyst, trend, secular, crowding, capitulation, divergence };
}
test("direction is the weighted sum of factors clamped to [-2, 2]", () => {
    const got = deriveScore(m(2, 1, -1, 50, false, false), flat, DEFAULT_PARAMS);
    // P=50 -> 40-65 band, trend>0 -> base=0.4
    // direction = 0.3*2 + 0.25*0.4 + 0.25*1 + 0.15*0 + 0.05*(-1) = 0.9
    assert.ok(Math.abs(got.strength - 0.9) < 1e-12, `got ${got.strength}`);
});
test("sentiment bands match the crowding lookup", () => {
    const cases = [
        [5, false, 2.0, "<=12 / capitulation - true panic"],
        [20, false, 1.0, "12-25 - fear"],
        [30, false, 0.5, "25-40 - getting fearful (linear)"],
        [50, false, 0.4, "40-65 - calm middle (+0.4 x sign(Trend))"],
        [75, false, -0.5, "65-85 - getting crowded (linear)"],
        [90, false, -1.5, "85-95 - greed, fade"],
        [98, false, -2.0, ">=95 - true euphoria, fade hard"],
    ];
    for (const [crowding, capitulation, expected, band] of cases) {
        const got = deriveScore(m(0, 1, 0, crowding, capitulation, false), flat, { ...DEFAULT_PARAMS, w_catalyst: 0, w_trend: 0, w_secular: 0, w_regime: 0, w_sentiment: 1 });
        assert.equal(got.strength, expected, `crowding ${crowding}`);
        assert.equal(got.results["sentiment_band"], band);
    }
});
test("divergence boosts the sentiment in the same direction", () => {
    const fearful = deriveScore(m(0, 1, 0, 20, false, false), flat, { ...DEFAULT_PARAMS, w_catalyst: 0, w_trend: 0, w_secular: 0, w_regime: 0, w_sentiment: 1 });
    assert.equal(fearful.strength, 1.0);
    const boosted = deriveScore(m(0, 1, 0, 20, false, true), flat, { ...DEFAULT_PARAMS, w_catalyst: 0, w_trend: 0, w_secular: 0, w_regime: 0, w_sentiment: 1 });
    assert.equal(boosted.strength, 1.5);
    assert.match(String(boosted.results["sentiment_band"]), /divergence booster/);
});
test("conviction formula uses |direction| and screen confidence", () => {
    const highConf = deriveScore(m(2, 0, 0, 50, false, false), ctx(0, null, 1), DEFAULT_PARAMS);
    const lowConf = deriveScore(m(2, 0, 0, 50, false, false), ctx(0, null, 0.5), DEFAULT_PARAMS);
    assert.ok(highConf.conviction >= lowConf.conviction, "higher confidence raises conviction");
});
test("deriveScore rejects invalid factors and crowding", () => {
    assert.throws(() => deriveScore(m(3, 0, 0, 50, false, false), flat, DEFAULT_PARAMS), /catalyst/);
    assert.throws(() => deriveScore(m(0, 0, 0, 0, false, false), flat, DEFAULT_PARAMS), /crowding/);
    assert.throws(() => deriveScore(m(0, 0, 0, 101, false, false), flat, DEFAULT_PARAMS), /crowding/);
});
test("top-down alignment uses regime_smile", () => {
    // With catalyst/trend/secular flat, direction is just w_regime * regime_smile.
    // Regime 1.5 -> regime_smile 0.9, so direction is positive and alignment is 1.
    const bullish = deriveScore(m(0, 0, 0, 50, false, false), ctx(1.5, 1.5, 1), { ...DEFAULT_PARAMS, w_regime: 5, w_sentiment: 0, w_catalyst: 0, w_trend: 0, w_secular: 0 });
    assert.ok(bullish.strength > 0, `strength ${bullish.strength}`);
    // Macro read carries no derived result, so it can never align.
    assert.equal(bullish.results["macro_aligned"], 0);
    assert.equal(bullish.results["cluster_aligned"], 1);
    // Regime -1.5 -> regime_smile -0.9; with catalyst flat the direction is negative
    // and cluster alignment is 1. Use a larger bullish catalyst with a smaller
    // regime weight to flip direction positive and make cluster alignment 0.
    const bearishContext = ctx(-1.5, -1.5, 1);
    const against = deriveScore(m(2, 0, 0, 50, false, false), bearishContext, { ...DEFAULT_PARAMS, w_regime: 0.5, w_sentiment: 0, w_catalyst: 1, w_trend: 0, w_secular: 0 });
    assert.ok(against.strength > 0, `strength ${against.strength}`);
    assert.equal(against.results["macro_aligned"], 0);
    assert.equal(against.results["cluster_aligned"], 0);
});
test("the directive is stubbed to NONE until the ladder is written", () => {
    assert.equal(deriveScore(m(2, 0, 0, 50, false, false), flat, DEFAULT_PARAMS).directive, "NONE");
});
