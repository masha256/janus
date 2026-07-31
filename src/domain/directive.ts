export type Directive = "INITIATE" | "ADD" | "HOLD" | "TRIM" | "EXIT" | "STAND_ASIDE";
export type PositionState = { side: "long" | "short" | null; units: number };

export function formatPosition(pos: PositionState): string {
  return pos.side === null ? "flat" : `${pos.side}:${pos.units}`;
}

/** v1 placeholder — see the spec's directive table. Replacing it touches only this file. */
export function deriveDirective(
  d: number,
  conv: number,
  pos: PositionState,
  params: Record<string, number>,
): Directive {
  const p = (key: string): number => params[key] ?? 0;

  if (pos.side === null) {
    return Math.abs(d) >= p("d_initiate") && conv >= p("conv_initiate")
      ? "INITIATE"
      : "STAND_ASIDE";
  }

  const agrees = pos.side === "long" ? d > 0 : d < 0;

  if (!agrees) return Math.abs(d) >= p("d_exit") ? "EXIT" : "TRIM";
  if (conv >= p("conv_add") && Math.abs(d) >= p("d_add") && pos.units < p("max_units")) return "ADD";
  if (conv >= p("conv_hold")) return "HOLD";
  return "TRIM";
}
