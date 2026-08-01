import { test } from "node:test";
import assert from "node:assert/strict";
import { todayNY, nextPhase, assertPhaseOrder, phaseColumn, PHASES } from "./session.ts";
import type { SessionRow } from "./session.ts";

const session = (over: Partial<SessionRow> = {}): SessionRow => ({
  session_date: "2026-07-31",
  opened_at: "2026-07-31T12:00:00Z",
  macro_at: null,
  cluster_at: null,
  coverage_at: null,
  screen_at: null,
  score_at: null,
  ...over,
});

test("todayNY converts a UTC instant to the New York calendar date", () => {
  // 03:30 UTC on Aug 1 is still Jul 31 in New York
  assert.equal(todayNY(new Date("2026-08-01T03:30:00Z")), "2026-07-31");
  assert.equal(todayNY(new Date("2026-07-31T23:30:00Z")), "2026-07-31");
  // 04:30 UTC on Aug 1 has rolled over (EDT is UTC-4)
  assert.equal(todayNY(new Date("2026-08-01T04:30:00Z")), "2026-08-01");
});

test("todayNY emits YYYY-MM-DD", () => {
  assert.match(todayNY(new Date("2026-01-05T18:00:00Z")), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(todayNY(new Date("2026-01-05T18:00:00Z")), "2026-01-05");
});

test("phaseColumn maps each phase to its timestamp column", () => {
  assert.equal(phaseColumn("macro"), "macro_at");
  assert.equal(phaseColumn("cluster"), "cluster_at");
  assert.equal(phaseColumn("score"), "score_at");
});

test("nextPhase walks the pipeline in order", () => {
  assert.equal(nextPhase(session()), "macro");
  assert.equal(nextPhase(session({ macro_at: "x" })), "cluster");
  assert.equal(nextPhase(session({ macro_at: "x", cluster_at: "x" })), "coverage");
  const done = session({
    macro_at: "x", cluster_at: "x", coverage_at: "x", screen_at: "x", score_at: "x",
  });
  assert.equal(nextPhase(done), null);
});

test("assertPhaseOrder allows a phase whose predecessors are complete", () => {
  assertPhaseOrder(session(), "macro", false);
  assertPhaseOrder(session({ macro_at: "x" }), "cluster", false);
});

test("assertPhaseOrder allows re-running a completed phase", () => {
  assertPhaseOrder(session({ macro_at: "x" }), "macro", false);
});

test("assertPhaseOrder rejects a phase with an incomplete prerequisite", () => {
  assert.throws(
    () => assertPhaseOrder(session(), "screen", false),
    (e: Error & { code?: string }) => e.code === "PHASE_ORDER" && /macro/.test(e.message),
  );
});

test("coverage depends on nothing: it may run before any read, or on its own", () => {
  assertPhaseOrder(session(), "coverage", false);
  assertPhaseOrder(session({ coverage_at: "x" }), "coverage", false);
});

test("everything downstream of coverage still waits for it", () => {
  // Reads done, no coverage: screening has nothing to screen.
  assert.throws(
    () => assertPhaseOrder(session({ macro_at: "x", cluster_at: "x" }), "screen", false),
    (e: Error & { code?: string }) => e.code === "PHASE_ORDER" && /coverage/.test(e.message),
  );
  // Coverage done, no reads: screening still wants the top-down context.
  assert.throws(
    () => assertPhaseOrder(session({ coverage_at: "x" }), "screen", false),
    (e: Error & { code?: string }) => e.code === "PHASE_ORDER" && /macro/.test(e.message),
  );
  assertPhaseOrder(session({ macro_at: "x", cluster_at: "x", coverage_at: "x" }), "screen", false);
});

test("assertPhaseOrder yields to --force", () => {
  assertPhaseOrder(session(), "score", true);
});

test("PHASES is the documented pipeline order", () => {
  // The recommended order, which is what nextPhase walks and session status
  // reports. It is not the dependency graph — see the coverage cases above.
  assert.deepEqual([...PHASES], ["macro", "cluster", "coverage", "screen", "score"]);
});
