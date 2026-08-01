import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../connect.ts";
import { migrate } from "../migrate.ts";
import { ensureSession, getSession, requireSession, resolveSession, readSessionDate, listSessions, stampPhase } from "./session.ts";

const NOW = "2026-07-31T12:00:00Z";

function fresh() {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

test("ensureSession creates a session then returns the same one", () => {
  const db = fresh();
  const a = ensureSession(db, "2026-07-31", NOW);
  const b = ensureSession(db, "2026-07-31", "2026-07-31T18:00:00Z");
  assert.equal(a.session_date, "2026-07-31");
  assert.equal(b.opened_at, NOW, "opened_at must not be overwritten");
  assert.equal(listSessions(db, 10).length, 1);
  db.close();
});

test("a new session has every phase timestamp null", () => {
  const db = fresh();
  const s = ensureSession(db, "2026-07-31", NOW);
  assert.deepEqual(
    [s.macro_at, s.cluster_read_at, s.coverage_at, s.screen_at, s.score_at],
    [null, null, null, null, null],
  );
  db.close();
});

test("stampPhase records completion", () => {
  const db = fresh();
  ensureSession(db, "2026-07-31", NOW);
  stampPhase(db, "2026-07-31", "macro", NOW);
  assert.equal(requireSession(db, "2026-07-31").macro_at, NOW);
  db.close();
});

test("requireSession throws SESSION_MISSING for an unknown date", () => {
  const db = fresh();
  assert.throws(
    () => requireSession(db, "1999-01-01"),
    (e: Error & { code?: string }) => e.code === "SESSION_MISSING",
  );
  db.close();
});

test("resolveSession without --date creates today's session", () => {
  const db = fresh();
  const s = resolveSession(db, undefined, NOW);
  assert.equal(getSession(db, s.session_date)?.session_date, s.session_date);
  db.close();
});

test("resolveSession with --date requires the session to exist already", () => {
  const db = fresh();
  assert.throws(
    () => resolveSession(db, "2026-01-01", NOW),
    (e: Error & { code?: string }) => e.code === "SESSION_MISSING",
  );
  ensureSession(db, "2026-01-01", NOW);
  assert.equal(resolveSession(db, "2026-01-01", NOW).session_date, "2026-01-01");
  db.close();
});

test("listSessions returns newest first and honours the limit", () => {
  const db = fresh();
  ensureSession(db, "2026-07-29", NOW);
  ensureSession(db, "2026-07-31", NOW);
  ensureSession(db, "2026-07-30", NOW);
  assert.deepEqual(listSessions(db, 2).map((s) => s.session_date), ["2026-07-31", "2026-07-30"]);
  db.close();
});

test("readSessionDate resolves today without creating a session", () => {
  const db = fresh();
  const date = readSessionDate(db, undefined, NOW);
  assert.equal(date, "2026-07-31", "12:00Z is still the 31st in New York");
  assert.equal(listSessions(db, 10).length, 0, "a read must not open a session");
  db.close();
});

test("readSessionDate with --date still requires the session to exist", () => {
  const db = fresh();
  assert.throws(
    () => readSessionDate(db, "1999-01-01", NOW),
    (e: Error & { code?: string }) => e.code === "SESSION_MISSING",
  );
  db.close();
});
