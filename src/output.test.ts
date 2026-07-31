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

test("envelope renders a parseArgs error as VALIDATION, preserving the message", () => {
  const e = new Error("Unknown option '--bogus'") as Error & { code: string };
  e.code = "ERR_PARSE_ARGS_UNKNOWN_OPTION";
  assert.deepEqual(envelope(e), {
    ok: false,
    error: { code: "VALIDATION", message: "Unknown option '--bogus'" },
  });
});

test("envelope does not match a plain Error with no code as VALIDATION", () => {
  assert.deepEqual(envelope(new Error("boom")), {
    ok: false,
    error: { code: "INTERNAL", message: "boom" },
  });
});

test("envelope still prefers JanusError over the parseArgs branch", () => {
  const e = new JanusError("SESSION_MISSING", "no session");
  assert.deepEqual(envelope(e), {
    ok: false,
    error: { code: "SESSION_MISSING", message: "no session" },
  });
});
