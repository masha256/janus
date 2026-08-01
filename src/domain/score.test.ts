import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveScore, type ScoreContext } from "./score.ts";
import { DEFAULT_PARAMS } from "./params.ts";

const f = (catalyst: number, trend: number, secular: number, crowding: number) => ({
  catalyst, trend, secular, crowding,
});

/** A context that concludes nothing: the metrics alone decide strength and conviction. */
const flat: ScoreContext = {
  macro: { metrics: {}, results: {} },
  cluster: null,
  screen: null,
  positions: [],
  asset: { symbol: "BTC", class: "crypto", cluster_id: null, coverage: null },
};

const ctx = (macroTilt: number, clusterTilt: number | null): ScoreContext => ({
  ...flat,
  macro: { metrics: {}, results: { tilt: macroTilt } },
  cluster: clusterTilt === null ? null : { metrics: {}, results: { tilt: clusterTilt } },
  asset: { ...flat.asset, cluster_id: clusterTilt === null ? null : 1 },
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
  for (const [factors, strength, conviction] of cases) {
    const got = deriveScore(factors, flat, DEFAULT_PARAMS);
    assert.equal(Number(got.strength.toFixed(2)), strength, `strength for ${JSON.stringify(factors)}`);
    assert.equal(got.conviction, conviction, `conviction for ${JSON.stringify(factors)}`);
  }
});

test("a factor with no weight is reported but does not move strength", () => {
  const weighted = deriveScore({ catalyst: 2 }, flat, DEFAULT_PARAMS);
  const withExtra = deriveScore({ catalyst: 2, vibes: -2 }, flat, DEFAULT_PARAMS);
  assert.equal(withExtra.strength, weighted.strength);
  assert.equal(withExtra.results["w_vibes"], 0);
  assert.equal(withExtra.results["w_catalyst"], 1.0);
});

test("no weighted factors yields a neutral score rather than dividing by zero", () => {
  const got = deriveScore({ vibes: 2 }, flat, DEFAULT_PARAMS);
  assert.equal(got.strength, 0);
  assert.equal(got.conviction, 1);
  assert.equal(got.results["w_vibes"], 0, "the weightless factor is still reported");
});

test("negative weights invert a factor", () => {
  // crowding alone, heavily crowded, with w_crowding = -1 → bearish
  const got = deriveScore({ crowding: 2 }, flat, DEFAULT_PARAMS);
  assert.equal(got.strength, -2);
  assert.equal(got.results["w_crowding"], -1.0);
});

test("strength is clamped into range", () => {
  const got = deriveScore({ catalyst: 2 }, flat, { w_catalyst: 5 });
  assert.equal(got.strength, 2);
});

test("deriveScore rejects a metric it cannot average", () => {
  assert.throws(() => deriveScore({ catalyst: 3 }, flat, DEFAULT_PARAMS), /catalyst/);
  // Metrics may be free text in general; a score metric may not, since the
  // formula takes a weighted mean of them.
  assert.throws(
    () => deriveScore({ catalyst: "strong" }, flat, DEFAULT_PARAMS),
    /catalyst must be a number/,
  );
});

test("the directive is stubbed to NONE until the ladder is written", () => {
  // Every shape of input, including one that would once have been an INITIATE.
  assert.equal(deriveScore({ catalyst: 2 }, flat, DEFAULT_PARAMS).directive, "NONE");
  assert.equal(deriveScore({ vibes: 1 }, flat, DEFAULT_PARAMS).directive, "NONE");
  const held: ScoreContext = {
    ...flat,
    screen: { flagged: true, metrics: { score: 1.5 }, results: { threshold: 1 } },
    positions: [{ asset_id: 1, symbol: "BTC", side: "long", units: 2 }],
  };
  assert.equal(deriveScore({ catalyst: 2 }, held, DEFAULT_PARAMS).directive, "NONE");
});

test("the context is reported as alignment, and does not move strength", () => {
  const bullish = { catalyst: 2 };
  const against = deriveScore(bullish, ctx(-1.5, -1.5), DEFAULT_PARAMS);
  const behind = deriveScore(bullish, ctx(1.5, 1.5), DEFAULT_PARAMS);

  assert.equal(against.strength, behind.strength, "top-down reads do not move the weighted mean");
  assert.deepEqual(
    { macro: against.results["macro_aligned"], cluster: against.results["cluster_aligned"] },
    { macro: 0, cluster: 0 },
  );
  assert.deepEqual(
    { macro: behind.results["macro_aligned"], cluster: behind.results["cluster_aligned"] },
    { macro: 1, cluster: 1 },
  );
});

test("an unclustered asset is never cluster_aligned, and a flat read agrees with nothing", () => {
  const noCluster = deriveScore({ catalyst: 2 }, ctx(2, null), DEFAULT_PARAMS);
  assert.equal(noCluster.results["macro_aligned"], 1);
  assert.equal(noCluster.results["cluster_aligned"], 0, "no cluster read means no agreement");

  // A zero-strength score has no direction to agree with.
  const flatScore = deriveScore({ catalyst: 0 }, ctx(2, 2), DEFAULT_PARAMS);
  assert.equal(flatScore.results["macro_aligned"], 0);
});
