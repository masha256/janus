import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveParams } from "./params.js";
import { deriveMacroRead, deriveClusterRead } from "./read.js";
const params = resolveParams({}, {});
/** A macro read that observed `regime` and concluded nothing yet. */
const macro = (regime) => ({ metrics: { regime }, results: {} });
test("deriveMacroRead requires a regime metric in -2..2", () => {
    assert.deepEqual(deriveMacroRead({ regime: 1.5 }, params), {});
    assert.deepEqual(deriveMacroRead({ regime: -2 }, params), {});
});
test("deriveMacroRead rejects a missing or out-of-range regime", () => {
    assert.throws(() => deriveMacroRead({}, params), /regime/);
    assert.throws(() => deriveMacroRead({ regime: 3 }, params), /regime/);
    assert.throws(() => deriveMacroRead({ regime: "risk_on" }, params), /regime/);
});
test("deriveClusterRead requires a regime metric in -2..2", () => {
    assert.throws(() => deriveClusterRead({}, { metrics: {}, results: {} }, params), /regime/);
    assert.throws(() => deriveClusterRead({ regime: 3 }, macro(0.5), params), /regime/);
});
test("deriveClusterRead records no derived results", () => {
    const p = resolveParams({}, {});
    assert.deepEqual(deriveClusterRead({ regime: 1 }, macro(1), p), {});
    assert.deepEqual(deriveClusterRead({ regime: -0.5 }, macro(-0.5), p), {});
});
