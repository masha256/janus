import { JanusError } from "../output.ts";

/**
 * The shape every phase records in: a flat key→value bag, numeric or free text,
 * written to the `_metric` tables (what was observed) and the `_result` tables
 * (what was concluded from it).
 */
export type Metrics = Record<string, number | string>;

/** A numeric metric, or `fallback` when it is absent or was recorded as text. */
export function num(metrics: Metrics, key: string, fallback = 0): number {
  const v = metrics[key];
  return typeof v === "number" ? v : fallback;
}

/**
 * The metrics a formula cannot work without. Only the domain knows which those
 * are — the CLI hands over whatever `--metric` pairs it was given and lets the
 * formula refuse. Swapping a formula therefore swaps its requirements with it.
 */
export function requireNum(metrics: Metrics, key: string, min: number, max: number): number {
  const v = metrics[key];
  if (typeof v !== "number") {
    throw new JanusError("VALIDATION", `--metric ${key}=<number> is required, got ${v ?? "nothing"}`);
  }
  if (v < min || v > max) {
    throw new JanusError("VALIDATION", `--metric ${key} must be between ${min} and ${max}, got ${v}`);
  }
  return v;
}

export function requireText(metrics: Metrics, key: string): string {
  const v = metrics[key];
  if (typeof v !== "string" || v.trim() === "") {
    throw new JanusError("VALIDATION", `--metric ${key}=<text> is required`);
  }
  return v;
}
