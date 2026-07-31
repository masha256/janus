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
    return { ok: false, error: { code: "INTERNAL", message: value.message } };
  }
  return { ok: true, data: value };
}

export function emit(data: unknown): void {
  process.stdout.write(JSON.stringify(envelope(data)) + "\n");
}

export function fail(err: unknown): void {
  const e = err instanceof Error ? err : new Error(String(err));
  process.stdout.write(JSON.stringify(envelope(e)) + "\n");
  process.exitCode = 1;
}
