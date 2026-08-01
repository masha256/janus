import { Command } from "commander";
import { setClusterParam, getGlobalParams } from "../db/repo/cluster.js";
import { resolveParams } from "../domain/params.js";
import { finite, required, unknownVerb } from "./args.js";
import { handler, withDb } from "./command.js";
/**
 * The middle rung of the cluster_param → global_param → default chain.
 * `cluster set-param` writes the top rung; this writes the one that applies to
 * every asset, including those with no cluster at all.
 */
export function build(emit) {
    const cmd = new Command("param")
        .description("Global parameters, the middle rung of the resolution chain")
        // passThroughOptions on the positional-value verbs needs this on the parent.
        .enablePositionalOptions()
        .action(() => { throw unknownVerb(undefined, "param", "set, list"); });
    cmd.command("set")
        .description("Write a global parameter")
        .argument("[key]", "parameter name, e.g. w_catalyst")
        .argument("[value]", "any finite number; weights may be negative")
        // Both are positional so a negative value needs no escaping, and
        // passThroughOptions is what stops commander reading `-2` as an option.
        .passThroughOptions()
        .action(async (key, value) => emit(await set(key, value)));
    cmd.command("list")
        .description("Show the global layer and the values it resolves to")
        .action(async () => emit(await list()));
    return cmd;
}
function set(key, value) {
    return withDb((db) => {
        setClusterParam(db, null, required(key, "key"), finite(value, "value"));
        return { params: getGlobalParams(db) };
    });
}
function list() {
    return withDb((db) => {
        const global = getGlobalParams(db);
        return { global, resolved: resolveParams({}, global) };
    });
}
export const handle = handler(build);
