import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveDirective, formatPosition } from "./directive.ts";
import { DEFAULT_PARAMS } from "./params.ts";
import type { PositionState } from "./directive.ts";

const flat: PositionState = { side: null, units: 0 };
const long = (units: number): PositionState => ({ side: "long", units });
const short = (units: number): PositionState => ({ side: "short", units });
const call = (d: number, conv: number, pos: PositionState) =>
  deriveDirective(d, conv, pos, DEFAULT_PARAMS);

test("flat: initiates only when both d and conv clear their thresholds", () => {
  assert.equal(call(1.5, 8, flat), "INITIATE");
  assert.equal(call(1.0, 6, flat), "INITIATE", "boundary is inclusive");
  assert.equal(call(-1.5, 8, flat), "INITIATE", "short side initiates too");
  assert.equal(call(0.9, 8, flat), "STAND_ASIDE", "d below d_initiate");
  assert.equal(call(1.5, 5, flat), "STAND_ASIDE", "conv below conv_initiate");
});

test("open and agreeing: add, hold, or trim by conviction", () => {
  assert.equal(call(1.5, 8, long(2)), "ADD");
  assert.equal(call(1.0, 7, long(2)), "ADD", "boundary is inclusive");
  assert.equal(call(1.5, 8, long(4)), "HOLD", "max_units reached blocks ADD");
  assert.equal(call(0.5, 8, long(1)), "HOLD", "d below d_add blocks ADD");
  assert.equal(call(1.5, 5, long(1)), "HOLD", "conv below conv_add");
  assert.equal(call(1.5, 4, long(1)), "HOLD", "conv_hold boundary is inclusive");
  assert.equal(call(1.5, 3, long(1)), "TRIM", "conv below conv_hold");
});

test("open and agreeing works identically for shorts", () => {
  assert.equal(call(-1.5, 8, short(2)), "ADD");
  assert.equal(call(-1.5, 3, short(2)), "TRIM");
});

test("open and opposed: exit on a strong reversal, trim on a weak one", () => {
  assert.equal(call(-1.5, 8, long(2)), "EXIT");
  assert.equal(call(-1.0, 2, long(2)), "EXIT", "boundary is inclusive, conv irrelevant");
  assert.equal(call(-0.5, 8, long(2)), "TRIM");
  assert.equal(call(1.5, 8, short(2)), "EXIT");
  assert.equal(call(0.5, 8, short(2)), "TRIM");
});

test("d of exactly zero counts as opposing an open position", () => {
  assert.equal(call(0, 8, long(1)), "TRIM");
});

test("cluster params override the defaults", () => {
  const strict = { ...DEFAULT_PARAMS, conv_initiate: 9 };
  assert.equal(deriveDirective(1.5, 8, flat, strict), "STAND_ASIDE");
});

test("formatPosition renders side and unit count", () => {
  assert.equal(formatPosition(flat), "flat");
  assert.equal(formatPosition(long(2)), "long:2");
  assert.equal(formatPosition(short(1)), "short:1");
});
