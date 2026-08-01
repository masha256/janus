import { JanusError } from "../output.js";
/** A numeric metric, or `fallback` when it is absent or was recorded as text. */
export function num(metrics, key, fallback = 0) {
    const v = metrics[key];
    return typeof v === "number" ? v : fallback;
}
/**
 * The metrics a formula cannot work without. Only the domain knows which those
 * are — the CLI hands over whatever `--metric` pairs it was given and lets the
 * formula refuse. Swapping a formula therefore swaps its requirements with it.
 */
export function requireNum(metrics, key, min, max) {
    const v = metrics[key];
    if (typeof v !== "number") {
        throw new JanusError("VALIDATION", `--metric ${key}=<number> is required, got ${v ?? "nothing"}`);
    }
    if (v < min || v > max) {
        throw new JanusError("VALIDATION", `--metric ${key} must be between ${min} and ${max}, got ${v}`);
    }
    return v;
}
export function requireText(metrics, key) {
    const v = metrics[key];
    if (typeof v !== "string" || v.trim() === "") {
        throw new JanusError("VALIDATION", `--metric ${key}=<text> is required`);
    }
    return v;
}
