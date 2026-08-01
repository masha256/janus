import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveParams } from "./params.js";
import { deriveScreen } from "./screen.js";
const params = resolveParams({}, {});
test("screen_score is score * confidence", () => {
    const r = deriveScreen({ score: 5, confidence: 0.5 }, params);
    assert.equal(r.results["screen_score"], 2.5);
    assert.equal(r.results["threshold"], 1.0);
    assert.equal(r.flagged, true);
});
test("flag requires screen_score to meet screen_threshold", () => {
    const r = deriveScreen({ score: 2, confidence: 0.4 }, resolveParams({}, { screen_threshold: 1.0 }));
    assert.equal(r.results["screen_score"], 0.8);
    assert.equal(r.flagged, false);
});
test("score is 1..10 and confidence is 0..1", () => {
    assert.throws(() => deriveScreen({ score: 0, confidence: 0.5 }, params), /score/);
    assert.throws(() => deriveScreen({ score: 11, confidence: 0.5 }, params), /score/);
    assert.throws(() => deriveScreen({ score: 5, confidence: -0.1 }, params), /confidence/);
    assert.throws(() => deriveScreen({ score: 5, confidence: 1.1 }, params), /confidence/);
});
