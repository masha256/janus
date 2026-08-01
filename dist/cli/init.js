import { Command } from "commander";
import { migrate } from "../db/migrate.js";
import { dbPath } from "../db/connect.js";
import { handler, withDb } from "./command.js";
export function build(emit) {
    return new Command("init")
        .description("Create the database, or migrate an existing one to the current schema")
        .action(async () => emit(await init()));
}
function init() {
    return withDb((db) => ({ database: dbPath(), schema_version: migrate(db) }));
}
export const handle = handler(build);
