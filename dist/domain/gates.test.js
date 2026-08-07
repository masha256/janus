import { test } from "node:test";
import assert from "node:assert/strict";
import { actionableNewSignal, decayGate } from "./gates.js";
const PARAMS = { decay_conviction_floor: 4, decay_persist_days: 2 };
// Only direction and conviction are read; the rest satisfies the type.
function score(direction, conviction) {
    return {
        direction,
        conviction,
        directive: "HOLD",
        plan: { directive: "HOLD", reason: "", size_tier: "full", signal_gate: "pass",
            persistence_gate: "pass", trend_gate: "pass", binary_gate: "pass",
            heat_gate: "pass", flipflop_gate: "n/a" },
        results: {},
    };
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
// `capitulation` and `divergence` are `score record --factor` inputs. They were
// read off the screen row, where nothing writes them, so both short-circuits
// were dead and the function always fell through to catalyst/direction.
test("actionableNewSignal short-circuits on the score's own boolean factors", () => {
    const params = { actionable_catalyst_min: 1.5, actionable_direction_delta: 1.5 };
    const prev = score(0.5, 6);
    // A quiet day: small catalyst, small move. Nothing here is actionable.
    assert.equal(actionableNewSignal(0.5, 0, {}, prev, params), false);
    assert.equal(actionableNewSignal(0.5, 0, { capitulation: true }, prev, params), true);
    assert.equal(actionableNewSignal(0.5, 0, { divergence: true }, prev, params), true);
    // Falsy values must not trip it — 0 is what the prompts record for "no".
    assert.equal(actionableNewSignal(0.5, 0, { capitulation: 0, divergence: 0 }, prev, params), false);
});
