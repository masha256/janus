/**
 * Portfolio heat, as a report rather than a gate.
 *
 * The numbers here must agree with `heatGate` by construction, not by
 * coincidence: both read the same `bookHeat` sum, and both treat "no capital
 * declared" as non-blocking. A report that computed heat its own way would
 * eventually claim there is headroom on a morning the gate is refusing entries.
 */
import { daysBetween } from "./session.js";
const pct = (part, whole) => whole > 0 ? (part / whole) * 100 : null;
export function deriveHeatReport(positions, params, today) {
    const capital = params["account_capital"] ?? 0;
    const maxHeatPct = params["max_heat_pct"] ?? 100;
    const perAssetPct = params["per_asset_max_notional_pct"] ?? 20;
    const declared = capital > 0;
    const bookHeat = positions.reduce((a, p) => a + p.heat, 0);
    const bookNotional = positions.reduce((a, p) => a + p.notional, 0);
    const heatLimit = declared ? capital * (maxHeatPct / 100) : null;
    const notionalCap = declared ? capital * (perAssetPct / 100) : null;
    const breaches = [];
    const withinBookLimit = heatLimit === null || bookHeat <= heatLimit;
    if (!withinBookLimit) {
        breaches.push(`book heat ${bookHeat.toFixed(0)} over the ${heatLimit.toFixed(0)} limit`);
    }
    const assets = positions.map((p) => {
        const within = notionalCap === null || p.notional <= notionalCap;
        if (!within) {
            breaches.push(`${p.symbol} notional ${p.notional.toFixed(0)} over the ${notionalCap.toFixed(0)} per-asset cap`);
        }
        return {
            ...p,
            notional_cap: notionalCap,
            notional_used_pct: notionalCap === null ? null : pct(p.notional, notionalCap),
            within_notional_cap: within,
            free_carry: p.open_units > 0 && p.heat === 0,
            days_in_trade: p.first_entry_on === null ? null : daysBetween(today, p.first_entry_on),
        };
    });
    const byCluster = new Map();
    for (const p of positions) {
        const key = p.cluster_key;
        const row = byCluster.get(key) ??
            { cluster_key: key, positions: 0, notional: 0, heat: 0, share_of_book_pct: null };
        row.positions += 1;
        row.notional += p.notional;
        row.heat += p.heat;
        byCluster.set(key, row);
    }
    const clusters = [...byCluster.values()]
        .map((c) => ({ ...c, share_of_book_pct: pct(c.heat, bookHeat) }))
        .sort((a, b) => b.heat - a.heat);
    return {
        capital,
        capital_declared: declared,
        book: {
            heat: bookHeat,
            notional: bookNotional,
            max_heat_pct: maxHeatPct,
            limit: heatLimit,
            used_pct: heatLimit === null ? null : pct(bookHeat, heatLimit),
            headroom: heatLimit === null ? null : heatLimit - bookHeat,
            within_limit: withinBookLimit,
        },
        clusters,
        assets,
        breaches,
    };
}
