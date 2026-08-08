import { test } from "node:test";
import assert from "node:assert/strict";
import { sizeFromRiskAndStop, stopDistancePct, stopFromAtr } from "./sizing.js";
test("sizeFromRiskAndStop follows the formula", () => {
    const result = sizeFromRiskAndStop({
        capital: 100000,
        maxRiskPct: 5,
        conviction: 7,
        stopDistancePct: 0.04,
        perAssetMaxNotionalPct: 20,
    });
    assert.equal(result.positionSizeDollars, 87500); // budget 3500 / 0.04
    assert.equal(result.perAssetCapDollars, 20000);
    assert.equal(result.cappedPositionSizeDollars, 20000); // cap applies
    // Risk follows the capped size, not the 3500 budget it was sized against:
    // 20000 at a 4% stop can only lose 800.
    assert.equal(result.riskDollars, 800);
    assert.equal(result.heatDollars, 800);
});
test("sizeFromRiskAndStop risks the full budget when the cap does not bind", () => {
    const result = sizeFromRiskAndStop({
        capital: 100000,
        maxRiskPct: 1,
        conviction: 7,
        stopDistancePct: 0.05,
        perAssetMaxNotionalPct: 20,
    });
    assert.equal(result.positionSizeDollars, 14000); // budget 700 / 0.05
    assert.equal(result.cappedPositionSizeDollars, 14000); // under the 20000 cap
    assert.equal(result.riskDollars, 700); // 100k * 1% * 0.7
    assert.equal(result.heatDollars, 700);
});
test("sizeFromRiskAndStop does not divide by zero", () => {
    const result = sizeFromRiskAndStop({
        capital: 100000,
        maxRiskPct: 5,
        conviction: 7,
        stopDistancePct: 0,
        perAssetMaxNotionalPct: 20,
    });
    assert.equal(result.positionSizeDollars, 0);
});
test("stopFromAtr places long stops below entry", () => {
    assert.equal(stopFromAtr(100, 5, 2, "long"), 90);
});
test("stopFromAtr places short stops above entry", () => {
    assert.equal(stopFromAtr(100, 5, 2, "short"), 110);
});
test("stopDistancePct is always positive", () => {
    assert.equal(stopDistancePct(100, 90, "long"), 0.1);
    assert.equal(stopDistancePct(100, 110, "short"), 0.1);
    assert.equal(stopDistancePct(100, 110, "long"), 0); // would be negative, floored
});
