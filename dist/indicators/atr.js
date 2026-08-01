/** Wilder's true range: the widest of today's range and the two gap measures. */
function trueRange(bar, prev) {
    const range = bar.h - bar.l;
    if (prev === undefined)
        return range;
    return Math.max(range, Math.abs(bar.h - prev.c), Math.abs(bar.l - prev.c));
}
/** Simple mean of the trailing `period` true ranges. Null if history is short. */
export function atr(bars, period) {
    if (bars.length < period || period < 1)
        return null;
    const tr = bars.map((b, i) => trueRange(b, bars[i - 1]));
    const window = tr.slice(-period);
    return window.reduce((a, b) => a + b, 0) / period;
}
