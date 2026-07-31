import { test } from "node:test";
import assert from "node:assert/strict";
import { sma, ema, smaSeries, emaSeries } from "./ma.ts";

test("sma averages the trailing window", () => {
  assert.equal(sma([1, 2, 3, 4, 5], 5), 3);
  assert.equal(sma([1, 2, 3, 4, 5], 2), 4.5);
});

test("sma returns null when history is shorter than the period", () => {
  assert.equal(sma([1, 2], 5), null);
  assert.equal(sma([], 1), null);
});

test("smaSeries is null-padded and aligned to the input", () => {
  assert.deepEqual(smaSeries([1, 2, 3, 4], 2), [null, 1.5, 2.5, 3.5]);
});

test("ema seeds from the sma of the first window", () => {
  // seed = sma([1,2,3]) = 2; k = 2/(3+1) = 0.5
  // next = 4*0.5 + 2*0.5 = 3 ; then = 5*0.5 + 3*0.5 = 4
  assert.equal(ema([1, 2, 3, 4, 5], 3), 4);
});

test("emaSeries is null-padded before the seed index", () => {
  assert.deepEqual(emaSeries([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
});

test("ema returns null when history is shorter than the period", () => {
  assert.equal(ema([1, 2], 3), null);
});
