import { JanusError } from "../output.ts";
import type { Bar } from "../types.ts";

export const LIGHTER_BASE_URL = "https://mainnet.zklighter.elliot.ai";

export type MarketInfo = {
  symbol: string;
  market_id: number;
  market_type: string;
  status: string;
  price_decimals: number;
  size_decimals: number;
  listed_at: string;
};

export type Snapshot = {
  mark_price: number | null;
  index_price: number | null;
  last_trade_price: number | null;
  daily_price_low: number | null;
  daily_price_high: number | null;
  daily_price_change: number | null;
  open_interest: number | null;
};

/** One venue's current funding rate for one market, as `/funding-rates` reports it. */
export type FundingRateRow = {
  market_id: number;
  exchange: string;
  symbol: string;
  rate: number | null;
};

export type LighterApi = {
  fetchMarkets(): Promise<MarketInfo[]>;
  fetchSnapshot(marketId: number): Promise<Snapshot>;
  fetchDailyBars(marketId: number, lookbackDays?: number): Promise<Bar[]>;
  /** Current funding for every market on the exchange, including external reference venues. */
  fetchFundingRates(): Promise<FundingRateRow[]>;
};

/** Lighter returns some numerics as strings; anything unparseable becomes null. */
function toNum(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function required(value: unknown, field: string): number {
  const n = toNum(value);
  if (n === null) throw new JanusError("UPSTREAM", `missing numeric field ${field}`);
  return n;
}

function arrayAt(json: unknown, key: string): unknown[] {
  const value = (json as Record<string, unknown>)?.[key];
  if (!Array.isArray(value)) throw new JanusError("UPSTREAM", `expected ${key} array in response`);
  return value;
}

export function parseMarkets(json: unknown): MarketInfo[] {
  return arrayAt(json, "order_books").map((raw) => {
    const m = raw as Record<string, unknown>;
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

export function parseSnapshot(json: unknown): Snapshot {
  const [raw] = arrayAt(json, "order_book_details");
  if (raw === undefined) throw new JanusError("UPSTREAM", "empty order_book_details array");
  const d = raw as Record<string, unknown>;
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

export function parseFundingRates(json: unknown): FundingRateRow[] {
  return arrayAt(json, "funding_rates").map((raw) => {
    const r = raw as Record<string, unknown>;
    return {
      market_id: required(r["market_id"], "market_id"),
      exchange: String(r["exchange"]),
      symbol: String(r["symbol"]),
      rate: toNum(r["rate"]),
    };
  });
}

export function parseBars(json: unknown): Bar[] {
  const raw = (json as Record<string, unknown>)?.["c"];
  if (!Array.isArray(raw)) throw new JanusError("UPSTREAM", "expected candles array `c` in response");
  return raw
    .map((item) => {
      const b = item as Record<string, unknown>;
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

export function createLighterClient(
  baseUrl: string = LIGHTER_BASE_URL,
  fetchImpl: typeof fetch = fetch,
): LighterApi {
  async function get(path: string, params: Record<string, string> = {}): Promise<unknown> {
    const url = new URL(`/api/v1/${path}`, baseUrl);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await fetchImpl(url);
    } catch (cause) {
      throw new JanusError("UPSTREAM", `${path} request failed: ${(cause as Error).message}`);
    }
    if (!res.ok) throw new JanusError("UPSTREAM", `${path} returned HTTP ${res.status}`);
    return res.json();
  }

  return {
    async fetchMarkets() {
      return parseMarkets(await get("orderBooks"));
    },
    async fetchSnapshot(marketId) {
      return parseSnapshot(await get("orderBookDetails", { market_id: String(marketId) }));
    },
    async fetchFundingRates() {
      return parseFundingRates(await get("funding-rates"));
    },
    async fetchDailyBars(marketId, lookbackDays = 400) {
      const end = Date.now();
      const start = end - lookbackDays * 86_400_000;
      return parseBars(
        await get("candles", {
          market_id: String(marketId),
          resolution: "1d",
          start_timestamp: String(start),
          end_timestamp: String(end),
          count_back: "0",
          set_timestamp_to_end: "false",
        }),
      );
    },
  };
}
