import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveParams } from "./params.ts";
import { deriveMacroRead, deriveClusterRead } from "./read.ts";

const params = resolveParams({}, {});

/** A macro read that concluded `tilt` and nothing else. */
const macro = (tilt: number) => ({ metrics: {}, results: { tilt } });

test("confidence scales the macro tilt, and zero confidence concludes nothing", () => {
  assert.equal(deriveMacroRead({ score: 2, confidence: 2 }, params)["tilt"], 2, "full conviction keeps the whole score");
  assert.equal(deriveMacroRead({ score: 2, confidence: 1 }, params)["tilt"], 1, "half conviction halves it");
  assert.equal(deriveMacroRead({ score: 2, confidence: 0 }, params)["tilt"], 0, "no conviction, no tilt");
  assert.equal(deriveMacroRead({ score: -2, confidence: 2 }, params)["tilt"], -2, "the bearish half works the same");
});

test("risk_budget moves with the tilt and stays inside 0..1", () => {
  assert.equal(deriveMacroRead({ score: 0, confidence: 2 }, params)["risk_budget"], 0.5, "a flat read sits at the base");
  assert.equal(deriveMacroRead({ score: 2, confidence: 2 }, params)["risk_budget"], 1, "maximum tilt tops out at 1");
  assert.equal(deriveMacroRead({ score: -2, confidence: 2 }, params)["risk_budget"], 0, "and bottoms out at 0, not below");
  // A retuned slope must not push the budget out of range either.
  const steep = resolveParams({}, { risk_budget_tilt: 10 });
  assert.equal(deriveMacroRead({ score: 2, confidence: 2 }, steep)["risk_budget"], 1);
  assert.equal(deriveMacroRead({ score: -2, confidence: 2 }, steep)["risk_budget"], 0);
});

test("a cluster read blends its own bias with the macro tilt", () => {
  // Defaults weight bias 1.0 against macro 0.5: (1*2 + 0.5*-1) / 1.5 = 1.
  assert.equal(deriveClusterRead({ bias: 2, judgement: "x" }, macro(-1), params)["tilt"], 1);
  assert.equal(deriveClusterRead({ bias: 1, judgement: "x" }, macro(1), params)["tilt"], 1, "full agreement needs no blending");
  // Weighting the macro rung to zero leaves the cluster's own bias standing.
  const ownOnly = resolveParams({}, { cluster_macro_weight: 0 });
  assert.equal(deriveClusterRead({ bias: 1.5, judgement: "x" }, macro(-2), ownOnly)["tilt"], 1.5);
});

test("aligned is 1 only when cluster and macro genuinely agree on direction", () => {
  assert.equal(deriveClusterRead({ bias: 1, judgement: "x" }, macro(1), params)["aligned"], 1);
  assert.equal(deriveClusterRead({ bias: -1, judgement: "x" }, macro(-1), params)["aligned"], 1);
  assert.equal(deriveClusterRead({ bias: 1, judgement: "x" }, macro(-1), params)["aligned"], 0);
  assert.equal(deriveClusterRead({ bias: 0, judgement: "x" }, macro(1), params)["aligned"], 0, "a flat cluster agrees with nothing");
  assert.equal(deriveClusterRead({ bias: 1, judgement: "x" }, macro(0), params)["aligned"], 0, "nor does a flat macro");
});

test("zeroing both cluster weights yields a flat tilt, not a division by zero", () => {
  const none = resolveParams({}, { cluster_bias_weight: 0, cluster_macro_weight: 0 });
  assert.equal(deriveClusterRead({ bias: 2, judgement: "x" }, macro(2), none)["tilt"], 0);
});
