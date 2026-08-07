import { test } from "node:test";
import assert from "node:assert/strict";
import { decayGate } from "./gates.ts";
import type { ScoreResult } from "./score.ts";

const PARAMS = { decay_conviction_floor: 4, decay_persist_days: 2 };

// Only direction and conviction are read; the rest satisfies the type.
function score(direction: number, conviction: number): ScoreResult {
  return {
    direction,
    conviction,
    directive: "HOLD",
    plan: { directive: "HOLD", reason: "", size_tier: "full", signal_gate: "pass",
      persistence_gate: "pass", trend_gate: "pass", binary_gate: "pass",
      heat_gate: "pass", flipflop_gate: "n/a" },
    results: {},
  } as ScoreResult;
}

test("decay fires at exactly N consecutive sub-floor days", () => {
  assert.equal(decayGate(3, "long", [score(1, 3)], PARAMS), true, "today plus one prior = 2");
});

test("one sub-floor day alone is not decay", () => {
  assert.equal(decayGate(3, "long", [score(1, 8)], PARAMS), false);
});

test("a good day resets the run", () => {
  assert.equal(decayGate(3, "long", [score(1, 8), score(1, 3)], PARAMS), false);
});

test("conviction at or above the floor is never decay", () => {
  assert.equal(decayGate(4, "long", [score(1, 1), score(1, 1)], PARAMS), false);
  assert.equal(decayGate(9, "long", [score(1, 1), score(1, 1)], PARAMS), false);
});

test("an opposite-side prior score breaks the run", () => {
  assert.equal(decayGate(3, "long", [score(-1, 3)], PARAMS), false);
});

test("a flat position never decays, since there is no side to match", () => {
  assert.equal(decayGate(3, null, [score(1, 3)], PARAMS), false);
});

test("decay_persist_days 1 fires on today alone", () => {
  assert.equal(decayGate(3, "long", [], { ...PARAMS, decay_persist_days: 1 }), true);
});

test("missing params fall back to floor 4 over 2 days", () => {
  assert.equal(decayGate(3, "long", [score(1, 3)], {}), true);
  assert.equal(decayGate(5, "long", [score(1, 3)], {}), false);
});
