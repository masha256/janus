import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Fixed, not relative: `janus` is meant to run from anywhere, and a cwd-relative
 * default would silently address a different (empty) database depending on where
 * the operator happened to be standing.
 */
export const DEFAULT_DB = join(homedir(), ".janus", "janus.db");

/** Read from the environment on every call, so a test can point one command elsewhere. */
export function dbPath(override?: string): string {
  return override ?? process.env["JANUS_DB"] ?? DEFAULT_DB;
}

export function openDb(path?: string): DatabaseSync {
  const file = dbPath(path);
  // SQLite creates the file but not the directory holding it.
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  return db;
}
