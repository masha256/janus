import { JanusError } from "../output.js";
export const LIGHTER_BASE_URL = "https://mainnet.zklighter.elliot.ai";
/** Lighter returns some numerics as strings; anything unparseable becomes null. */
function toNum(value) {
    if (value === null || value === undefined || value === "")
        return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}
function required(value, field) {
    const n = toNum(value);
    if (n === null)
        throw new JanusError("UPSTREAM", `missing numeric field ${field}`);
    return n;
}
function arrayAt(json, key) {
    const value = json?.[key];
    if (!Array.isArray(value))
        throw new JanusError("UPSTREAM", `expected ${key} array in response`);
    return value;
}
export function parseMarkets(json) {
    return arrayAt(json, "order_books").map((raw) => {
        const m = raw;
        return {
            symbol: String(m["symbol"]),
            market_id: required(m["market_id"], "market_id"),
            market_type: String(m["market_type"]),
            status: String(m["status"]),
            price_decimals: required(m["supported_price_decimals"], "supported_price_decimals"),
            size_decimals: required(m["supported_size_decimals"], "supported_size_decimals"),
            listed_at: new Date(required(m["created_at"], "created_at")).toISOString().slice(0, 10),
        };
    });
}
export function parseSnapshot(json) {
    const [raw] = arrayAt(json, "order_book_details");
    if (raw === undefined)
        throw new JanusError("UPSTREAM", "empty order_book_details array");
    const d = raw;
    return {
        mark_price: toNum(d["mark_price"]),
        index_price: toNum(d["index_price"]),
        last_trade_price: toNum(d["last_trade_price"]),
        daily_price_low: toNum(d["daily_price_low"]),
        daily_price_high: toNum(d["daily_price_high"]),
        daily_price_change: toNum(d["daily_price_change"]),
        open_interest: toNum(d["open_interest"]),
    };
}
export function parseBars(json) {
    const raw = json?.["c"];
    if (!Array.isArray(raw))
        throw new JanusError("UPSTREAM", "expected candles array `c` in response");
    return raw
        .map((item) => {
        const b = item;
        return {
            t: required(b["t"], "t"),
            o: required(b["o"], "o"),
            h: required(b["h"], "h"),
            l: required(b["l"], "l"),
            c: required(b["c"], "c"),
            v: toNum(b["v"]) ?? 0,
            i: toNum(b["i"]) ?? 0,
        };
    })
        .sort((a, b) => a.t - b.t);
}
export function createLighterClient(baseUrl = LIGHTER_BASE_URL, fetchImpl = fetch) {
    async function get(path, params = {}) {
        const url = new URL(`/api/v1/${path}`, baseUrl);
        for (const [k, v] of Object.entries(params))
            url.searchParams.set(k, v);
        let res;
        try {
            res = await fetchImpl(url);
        }
        catch (cause) {
            throw new JanusError("UPSTREAM", `${path} request failed: ${cause.message}`);
        }
        if (!res.ok)
            throw new JanusError("UPSTREAM", `${path} returned HTTP ${res.status}`);
        return res.json();
    }
    return {
        async fetchMarkets() {
            return parseMarkets(await get("orderBooks"));
        },
        async fetchSnapshot(marketId) {
            return parseSnapshot(await get("orderBookDetails", { market_id: String(marketId) }));
        },
        async fetchDailyBars(marketId, lookbackDays = 400) {
            const end = Date.now();
            const start = end - lookbackDays * 86_400_000;
            return parseBars(await get("candles", {
                market_id: String(marketId),
                resolution: "1d",
                start_timestamp: String(start),
                end_timestamp: String(end),
                count_back: "0",
                set_timestamp_to_end: "false",
            }));
        },
    };
}
