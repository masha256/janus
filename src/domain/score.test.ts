import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveScore } from "./score.ts";
import { DEFAULT_PARAMS } from "./params.ts";

const f = (catalyst: number, trend: number, secular: number, crowding: number) => ({
  catalyst, trend, secular, crowding,
});

test("spec worked examples", () => {
  const cases: [ReturnType<typeof f>, number, number][] = [
    [f(2, 2, 2, -2), 2.0, 10],
    [f(2, 2, 2, 2), 1.0, 6],
    [f(0.5, 0.5, 0.5, -0.5), 0.5, 7],
    [f(2, -1, -1, 1), -0.25, 4],
    [f(0, 2, 0, 0), 0.5, 3],
    [f(0, 0, 0, 0), 0.0, 1],
    [f(-2, -2, -2, 2), -2.0, 10],
  ];
  for (const [factors, d, conv] of cases) {
    const got = deriveScore(factors, DEFAULT_PARAMS);
    assert.equal(Number(got.d.toFixed(2)), d, `d for ${JSON.stringify(factors)}`);
    assert.equal(got.conv, conv, `conv for ${JSON.stringify(factors)}`);
  }
});

test("a factor with no weight is reported but does not move d", () => {
  const weighted = deriveScore({ catalyst: 2 }, DEFAULT_PARAMS);
  const withExtra = deriveScore({ catalyst: 2, vibes: -2 }, DEFAULT_PARAMS);
  assert.equal(withExtra.d, weighted.d);
  assert.equal(withExtra.applied["vibes"], 0);
  assert.equal(withExtra.applied["catalyst"], 1.0);
});

test("no weighted factors yields a neutral score rather than dividing by zero", () => {
  const got = deriveScore({ vibes: 2 }, DEFAULT_PARAMS);
  assert.deepEqual({ d: got.d, conv: got.conv }, { d: 0, conv: 1 });
});

test("negative weights invert a factor", () => {
  // crowding alone, heavily crowded, with w_crowding = -1 → bearish
  const got = deriveScore({ crowding: 2 }, DEFAULT_PARAMS);
  assert.equal(got.d, -2);
  assert.equal(got.applied["crowding"], -1.0);
});

test("d is clamped into range", () => {
  const got = deriveScore({ catalyst: 2 }, { w_catalyst: 5 });
  assert.equal(got.d, 2);
});

test("deriveScore rejects an out-of-range factor", () => {
  assert.throws(() => deriveScore({ catalyst: 3 }, DEFAULT_PARAMS), /catalyst/);
});
