import { test } from "node:test";
import assert from "node:assert/strict";
import { JanusError } from "../output.ts";
import { csv, num, oneOf, pairs, required } from "./args.ts";

function codeOf(fn: () => unknown): string {
  try {
    fn();
    throw new Error("expected fn to throw");
  } catch (e) {
    assert.ok(e instanceof JanusError);
    return e.code;
  }
}

test("required throws naming the flag", () => {
  assert.equal(codeOf(() => required(undefined, "score")), "VALIDATION");
  assert.equal(codeOf(() => required("", "score")), "VALIDATION");
});

test("num rejects non-numeric", () => {
  assert.equal(codeOf(() => num("abc", "score", 0, 10)), "VALIDATION");
});

test("num rejects out-of-range at both ends", () => {
  assert.equal(codeOf(() => num("-1", "score", 0, 10)), "VALIDATION");
  assert.equal(codeOf(() => num("11", "score", 0, 10)), "VALIDATION");
});

test("num accepts the inclusive boundaries", () => {
  assert.equal(num("0", "score", 0, 10), 0);
  assert.equal(num("10", "score", 0, 10), 10);
});

test("num rejects whitespace-only input", () => {
  assert.equal(codeOf(() => num("   ", "score", 0, 10)), "VALIDATION");
});

test("oneOf accepts a member and rejects a non-member", () => {
  assert.equal(oneOf("a", "mode", ["a", "b"]), "a");
  assert.equal(codeOf(() => oneOf("c", "mode", ["a", "b"])), "VALIDATION");
});

test("csv splits and trims", () => {
  assert.deepEqual(csv("BTC, ETH"), ["BTC", "ETH"]);
});

test("csv returns undefined when absent", () => {
  assert.equal(csv(undefined), undefined);
});

test("csv throws on empty string", () => {
  assert.equal(codeOf(() => csv("")), "VALIDATION");
});

test("pairs parses key=value entries", () => {
  assert.deepEqual(pairs(["catalyst=1.5", "trend=-0.5"], "factor"), {
    catalyst: 1.5,
    trend: -0.5,
  });
});

test("pairs throws on a missing =", () => {
  assert.equal(codeOf(() => pairs(["catalyst"], "factor")), "VALIDATION");
});

test("pairs throws on a non-numeric value", () => {
  assert.equal(codeOf(() => pairs(["catalyst=abc"], "factor")), "VALIDATION");
});
