import { openDb } from "../db/connect.ts";
import { migrate } from "../db/migrate.ts";

export async function handle(): Promise<unknown> {
  const db = openDb();
  const version = migrate(db);
  const file = process.env["JANUS_DB"] ?? "./janus.db";
  db.close();
  return { database: file, schema_version: version };
}
