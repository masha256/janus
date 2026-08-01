import { openDb } from "../db/connect.js";
/** `--metric k=v --metric j=w` → ["k=v", "j=w"]. No declared default, so help stays clean. */
export function collect(value, previous = []) {
    return previous.concat(value);
}
/** One connection per command, closed however the action ends. */
export async function withDb(fn) {
    const db = openDb();
    try {
        return await fn(db);
    }
    finally {
        db.close();
    }
}
/**
 * Commander must never exit the process or write on its own: janus owns the
 * output contract and the exit code, so errors come back as thrown
 * CommanderErrors for `envelope` to render. `writeOut` is where help text goes
 * — nowhere at all under `handle`, stdout under `main`.
 */
export function strict(cmd, writeOut = () => { }) {
    cmd.exitOverride();
    cmd.configureOutput({ writeOut, writeErr: () => { } });
    for (const sub of cmd.commands)
        strict(sub, writeOut);
    return cmd;
}
/**
 * The direct entry point every command module exposes: run one noun's verbs
 * and return what the action emitted, rather than printing it. This is what
 * the tests drive, and it keeps them independent of argv and of stdout.
 */
export function handler(build) {
    return async (verb, argv) => {
        let result;
        const cmd = strict(build((data) => { result = data; }));
        await cmd.parseAsync(verb === undefined ? [] : [verb, ...argv], { from: "user" });
        return result;
    };
}
