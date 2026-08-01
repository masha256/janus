export type ErrorCode =
  | "NOT_FOUND"
  | "ALREADY_EXISTS"
  | "VALIDATION"
  | "PHASE_ORDER"
  | "SESSION_MISSING"
  | "NO_COVERAGE"
  | "NOT_FLAGGED"
  | "POSITION_CONFLICT"
  | "UPSTREAM"
  | "INSUFFICIENT_HISTORY"
  | "INTERNAL";

export class JanusError extends Error {
  code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export type Envelope =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: ErrorCode; message: string } };

export function envelope(value: unknown): Envelope {
  if (value instanceof JanusError) {
    return { ok: false, error: { code: value.code, message: value.message } };
  }
  if (value instanceof Error) {
    // Commander reports bad usage — unknown command, missing argument, bad
    // option — by throwing with a "commander.*" code. That is a VALIDATION
    // error in janus terms, and its message already names the fix.
    const code = (value as Error & { code?: string }).code;
    if (typeof code === "string" && code.startsWith("commander.")) {
      return { ok: false, error: { code: "VALIDATION", message: cleanUsage(value.message) } };
    }
    return { ok: false, error: { code: "INTERNAL", message: value.message } };
  }
  return { ok: true, data: value };
}

/** Commander prefixes its messages with "error: "; the envelope already says that. */
function cleanUsage(message: string): string {
  return message.startsWith("error: ") ? message.slice(7) : message;
}

export function emit(data: unknown, human = false): void {
  if (human) {
    const text = renderHuman(data);
    process.stdout.write(text === "" ? "" : text + "\n");
    return;
  }
  process.stdout.write(JSON.stringify(envelope(data)) + "\n");
}

export function fail(err: unknown, human = false): void {
  const e = err instanceof Error ? err : new Error(String(err));
  const result = envelope(e);
  if (human && result.ok === false) {
    process.stderr.write(`janus: ${result.error.message} (${result.error.code})\n`);
  } else {
    process.stdout.write(JSON.stringify(result) + "\n");
  }
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Human rendering
//
// One generic renderer rather than a formatter per command: scalars become
// `key: value` lines, a list of records becomes a table, and the metric/result
// bags collapse to `k=v` pairs. Nothing here knows what any command returns.
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A single table cell, or the right-hand side of a `key: value` line. */
function cell(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (Array.isArray(value)) {
    return value.length === 0 ? "-" : value.map(cell).join(", ");
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    return entries.length === 0 ? "-" : entries.map(([k, v]) => `${k}=${cell(v)}`).join(" ");
  }
  return String(value);
}

/** Column-aligned rows, with a header taken from the union of their keys. */
function table(rows: Record<string, unknown>[], indent: string): string {
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const widths = columns.map((c) =>
    Math.max(c.length, ...rows.map((r) => cell(r[c]).length)),
  );
  const line = (cells: string[]): string =>
    indent + cells.map((v, i) => v.padEnd(widths[i]!)).join("  ").trimEnd();
  return [
    line(columns),
    line(columns.map((_, i) => "-".repeat(widths[i]!))),
    ...rows.map((r) => line(columns.map((c) => cell(r[c])))),
  ].join("\n");
}

export function renderHuman(value: unknown, indent = ""): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) {
    if (value.length === 0) return `${indent}(none)`;
    return value.every(isRecord) ? table(value, indent) : indent + cell(value);
  }
  if (!isRecord(value)) return indent + cell(value);

  const lines: string[] = [];
  for (const [key, v] of Object.entries(value)) {
    if (Array.isArray(v) && v.length > 0 && v.every(isRecord)) {
      lines.push(`${indent}${key} (${v.length}):`, table(v, indent + "  "));
    } else if (isRecord(v) && Object.keys(v).length > 4) {
      lines.push(`${indent}${key}:`, renderHuman(v, indent + "  "));
    } else {
      lines.push(`${indent}${key}: ${cell(v)}`);
    }
  }
  return lines.join("\n");
}
