import { test } from "node:test";
import assert from "node:assert/strict";
import { JanusError, envelope } from "./output.ts";

test("envelope wraps data in an ok result", () => {
  assert.deepEqual(envelope({ symbol: "BTC" }), { ok: true, data: { symbol: "BTC" } });
});

test("envelope renders a JanusError with its code", () => {
  const e = new JanusError("NOT_FOUND", "no asset BTC");
  assert.deepEqual(envelope(e), {
    ok: false,
    error: { code: "NOT_FOUND", message: "no asset BTC" },
  });
});

test("envelope renders an unknown error as VALIDATION-free INTERNAL", () => {
  assert.deepEqual(envelope(new Error("boom")), {
    ok: false,
    error: { code: "INTERNAL", message: "boom" },
  });
});
