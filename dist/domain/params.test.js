import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PARAMS, resolveParams } from "./params.js";
test("defaults match the spec", () => {
    assert.equal(DEFAULT_PARAMS["d_initiate"], 1.0);
    assert.equal(DEFAULT_PARAMS["conv_initiate"], 6);
    assert.equal(DEFAULT_PARAMS["d_add"], 1.0);
    assert.equal(DEFAULT_PARAMS["conv_add"], 7);
    assert.equal(DEFAULT_PARAMS["conv_hold"], 4);
    assert.equal(DEFAULT_PARAMS["d_exit"], 1.0);
    assert.equal(DEFAULT_PARAMS["max_units"], 4);
    assert.equal(DEFAULT_PARAMS["screen_flag_threshold"], 1.0);
    assert.equal(DEFAULT_PARAMS["w_catalyst"], 1.0);
    assert.equal(DEFAULT_PARAMS["w_trend"], 1.0);
    assert.equal(DEFAULT_PARAMS["w_secular"], 1.0);
    assert.equal(DEFAULT_PARAMS["w_crowding"], -1.0);
});
test("cluster beats global beats default", () => {
    const r = resolveParams({ conv_add: 9 }, { conv_add: 8, conv_hold: 5 });
    assert.equal(r["conv_add"], 9, "cluster wins");
    assert.equal(r["conv_hold"], 5, "global wins over default");
    assert.equal(r["d_initiate"], 1.0, "default survives");
});
test("resolveParams passes through params with no default", () => {
    const r = resolveParams({ w_flows: 0.5 }, {});
    assert.equal(r["w_flows"], 0.5);
});
test("resolveParams does not mutate its inputs", () => {
    const cluster = { conv_add: 9 };
    resolveParams(cluster, {});
    assert.deepEqual(cluster, { conv_add: 9 });
});
