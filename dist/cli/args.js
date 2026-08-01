import { readFileSync } from "node:fs";
import { JanusError } from "../output.js";
/** A free-text flag; the literal `-` means "read the value from stdin". */
export function readText(value) {
    if (value === undefined)
        return undefined;
    if (value === "-")
        return readFileSync(0, "utf8").trim();
    return value;
}
export function required(value, flag) {
    if (value === undefined || value.trim() === "") {
        throw new JanusError("VALIDATION", `missing required flag --${flag}`);
    }
    return value;
}
export function num(raw, flag, min, max) {
    const n = Number(required(raw, flag));
    if (!Number.isFinite(n)) {
        throw new JanusError("VALIDATION", `--${flag} must be a number, got ${raw}`);
    }
    if (n < min || n > max) {
        throw new JanusError("VALIDATION", `--${flag} must be between ${min} and ${max}, got ${n}`);
    }
    return n;
}
/** A price, size, or money amount: finite and strictly greater than zero. */
export function positive(raw, flag) {
    const n = Number(required(raw, flag));
    if (!Number.isFinite(n)) {
        throw new JanusError("VALIDATION", `--${flag} must be a number, got ${raw}`);
    }
    if (n <= 0) {
        throw new JanusError("VALIDATION", `--${flag} must be greater than zero, got ${n}`);
    }
    return n;
}
/** A tunable parameter value: any finite number, since weights may be negative. */
export function finite(raw, flag) {
    const n = Number(required(raw, flag));
    if (!Number.isFinite(n)) {
        throw new JanusError("VALIDATION", `${flag} must be a number, got ${raw}`);
    }
    return n;
}
export function oneOf(raw, flag, allowed) {
    const v = required(raw, flag);
    if (!allowed.includes(v)) {
        throw new JanusError("VALIDATION", `--${flag} must be one of ${allowed.join(", ")}, got ${v}`);
    }
    return v;
}
/** The tail of every command module: names the verbs, and says so differently when none was given. */
export function unknownVerb(verb, noun, verbs) {
    return new JanusError("VALIDATION", verb === undefined
        ? `${noun} requires a verb; try: ${verbs}`
        : `unknown verb "${verb}" for ${noun}; try: ${verbs}`);
}
/** `--asset BTC,ETH` → ["BTC","ETH"]; absent → undefined (meaning "all"). */
export function csv(raw) {
    if (raw === undefined)
        return undefined;
    const parts = raw.split(",").map((s) => s.trim()).filter((s) => s !== "");
    if (parts.length === 0)
        throw new JanusError("VALIDATION", "--asset was empty");
    return parts;
}
/**
 * `--metric` values: numeric when they parse as a number, free text otherwise
 * (`--metric judgement="rolling over"`). Text lands in the metric table's
 * value_text; numbers in value_num.
 */
export function metricPairs(raw, flag) {
    const out = {};
    for (const item of raw ?? []) {
        const eq = item.indexOf("=");
        if (eq <= 0) {
            throw new JanusError("VALIDATION", `--${flag} must be key=value, got ${item}`);
        }
        const value = item.slice(eq + 1);
        // "" parses as 0 in JS; an empty metric is a mistake, not a zero.
        out[item.slice(0, eq)] = value.trim() !== "" && Number.isFinite(Number(value))
            ? Number(value)
            : value;
    }
    return out;
}
/** `["catalyst=1.5","trend=-0.5"]` → { catalyst: 1.5, trend: -0.5 } */
export function pairs(raw, flag) {
    const out = {};
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
