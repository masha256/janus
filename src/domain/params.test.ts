import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PARAMS, resolveParams } from "./params.ts";

test("defaults match the spec", () => {
  assert.equal(DEFAULT_PARAMS["beta_factor"], 1.0);
  assert.equal(DEFAULT_PARAMS["screen_threshold"], 1.0);
  assert.equal(DEFAULT_PARAMS["w_catalyst"], 0.3);
  assert.equal(DEFAULT_PARAMS["w_sentiment"], 0.25);
  assert.equal(DEFAULT_PARAMS["w_trend"], 0.25);
  assert.equal(DEFAULT_PARAMS["w_regime"], 0.15);
  assert.equal(DEFAULT_PARAMS["w_secular"], 0.05);
  assert.equal(DEFAULT_PARAMS["max_units"], 3);
});

test("cluster beats global beats default", () => {
  const r = resolveParams({ w_catalyst: 2 }, { w_catalyst: 1.5, w_sentiment: 0.5 });
  assert.equal(r["w_catalyst"], 2, "cluster wins");
  assert.equal(r["w_sentiment"], 0.5, "global wins over default");
  assert.equal(r["beta_factor"], 1.0, "default survives");
});

test("resolveParams passes through params with no default", () => {
  const r = resolveParams({ w_flows: 0.5 }, {});
  assert.equal(r["w_flows"], 0.5);
});

test("resolveParams does not mutate its inputs", () => {
  const cluster = { w_catalyst: 2 };
  resolveParams(cluster, {});
  assert.deepEqual(cluster, { w_catalyst: 2 });
});
