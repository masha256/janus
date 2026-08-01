import { test } from "node:test";
import assert from "node:assert/strict";
import { JanusError, envelope } from "./output.js";
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
test("envelope renders a commander usage error as VALIDATION, minus its prefix", () => {
    const e = new Error("error: unknown option '--bogus'");
    e.code = "commander.unknownOption";
    assert.deepEqual(envelope(e), {
        ok: false,
        // The "error: " prefix is commander's own; the envelope already says as much.
        error: { code: "VALIDATION", message: "unknown option '--bogus'" },
    });
});
test("envelope does not match a plain Error with no code as VALIDATION", () => {
    assert.deepEqual(envelope(new Error("boom")), {
        ok: false,
        error: { code: "INTERNAL", message: "boom" },
    });
});
test("envelope still prefers JanusError over the commander branch", () => {
    const e = new JanusError("SESSION_MISSING", "no session");
    assert.deepEqual(envelope(e), {
        ok: false,
        error: { code: "SESSION_MISSING", message: "no session" },
    });
});
