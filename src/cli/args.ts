import { readFileSync } from "node:fs";
import { JanusError } from "../output.ts";

/** A free-text flag; the literal `-` means "read the value from stdin". */
export function readText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value === "-") return readFileSync(0, "utf8").trim();
  return value;
}

export function required(value: string | undefined, flag: string): string {
  if (value === undefined || value === "") {
    throw new JanusError("VALIDATION", `missing required flag --${flag}`);
  }
  return value;
}

export function num(raw: string | undefined, flag: string, min: number, max: number): number {
  const n = Number(required(raw, flag));
  if (!Number.isFinite(n)) {
    throw new JanusError("VALIDATION", `--${flag} must be a number, got ${raw}`);
  }
  if (n < min || n > max) {
    throw new JanusError("VALIDATION", `--${flag} must be between ${min} and ${max}, got ${n}`);
  }
  return n;
}

export function oneOf<T extends string>(
  raw: string | undefined,
  flag: string,
  allowed: readonly T[],
): T {
  const v = required(raw, flag);
  if (!allowed.includes(v as T)) {
    throw new JanusError("VALIDATION", `--${flag} must be one of ${allowed.join(", ")}, got ${v}`);
  }
  return v as T;
}

/** `--asset BTC,ETH` → ["BTC","ETH"]; absent → undefined (meaning "all"). */
export function csv(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const parts = raw.split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (parts.length === 0) throw new JanusError("VALIDATION", "--asset was empty");
  return parts;
}

/** `["catalyst=1.5","trend=-0.5"]` → { catalyst: 1.5, trend: -0.5 } */
export function pairs(raw: string[] | undefined, flag: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of raw ?? []) {
    const eq = item.indexOf("=");
    if (eq <= 0) {
      throw new JanusError("VALIDATION", `--${flag} must be key=value, got ${item}`);
    }
    const key = item.slice(0, eq);
    const n = Number(item.slice(eq + 1));
    if (!Number.isFinite(n)) {
      throw new JanusError("VALIDATION", `--${flag} ${key} must be a number, got ${item.slice(eq + 1)}`);
    }
    out[key] = n;
  }
  return out;
}
