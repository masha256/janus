import { Command } from "commander";
import {
  ASSET_CLASSES, addAsset, listAssets, requireAssetBySymbol,
  updateAsset, setAssetActive, removeAsset,
} from "../db/repo/asset.ts";
import { nowIso } from "../domain/session.ts";
import { readText, required, oneOf, unknownVerb } from "./args.ts";
import { type Emit, handler, withDb } from "./command.ts";

const CLASSES = ASSET_CLASSES.join(" | ");

type AddOpts = { class?: string; cluster?: string; notes?: string };
type ListOpts = { active?: boolean; inactive?: boolean; cluster?: string; class?: string };
type SetOpts = { cluster?: string; class?: string; notes?: string };

export function build(emit: Emit): Command {
  const cmd = new Command("asset")
    .description("The roster: which markets janus tracks")
    .action(() => {
      throw unknownVerb(undefined, "asset", "add, list, show, set, activate, deactivate, rm");
    });

  cmd.command("add")
    .description("Add a market to the roster")
    .argument("[symbol]", "market symbol, e.g. BTC")
    .option("--class <CLASS>", CLASSES)
    .option("--cluster <KEY>", "cluster to file it under")
    .option("--notes <TEXT>", "free text; - reads stdin")
    .action(async (symbol: string | undefined, opts: AddOpts) => emit(await add(symbol, opts)));

  cmd.command("list")
    .description("List roster entries")
    .option("--active", "only active entries")
    .option("--inactive", "only deactivated entries")
    .option("--cluster <KEY>", "only this cluster")
    .option("--class <CLASS>", CLASSES)
    .action(async (opts: ListOpts) => emit(await list(opts)));

  cmd.command("show")
    .description("Show one roster entry")
    .argument("[symbol]", "market symbol")
    .action(async (symbol: string | undefined) =>
      emit(await withDb((db) => requireAssetBySymbol(db, upper(symbol)))));

  cmd.command("set")
    .description("Change an entry's cluster, class, or notes")
    .argument("[symbol]", "market symbol")
    .option("--cluster <KEY>", "move it to this cluster")
    .option("--class <CLASS>", CLASSES)
    .option("--notes <TEXT>", "free text; - reads stdin")
    .action(async (symbol: string | undefined, opts: SetOpts) => emit(await set(symbol, opts)));

  cmd.command("activate")
    .description("Return an entry to the eligible set")
    .argument("[symbol]", "market symbol")
    .action(async (symbol: string | undefined) => emit(await active(symbol, true)));

  cmd.command("deactivate")
    .description("Drop an entry out of the eligible set without deleting it")
    .argument("[symbol]", "market symbol")
    .action(async (symbol: string | undefined) => emit(await active(symbol, false)));

  cmd.command("rm")
    .description("Remove an entry; refused once it has trades")
    .argument("[symbol]", "market symbol")
    .action(async (symbol: string | undefined) => emit(await remove(symbol)));

  return cmd;
}

const upper = (symbol: string | undefined): string => required(symbol, "symbol").toUpperCase();

function add(symbol: string | undefined, opts: AddOpts): Promise<unknown> {
  return withDb((db) => addAsset(
    db,
    upper(symbol),
    oneOf(opts.class, "class", ASSET_CLASSES),
    opts.cluster ?? null,
    readText(opts.notes) ?? null,
    nowIso(),
  ));
}

function list(opts: ListOpts): Promise<unknown> {
  return withDb((db) => {
    const active = opts.active === true ? true : opts.inactive === true ? false : undefined;
    const assets = listAssets(db, { active, cls: opts.class, clusterKey: opts.cluster });
    return { count: assets.length, assets };
  });
}

function set(symbol: string | undefined, opts: SetOpts): Promise<unknown> {
  return withDb((db) => {
    if (opts.class !== undefined) oneOf(opts.class, "class", ASSET_CLASSES);
    return updateAsset(db, upper(symbol), {
      cls: opts.class,
      clusterKey: opts.cluster,
      notes: readText(opts.notes),
    });
  });
}

function active(symbol: string | undefined, on: boolean): Promise<unknown> {
  return withDb((db) => setAssetActive(db, upper(symbol), on));
}

function remove(symbol: string | undefined): Promise<unknown> {
  return withDb((db) => {
    removeAsset(db, upper(symbol));
    return { removed: symbol };
  });
}

export const handle = handler(build);
