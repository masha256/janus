import type { Command } from "commander";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../db/connect.ts";

/** Where a command's result goes. `main` prints it; tests capture it. */
export type Emit = (data: unknown) => void;
export type Build = (emit: Emit) => Command;

/** `--metric k=v --metric j=w` → ["k=v", "j=w"]. No declared default, so help stays clean. */
export function collect(value: string, previous: string[] = []): string[] {
  return previous.concat(value);
}

/** One connection per command, closed however the action ends. */
export async function withDb<T>(fn: (db: DatabaseSync) => T | Promise<T>): Promise<T> {
  const db = openDb();
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

/**
 * Commander must never exit the process or write on its own: janus owns the
 * output contract and the exit code, so errors come back as thrown
 * CommanderErrors for `envelope` to render. `writeOut` is where help text goes
 * — nowhere at all under `handle`, stdout under `main`.
 */
export function strict(cmd: Command, writeOut: (s: string) => void = () => {}): Command {
  cmd.exitOverride();
  cmd.configureOutput({ writeOut, writeErr: () => {} });
  for (const sub of cmd.commands) strict(sub, writeOut);
  return cmd;
}

/**
 * The direct entry point every command module exposes: run one noun's verbs
 * and return what the action emitted, rather than printing it. This is what
 * the tests drive, and it keeps them independent of argv and of stdout.
 */
export function handler(build: Build) {
  return async (verb: string | undefined, argv: string[]): Promise<unknown> => {
    let result: unknown;
    const cmd = strict(build((data) => { result = data; }));
    await cmd.parseAsync(verb === undefined ? [] : [verb, ...argv], { from: "user" });
    return result;
  };
}
