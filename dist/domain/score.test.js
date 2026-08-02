import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveScore } from "./score.js";
import { DEFAULT_PARAMS } from "./params.js";
/** A context that concludes nothing: the metrics alone decide strength and conviction. */
const flat = {
    macro: { metrics: {}, results: {} },
    cluster: null,
    screen: { flagged: false, metrics: { score: 1 }, results: { screen_score: 0.5, threshold: 1, regime: 0, regime_smile: 0 } },
    positions: [],
    asset: { symbol: "BTC", class: "crypto", cluster_id: null, coverage: null },
};
const ctx = (macroRegime, clusterRegime) => ({
    ...flat,
    macro: { metrics: { regime: macroRegime }, results: {} },
    cluster: clusterRegime === null
        ? null
        : { metrics: { regime: clusterRegime }, results: {} },
    asset: { ...flat.asset, cluster_id: clusterRegime === null ? null : 1 },
    screen: {
        flagged: true,
        metrics: { score: 5 },
        results: {
            screen_score: 5,
            threshold: 1,
            regime: clusterRegime ?? macroRegime,
            regime_smile: 0.6 * (clusterRegime ?? macroRegime),
        },
    },
});
function m(catalyst, trend, secular, crowding, capitulation, divergence, confidence = 1) {
    return { catalyst, trend, secular, crowding, capitulation, divergence, confidence };
}
test("direction is the weighted mean of factors normalised by total |weight|", () => {
    const got = deriveScore(m(2, 1, -1, 50, false, false), flat, DEFAULT_PARAMS);
    // P=50 -> calm middle, trend>0 -> sentiment = 0.4 * 1.25 fear premium = 0.5
    // weights: catalyst 0.25, sentiment 0.25, trend 0.3, regime 0.15, secular 0.05
    // weighted sum = 0.25*2 + 0.25*0.5 + 0.3*1 + 0.15*0 + 0.05*(-1) = 0.875
    // total |weight| = 1.0, so strength = 0.875
    assert.ok(Math.abs(got.strength - 0.875) < 1e-12, `got ${got.strength}`);
    assert.equal(got.results["regime"], 0);
    assert.equal(got.results["regime_smile"], 0);
    assert.ok(Math.abs(got.results["weighted_sum"] - 0.875) < 1e-12);
    assert.equal(got.results["total_abs_weight"], 1.0);
});
test("direction stays in range when weights do not sum to 1", () => {
    // Every weight doubled: raw sum would be 1.75, but the normalised mean is unchanged.
    const doubled = Object.fromEntries(Object.entries(DEFAULT_PARAMS).map(([k, v]) => [k, k.startsWith("w_") ? v * 2 : v]));
    const got = deriveScore(m(2, 1, -1, 50, false, false), flat, doubled);
    assert.ok(Math.abs(got.strength - 0.875) < 1e-12, `got ${got.strength}`);
    assert.equal(got.results["total_abs_weight"], 2.0);
});
test("sentiment bands match the crowding lookup, with the fear premium applied to the buy side", () => {
    const cases = [
        [5, 2.0, "<=12 / capitulation - true panic"],
        [20, 1.25, "12-25 - fear"],
        [30, 0.625, "25-40 - getting fearful (linear)"],
        [50, 0.5, "40-65 - calm middle (+0.4 x sign(Trend))"],
        [75, -0.5, "65-85 - getting crowded (linear)"],
        [90, -1.5, "85-95 - greed, fade"],
        [98, -2.0, ">=95 - true euphoria, fade hard"],
    ];
    for (const [crowding, expected, band] of cases) {
        const got = deriveScore(m(0, 1, 0, crowding, false, false), flat, { ...DEFAULT_PARAMS, w_catalyst: 0, w_trend: 0, w_secular: 0, w_regime: 0, w_sentiment: 1 });
        assert.ok(Math.abs(got.strength - expected) < 1e-12, `crowding ${crowding}: got ${got.strength}, want ${expected}`);
        assert.equal(got.results["sentiment_summary"], band);
    }
});
test("the fear premium is asymmetric: buy side amplified, sell side untouched", () => {
    const longPanic = deriveScore(m(0, 1, 0, 5, false, false), flat, { ...DEFAULT_PARAMS, w_catalyst: 0, w_trend: 0, w_secular: 0, w_regime: 0, w_sentiment: 1 });
    assert.equal(longPanic.results["sentiment"], 2.0); // 2.0 * 1.25, clamped at 2
    const fear = deriveScore(m(0, 1, 0, 20, false, false), flat, { ...DEFAULT_PARAMS, w_catalyst: 0, w_trend: 0, w_secular: 0, w_regime: 0, w_sentiment: 1 });
    assert.equal(fear.results["sentiment"], 1.25); // 1.0 * 1.25
    const greed = deriveScore(m(0, 1, 0, 90, false, false), flat, { ...DEFAULT_PARAMS, w_catalyst: 0, w_trend: 0, w_secular: 0, w_regime: 0, w_sentiment: 1 });
    assert.equal(greed.results["sentiment"], -1.5); // unchanged
    const fearZero = deriveScore(m(0, 1, 0, 20, false, false), flat, { ...DEFAULT_PARAMS, fear_premium: 1.0, w_catalyst: 0, w_trend: 0, w_secular: 0, w_regime: 0, w_sentiment: 1 });
    assert.equal(fearZero.results["sentiment"], 1.0); // premium 1.0 turns it off
});
test("divergence boosts the sentiment in the same direction", () => {
    const fearful = deriveScore(m(0, 1, 0, 20, false, false), flat, { ...DEFAULT_PARAMS, w_catalyst: 0, w_trend: 0, w_secular: 0, w_regime: 0, w_sentiment: 1 });
    assert.equal(fearful.strength, 1.25);
    const boosted = deriveScore(m(0, 1, 0, 20, false, true), flat, { ...DEFAULT_PARAMS, w_catalyst: 0, w_trend: 0, w_secular: 0, w_regime: 0, w_sentiment: 1 });
    assert.equal(boosted.strength, 1.75); // (1.0 * 1.25) + 0.5
    assert.match(String(boosted.results["sentiment_summary"]), /divergence booster/);
});
test("divergence booster size is a cluster-tunable param", () => {
    const bigger = deriveScore(m(0, 1, 0, 20, false, true), flat, { ...DEFAULT_PARAMS, divergence_boost: 1.0, w_catalyst: 0, w_trend: 0, w_secular: 0, w_regime: 0, w_sentiment: 1 });
    assert.equal(bigger.strength, 2.0); // (1.0 * 1.25) + 1.0, clamped at 2
    assert.equal(bigger.results["divergence_boost"], 1.0);
    const off = deriveScore(m(0, 1, 0, 20, false, true), flat, { ...DEFAULT_PARAMS, divergence_boost: 0, w_catalyst: 0, w_trend: 0, w_secular: 0, w_regime: 0, w_sentiment: 1 });
    assert.equal(off.strength, 1.25); // 1.0 * 1.25, no boost
});
test("confidence is the scoring metric's own 0..1 quality, not inherited from the screen", () => {
    const highConf = deriveScore(m(2, 0, 0, 50, false, false, 1), ctx(0, null), DEFAULT_PARAMS);
    const lowConf = deriveScore(m(2, 0, 0, 50, false, false, 0.3), ctx(0, null), DEFAULT_PARAMS);
    assert.ok(highConf.conviction > lowConf.conviction, "higher confidence raises conviction");
    assert.equal(highConf.results["confidence"], 1);
    assert.equal(lowConf.results["confidence"], 0.3);
});
test("absent confidence means no information, giving conviction floor", () => {
    const metrics = m(2, 0, 0, 50, false, false);
    delete metrics["confidence"];
    const got = deriveScore(metrics, flat, DEFAULT_PARAMS);
    assert.equal(got.conviction, 1);
    assert.equal(got.results["confidence"], 0);
});
test("screen confidence is not inherited when scoring confidence is absent", () => {
    const metrics = m(2, 0, 0, 50, false, false);
    delete metrics["confidence"];
    const withScreenConf = {
        ...flat,
        screen: {
            flagged: false,
            metrics: { score: 5, confidence: 1 }, // screen judged a different question at 1.0
            results: { screen_score: 5, threshold: 1, regime: 0, regime_smile: 0 },
        },
    };
    const got = deriveScore(metrics, withScreenConf, DEFAULT_PARAMS);
    assert.equal(got.results["confidence"], 0, "screen confidence must not leak into scoring");
    assert.equal(got.conviction, 1);
});
test("agreement is snapshotted: 1 when all aligned, less when factors cancel", () => {
    const aligned = deriveScore(m(2, 2, 2, 5, false, false), // crowding 5 -> panic -> +2.0 * 1.25 = +2.0 sentiment
    flat, DEFAULT_PARAMS);
    assert.ok(Math.abs(aligned.results["agreement"] - 1) < 1e-12);
    // catalyst +2 vs trend -2, sentiment +0.4 (crowding 50), regime 0, secular 0
    const mixed = deriveScore(m(2, -2, 0, 50, false, false), flat, DEFAULT_PARAMS);
    const agreement = mixed.results["agreement"];
    assert.ok(agreement < 1 && agreement >= 0, `agreement ${agreement}`);
    assert.ok(agreement < 0.2, `heavily cancelling factors should score low agreement, got ${agreement}`);
});
test("deriveScore rejects invalid factors and crowding", () => {
    assert.throws(() => deriveScore(m(3, 0, 0, 50, false, false), flat, DEFAULT_PARAMS), /catalyst/);
    assert.throws(() => deriveScore(m(0, 0, 0, 0, false, false), flat, DEFAULT_PARAMS), /crowding/);
    assert.throws(() => deriveScore(m(0, 0, 0, 101, false, false), flat, DEFAULT_PARAMS), /crowding/);
});
test("deriveScore requires a screen with regime and regime_smile", () => {
    assert.throws(() => deriveScore(m(2, 0, 0, 50, false, false), { ...flat, screen: null }, DEFAULT_PARAMS), /screen must be recorded before scoring/);
    assert.throws(() => deriveScore(m(2, 0, 0, 50, false, false), { ...flat, screen: { flagged: false, metrics: { score: 1 }, results: { screen_score: 0.5, threshold: 1 } } }, DEFAULT_PARAMS), /regime/);
});
test("top-down alignment uses regime_smile", () => {
    // With catalyst/trend/secular flat and regime the only live weight, direction is regime_smile.
    // Regime 1.5 -> regime_smile 0.9, so direction is positive and aligns with it.
    const bullish = deriveScore(m(0, 0, 0, 50, false, false), ctx(1.5, 1.5), { ...DEFAULT_PARAMS, w_regime: 5, w_sentiment: 0, w_catalyst: 0, w_trend: 0, w_secular: 0 });
    assert.ok(bullish.strength > 0, `strength ${bullish.strength}`);
    assert.ok(Math.abs(bullish.strength - 0.9) < 1e-12, `normalised strength ${bullish.strength}`);
    assert.ok(Math.abs(bullish.results["regime_smile"] - 0.9) < 1e-12, `got ${bullish.results["regime_smile"]}`);
    // Without a cluster, the screen would have used the macro regime, so an
    // unclustered asset still sees the same regime_smile when macro matches.
    const macroOnly = deriveScore(m(0, 0, 0, 50, false, false), ctx(1.5, null), { ...DEFAULT_PARAMS, w_regime: 5, w_sentiment: 0, w_catalyst: 0, w_trend: 0, w_secular: 0 });
    assert.ok(macroOnly.strength > 0, `strength ${macroOnly.strength}`);
    assert.ok(Math.abs(macroOnly.results["regime_smile"] - 0.9) < 1e-12, `got ${macroOnly.results["regime_smile"]}`);
});
test("the directive is stubbed to NONE until the ladder is written", () => {
    assert.equal(deriveScore(m(2, 0, 0, 50, false, false), flat, DEFAULT_PARAMS).directive, "NONE");
});
