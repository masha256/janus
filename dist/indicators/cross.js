/**
 * Walks two aligned series and reports the current side plus how many bars it
 * has held. Bars where either series is null are skipped entirely, so a short
 * history simply yields a smaller age rather than a wrong one.
 */
function sideRun(length, sideAt) {
    let state = null;
    let age = null;
    for (let i = 0; i < length; i++) {
        const side = sideAt(i);
        if (side === null)
            continue;
        if (side === state)
            age = (age ?? 0) + 1;
        else {
            state = side;
            age = 0;
        }
    }
    return { state, age };
}
export function maCross(fast, slow) {
    return sideRun(Math.min(fast.length, slow.length), (i) => {
        const f = fast[i];
        const s = slow[i];
        if (f == null || s == null)
            return null;
        return f >= s ? "golden" : "death";
    });
}
export function priceVsMa(close, ma) {
    return sideRun(Math.min(close.length, ma.length), (i) => {
        const c = close[i];
        const m = ma[i];
        if (c == null || m == null)
            return null;
        return c >= m ? "above" : "below";
    });
}
