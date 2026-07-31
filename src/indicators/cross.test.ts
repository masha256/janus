import { test } from "node:test";
import assert from "node:assert/strict";
import { maCross, priceVsMa } from "./cross.ts";

test("maCross reports golden and counts bars since the crossover", () => {
  // fast crosses above slow at index 2, then stays above for 2 more bars
  const fast = [1, 2, 4, 5, 6];
  const slow = [3, 3, 3, 3, 3];
  assert.deepEqual(maCross(fast, slow), { state: "golden", age: 2 });
});

test("maCross reports death when fast is below", () => {
  const fast = [5, 5, 2, 1];
  const slow = [3, 3, 3, 3];
  assert.deepEqual(maCross(fast, slow), { state: "death", age: 1 });
});

test("maCross age is 0 on the bar the cross happens", () => {
  const fast = [1, 1, 4];
  const slow = [3, 3, 3];
  assert.deepEqual(maCross(fast, slow), { state: "golden", age: 0 });
});

test("maCross ignores leading nulls and reports age from the first known bar", () => {
  const fast = [null, null, 4, 5];
  const slow = [null, null, 3, 3];
  assert.deepEqual(maCross(fast, slow), { state: "golden", age: 1 });
});

test("maCross returns nulls when no bar has both series", () => {
  assert.deepEqual(maCross([null, null], [null, 3]), { state: null, age: null });
});

test("priceVsMa reports which side price sits on and for how long", () => {
  assert.deepEqual(priceVsMa([1, 2, 5, 6], [3, 3, 3, 3]), { state: "above", age: 1 });
  assert.deepEqual(priceVsMa([5, 5, 1], [3, 3, 3]), { state: "below", age: 0 });
});

test("priceVsMa returns nulls when the ma is entirely null", () => {
  assert.deepEqual(priceVsMa([1, 2], [null, null]), { state: null, age: null });
});
