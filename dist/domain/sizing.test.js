import { test } from "node:test";
import assert from "node:assert/strict";
import { bookHeat, sizeFromRiskAndStop, stopDistancePct, stopFromAtr, unitHeat, unitsHeat, } from "./sizing.js";
const unit = (over = {}) => ({
    seq: 1, entry_price: 100, notional: 1000, risk: 100, stop: 90,
    status: "open", exit_price: null, funding: 0, tag: null, ...over,
});
test("sizeFromRiskAndStop follows the formula", () => {
    const result = sizeFromRiskAndStop({
        capital: 100000,
        maxRiskPct: 5,
        conviction: 7,
        stopDistancePct: 0.04,
        perAssetMaxNotionalPct: 20,
    });
    assert.equal(result.riskDollars, 3500); // 100k * 5% * 0.7
    assert.equal(result.positionSizeDollars, 87500); // 3500 / 0.04
    assert.equal(result.perAssetCapDollars, 20000);
    assert.equal(result.cappedPositionSizeDollars, 20000); // cap applies
    assert.equal(result.heatDollars, 3500);
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
test("unitHeat floors at zero", () => {
    assert.equal(unitHeat(unit({ entry_price: 100, stop: 90 }), "long"), 100);
    assert.equal(unitHeat(unit({ entry_price: 100, stop: 110 }), "long"), 0);
});
test("unitsHeat sums open units only", () => {
    assert.equal(unitsHeat([
        unit({ seq: 1, stop: 90 }),
        unit({ seq: 2, stop: 90 }),
        unit({ seq: 3, status: "closed", stop: 90 }),
    ], "long"), 200);
});
test("bookHeat aggregates heat across trades", () => {
    assert.equal(bookHeat([
        { direction: "long", units: [unit({ seq: 1, stop: 90 })] },
        { direction: "long", units: [unit({ seq: 1, stop: 90, notional: 500 })] },
    ]), 150); // 100 + 50
});
