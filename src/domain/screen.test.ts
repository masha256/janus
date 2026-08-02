import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveParams } from "./params.ts";
import { deriveScreen } from "./screen.ts";
import type { Read } from "./read.ts";

const params = resolveParams({}, {});
const macro = (regime: number): Read => ({ metrics: { regime }, results: {} });
const cluster = (regime: number): Read => ({ metrics: { regime }, results: {} });

test("screen_score is score * confidence", () => {
  const r = deriveScreen({ score: 5, confidence: 0.5 }, macro(0), null, params);
  assert.equal(r.results["screen_score"], 2.5);
  assert.equal(r.results["threshold"], 1.0);
  assert.equal(r.flagged, true);
});

test("flag requires screen_score to meet screen_threshold", () => {
  const r = deriveScreen({ score: 2, confidence: 0.4 }, macro(0), null, resolveParams({}, { screen_threshold: 1.0 }));
  assert.equal(r.results["screen_score"], 0.8);
  assert.equal(r.flagged, false);
});

test("score is 1..10 and confidence is 0..1", () => {
  assert.throws(() => deriveScreen({ score: 0, confidence: 0.5 }, macro(0), null, params), /score/);
  assert.throws(() => deriveScreen({ score: 11, confidence: 0.5 }, macro(0), null, params), /score/);
  assert.throws(() => deriveScreen({ score: 5, confidence: -0.1 }, macro(0), null, params), /confidence/);
  assert.throws(() => deriveScreen({ score: 5, confidence: 1.1 }, macro(0), null, params), /confidence/);
});

test("screen derives regime_smile from macro regime when asset is unclustered", () => {
  const r = deriveScreen({ score: 5, confidence: 0.5 }, macro(1), null, params);
  assert.equal(r.results["regime_smile"], 0.6);
  const r2 = deriveScreen({ score: 5, confidence: 0.5 }, macro(2), null, params);
  assert.equal(r2.results["regime_smile"], -1.2);
});

test("screen derives regime_smile from the cluster regime when a cluster read exists", () => {
  // A cluster with the same nominal value as the macro should yield the same
  // core smile, but the calculation uses the cluster source explicitly.
  const r = deriveScreen({ score: 5, confidence: 0.5 }, macro(0.5), cluster(1), params);
  assert.equal(r.results["regime_smile"], 0.6);
  const r2 = deriveScreen({ score: 5, confidence: 0.5 }, macro(0.5), cluster(2), resolveParams({}, { beta_factor: 1 }));
  assert.equal(r2.results["regime_smile"], -1.2);
});

test("screen requires a regime source from the chosen read", () => {
  assert.throws(
    () => deriveScreen({ score: 5, confidence: 0.5 }, { metrics: {}, results: {} }, null, params),
    /regime/,
  );
  assert.throws(
    () => deriveScreen({ score: 5, confidence: 0.5 }, macro(0.5), { metrics: {}, results: {} }, params),
    /regime/,
  );
});
