export function formatPosition(pos) {
    return pos.side === null ? "flat" : `${pos.side}:${pos.units}`;
}
