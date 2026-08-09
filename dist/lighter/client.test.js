import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseMarkets, parseSnapshot, parseBars } from "./client.js";
const fixture = (name) => JSON.parse(readFileSync(new URL(`../../test/fixtures/${name}.json`, import.meta.url), "utf8"));
test("parseMarkets maps the catalog payload", () => {
    const markets = parseMarkets(fixture("orderBooks"));
    assert.ok(markets.length > 0);
    const m = markets[0];
    assert.equal(typeof m.symbol, "string");
    assert.equal(typeof m.market_id, "number");
    assert.equal(typeof m.price_decimals, "number");
    assert.equal(typeof m.size_decimals, "number");
    assert.match(m.listed_at, /^\d{4}-\d{2}-\d{2}$/, "created_at ms is converted to a date");
});
test("parseSnapshot coerces string prices to numbers", () => {
    const s = parseSnapshot(fixture("orderBookDetails"));
    assert.equal(typeof s.mark_price, "number");
    assert.equal(typeof s.index_price, "number");
    assert.equal(typeof s.open_interest, "number");
});
test("parseBars returns chronologically ordered bars", () => {
    const bars = parseBars(fixture("candles"));
    assert.ok(bars.length > 5, "fixture should hold a useful history");
    for (let i = 1; i < bars.length; i++) {
        assert.ok(bars[i].t > bars[i - 1].t, `bar ${i} is out of order`);
    }
    const b = bars[0];
    for (const k of ["t", "o", "h", "l", "c", "v", "i"]) {
        assert.equal(typeof b[k], "number", `bar.${k} should be a number`);
    }
});
test("parsers reject a payload that is not the expected shape", () => {
    assert.throws(() => parseMarkets({ code: 200 }), /order_books/);
    assert.throws(() => parseSnapshot({ code: 200, order_book_details: [] }), /order_book_details/);
    assert.throws(() => parseBars({ code: 200 }), /candles/);
});
test("fetchDailyBars requests a millisecond range and parses the reply", async () => {
    const calls = [];
    const fakeFetch = async (input) => {
        calls.push(String(input));
        return new Response(JSON.stringify(fixture("candles")), { status: 200 });
    };
    const { createLighterClient } = await import("./client.js");
    const client = createLighterClient("https://example.test", fakeFetch);
    const bars = await client.fetchDailyBars(1, 400);
    assert.ok(bars.length > 5);
    const url = new URL(calls[0]);
    assert.equal(url.pathname, "/api/v1/candles");
    assert.equal(url.searchParams.get("resolution"), "1d");
    assert.ok(Number(url.searchParams.get("start_timestamp")) > 1e12, "timestamps must be in ms");
});
test("a non-200 response becomes an UPSTREAM error naming the endpoint", async () => {
    const fakeFetch = async () => new Response("nope", { status: 503 });
    const { createLighterClient } = await import("./client.js");
    const client = createLighterClient("https://example.test", fakeFetch);
    await assert.rejects(() => client.fetchMarkets(), (e) => e.code === "UPSTREAM" && /503/.test(e.message));
});
test("fetchFundingRates parses the roster-wide funding reply", async () => {
    const reply = {
        code: 200,
        funding_rates: [
            { market_id: 0, exchange: "lighter", symbol: "ETH", rate: 0.000096 },
            { market_id: 0, exchange: "binance", symbol: "ETH", rate: "0.0001" },
            { market_id: 141, exchange: "binance", symbol: "HYUNDAI", rate: null },
        ],
    };
    const fakeFetch = async (input) => {
        const url = new URL(String(input));
        assert.equal(url.pathname, "/api/v1/funding-rates");
        return new Response(JSON.stringify(reply), { status: 200 });
    };
    const { createLighterClient } = await import("./client.js");
    const client = createLighterClient("https://example.test", fakeFetch);
    const rows = await client.fetchFundingRates();
    assert.equal(rows.length, 3);
    assert.deepEqual(rows[0], { market_id: 0, exchange: "lighter", symbol: "ETH", rate: 0.000096 });
    assert.equal(rows[1].rate, 0.0001, "string numerics are coerced");
    assert.equal(rows[2].rate, null, "null rate survives as null");
});
