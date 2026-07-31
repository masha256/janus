import { DatabaseSync } from "node:sqlite";

export function openDb(path?: string): DatabaseSync {
  const file = path ?? process.env["JANUS_DB"] ?? "./janus.db";
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  return db;
}
