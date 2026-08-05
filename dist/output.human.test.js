import { test } from "node:test";
import assert from "node:assert/strict";
import { renderHuman } from "./output.js";
test("scalars render as key: value lines", () => {
    assert.equal(renderHuman({ session_date: "2026-08-01", count: 2, phase_complete: true }), "session_date: 2026-08-01\ncount: 2\nphase_complete: true");
});
test("a metric bag collapses to k=v, and null reads as a dash", () => {
    assert.equal(renderHuman({ metrics: { score: 1.5, judgement: "thin" }, rationale: null }), "metrics: score=1.5 judgement=thin\nrationale: -");
});
test("a list of records becomes an aligned table under its key", () => {
    const rows = [
        { symbol: "BTC", direction: 2 },
        { symbol: "ETHEREUM", direction: -1.25 },
    ];
    assert.equal(renderHuman({ count: 2, scores: rows }), [
        "count: 2",
        "scores (2):",
        "  symbol    direction",
        "  --------  ---------",
        "  BTC       2",
        "  ETHEREUM  -1.25",
    ].join("\n"));
});
test("rows with different keys share one header, and gaps read as dashes", () => {
    assert.equal(renderHuman([{ a: 1 }, { b: 2 }]), ["a  b", "-  -", "1  -", "-  2"].join("\n"));
});
test("an empty result says so rather than rendering nothing", () => {
    assert.equal(renderHuman({ count: 0, trades: [] }), "count: 0\ntrades: -");
    assert.equal(renderHuman({ global: {} }), "global: -", "no trailing whitespace");
    assert.equal(renderHuman([]), "(none)");
    assert.equal(renderHuman(null), "");
});
test("a wide nested object breaks onto its own indented block", () => {
    // The phases bag on `session status` is the real case: five keys, one per line.
    assert.equal(renderHuman({ phases: { macro: "t1", cluster_read: null, coverage: null, screen: null, score: null } }), ["phases:", "  macro: t1", "  cluster_read: -", "  coverage: -", "  screen: -", "  score: -"].join("\n"));
});
