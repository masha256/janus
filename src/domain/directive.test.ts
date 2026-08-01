import { test } from "node:test";
import assert from "node:assert/strict";
import { formatPosition } from "./directive.ts";
import type { PositionState } from "./directive.ts";

const flat: PositionState = { side: null, units: 0 };
const long = (units: number): PositionState => ({ side: "long", units });
const short = (units: number): PositionState => ({ side: "short", units });

test("formatPosition renders side and unit count", () => {
  assert.equal(formatPosition(flat), "flat");
  assert.equal(formatPosition(long(2)), "long:2");
  assert.equal(formatPosition(short(1)), "short:1");
});
