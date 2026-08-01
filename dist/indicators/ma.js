export function smaSeries(values, period) {
    // Without this guard a period <= 0 makes values[i - period] read past the end,
    // and the non-null assertion below turns that undefined into silent NaN.
    if (period < 1)
        return new Array(values.length).fill(null);
    const out = [];
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
        sum += values[i];
        if (i >= period)
            sum -= values[i - period];
        out.push(i >= period - 1 ? sum / period : null);
    }
    return out;
}
export function emaSeries(values, period) {
    const out = new Array(values.length).fill(null);
    if (values.length < period || period < 1)
        return out;
    const k = 2 / (period + 1);
    let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    out[period - 1] = prev;
    for (let i = period; i < values.length; i++) {
        prev = values[i] * k + prev * (1 - k);
        out[i] = prev;
    }
    return out;
}
const last = (series) => series.at(-1) ?? null;
export const sma = (values, period) => last(smaSeries(values, period));
export const ema = (values, period) => last(emaSeries(values, period));
