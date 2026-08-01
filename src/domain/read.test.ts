import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveParams } from "./params.ts";
import { deriveMacroRead, deriveClusterRead } from "./read.ts";

const params = resolveParams({}, {});

/** A macro read that observed `regime` and concluded nothing yet. */
const macro = (regime: number) => ({ metrics: { regime }, results: {} });

test("deriveMacroRead requires a regime metric in -2..2", () => {
  assert.deepEqual(deriveMacroRead({ regime: 1.5 }, params), {});
  assert.deepEqual(deriveMacroRead({ regime: -2 }, params), {});
});

test("deriveMacroRead rejects a missing or out-of-range regime", () => {
  assert.throws(() => deriveMacroRead({}, params), /regime/);
  assert.throws(() => deriveMacroRead({ regime: 3 }, params), /regime/);
  assert.throws(() => deriveMacroRead({ regime: "risk_on" }, params), /regime/);
});

test("deriveClusterRead requires a regime metric from the macro read", () => {
  assert.throws(
    () => deriveClusterRead({}, { metrics: {}, results: {} }, params),
    /regime/,
  );
});

test("regime smile is 0.6 * R * beta in the core", () => {
  const p = resolveParams({}, {});
  assert.equal(deriveClusterRead({}, macro(1), p).regime_smile, 0.6);
  assert.equal(deriveClusterRead({}, macro(-0.5), p).regime_smile, -0.3);
  assert.equal(
    deriveClusterRead({}, macro(1), resolveParams({}, { beta_factor: 2 })).regime_smile,
    1.2,
  );
});

test("regime smile flips to -sign(R)*1.2 in the extreme", () => {
  const p = resolveParams({}, {});
  assert.equal(deriveClusterRead({}, macro(2), p).regime_smile, -1.2);
  assert.equal(deriveClusterRead({}, macro(-2), p).regime_smile, 1.2);
});

test("regime smile transitions smoothly between core and extreme", () => {
  const p = resolveParams({}, {});
  const r = deriveClusterRead({}, macro(1.5), p);
  assert.ok(Math.abs(Number(r.regime_smile) - -0.15) < 1e-12, `got ${r.regime_smile}`);
});
