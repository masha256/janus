import { parseArgs } from "node:util";
import { openDb } from "../db/connect.ts";
import {
  ASSET_CLASSES, addAsset, listAssets, requireAssetBySymbol,
  updateAsset, setAssetActive, removeAsset,
} from "../db/repo/asset.ts";
import { nowIso } from "../domain/session.ts";
import { readText, required, oneOf } from "./args.ts";
import { JanusError } from "../output.ts";

export async function handle(verb: string | undefined, argv: string[]): Promise<unknown> {
  const db = openDb();
  try {
    const [symbol, ...rest] = argv;

    if (verb === "add") {
      const { values } = parseArgs({
        args: rest,
        options: { class: { type: "string" }, cluster: { type: "string" }, notes: { type: "string" } },
      });
      return addAsset(
        db,
        required(symbol, "symbol").toUpperCase(),
        oneOf(values.class, "class", ASSET_CLASSES),
        values.cluster ?? null,
        readText(values.notes) ?? null,
        nowIso(),
      );
    }
    if (verb === "list") {
      const { values } = parseArgs({
        args: argv,
        options: {
          active: { type: "boolean" }, inactive: { type: "boolean" },
          cluster: { type: "string" }, class: { type: "string" },
        },
      });
      const active = values.active === true ? true : values.inactive === true ? false : undefined;
      const assets = listAssets(db, { active, cls: values.class, clusterKey: values.cluster });
      return { count: assets.length, assets };
    }
    if (verb === "show") {
      return requireAssetBySymbol(db, required(symbol, "symbol").toUpperCase());
    }
    if (verb === "set") {
      const { values } = parseArgs({
        args: rest,
        options: { cluster: { type: "string" }, class: { type: "string" }, notes: { type: "string" } },
      });
      if (values.class !== undefined) oneOf(values.class, "class", ASSET_CLASSES);
      return updateAsset(db, required(symbol, "symbol").toUpperCase(), {
        cls: values.class,
        clusterKey: values.cluster,
        notes: readText(values.notes),
      });
    }
    if (verb === "activate" || verb === "deactivate") {
      return setAssetActive(db, required(symbol, "symbol").toUpperCase(), verb === "activate");
    }
    if (verb === "rm") {
      removeAsset(db, required(symbol, "symbol").toUpperCase());
      return { removed: symbol };
    }
    throw new JanusError(
      "VALIDATION",
      `unknown verb "${verb}" for asset; try: add, list, show, set, activate, deactivate, rm`,
    );
  } finally {
    db.close();
  }
}
