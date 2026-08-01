import { Command } from "commander";
import { migrate } from "../db/migrate.ts";
import { dbPath } from "../db/connect.ts";
import { type Emit, handler, withDb } from "./command.ts";

export function build(emit: Emit): Command {
  return new Command("init")
    .description("Create the database, or migrate an existing one to the current schema")
    .action(async () => emit(await init()));
}

function init(): Promise<unknown> {
  return withDb((db) => ({ database: dbPath(), schema_version: migrate(db) }));
}

export const handle = handler(build);
