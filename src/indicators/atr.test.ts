import { test } from "node:test";
import assert from "node:assert/strict";
import { atr } from "./atr.ts";
import type { Bar } from "../types.ts";

const bar = (h: number, l: number, c: number): Bar => ({ t: 0, o: c, h, l, c, v: 0, i: 0 });

test("atr over a constant range equals that range", () => {
  const bars = Array.from({ length: 20 }, () => bar(11, 9, 10));
  assert.equal(atr(bars, 14), 2);
});

test("atr accounts for gaps via the previous close", () => {
  // Two bars: first range 2, second bar gaps up so TR = high - prevClose = 20 - 10 = 10
  const bars: Bar[] = [bar(11, 9, 10), bar(20, 19, 19)];
  assert.equal(atr(bars, 2), 6); // (2 + 10) / 2
});

test("atr returns null when there are fewer bars than the period", () => {
  assert.equal(atr([bar(11, 9, 10)], 14), null);
});
