/** `NONE` is the default: a score that has not concluded what to do about the position. */
export type Directive = "NONE" | "INITIATE" | "ADD" | "HOLD" | "TRIM" | "EXIT" | "STAND_ASIDE";

export type PositionState = { side: "long" | "short" | null; units: number };

export function formatPosition(pos: PositionState): string {
  return pos.side === null ? "flat" : `${pos.side}:${pos.units}`;
}

/** An open position anywhere in the book, as the scoring formula sees it. */
export type OpenPosition = PositionState & {
  asset_id: number;
  symbol: string;
  side: "long" | "short";
};
