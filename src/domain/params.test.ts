import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PARAMS, resolveParams } from "./params.ts";

test("defaults match the spec", () => {
  assert.equal(DEFAULT_PARAMS["beta_factor"], 1.0);
  assert.equal(DEFAULT_PARAMS["screen_threshold"], 1.0);
  assert.equal(DEFAULT_PARAMS["w_catalyst"], 0.25);
  assert.equal(DEFAULT_PARAMS["w_sentiment"], 0.25);
  assert.equal(DEFAULT_PARAMS["w_trend"], 0.3);
  assert.equal(DEFAULT_PARAMS["w_regime"], 0.15);
  assert.equal(DEFAULT_PARAMS["w_secular"], 0.05);
  assert.equal(DEFAULT_PARAMS["fear_premium"], 1.25);
  assert.equal(DEFAULT_PARAMS["divergence_boost"], 0.5);
  assert.equal(DEFAULT_PARAMS["min_history_bars"], 200);
  assert.equal(DEFAULT_PARAMS["max_units"], 3);

  assert.equal(DEFAULT_PARAMS["trend_sma20_threshold_long"], 0);
  assert.equal(DEFAULT_PARAMS["trend_sma50_threshold_long"], 0);
  assert.equal(DEFAULT_PARAMS["trend_sma20_threshold_short"], 0);
  assert.equal(DEFAULT_PARAMS["trend_sma50_threshold_short"], 0);
  assert.equal(DEFAULT_PARAMS["late_trend_ma_distance"], 20);
  assert.equal(DEFAULT_PARAMS["late_trend_crowding_extreme"], 85);
  assert.equal(DEFAULT_PARAMS["starter_size_fraction"], 0.5);

  assert.equal(DEFAULT_PARAMS["account_capital"], 100000);
  assert.equal(DEFAULT_PARAMS["max_heat_pct"], 15);
  assert.equal(DEFAULT_PARAMS["per_trade_max_risk_pct"], 5);
  assert.equal(DEFAULT_PARAMS["per_asset_max_notional_pct"], 20);
  assert.equal(DEFAULT_PARAMS["stop_atr_multiple"], 2);
  assert.equal(DEFAULT_PARAMS["trailing_atr_multiple"], 2);
  assert.equal(DEFAULT_PARAMS["breakeven_trigger_r"], 1);
  assert.equal(DEFAULT_PARAMS["partial_trigger_r"], 1.5);
  assert.equal(DEFAULT_PARAMS["partial_exit_fraction"], 0.5);
  assert.equal(DEFAULT_PARAMS["max_time_stop_days"], 42);
  assert.equal(DEFAULT_PARAMS["conv_hold"], 4);
  assert.equal(DEFAULT_PARAMS["regime_trigger_long_max"], 1.5);
  assert.equal(DEFAULT_PARAMS["regime_trigger_short_min"], -1.5);
  assert.equal(DEFAULT_PARAMS["regime_force_exit_threshold"], 1.8);
  assert.equal(DEFAULT_PARAMS["actionable_catalyst_min"], 1.5);
  assert.equal(DEFAULT_PARAMS["actionable_strength_delta"], 1.5);
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
