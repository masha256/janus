# Manual testing recipes

This repo's test suite is automatic (`npm test`), but the commands below are a
self-contained recipe for populating a scratch database with two assets, two
clusters, macro/cluster reads, screen/score rows, and resulting `INITIATE` trade
directives. They are useful for verifying the directive ladder and the CLI by
hand.

All commands assume a fresh shell with a throwaway `JANUS_DB`.

```bash
export JANUS_DB=/tmp/janus-scratch.db
export JANUS_LIGHTER_URL=https://mainnet.zklighter.elliot.ai
```

## 1. Initialize and sync the Lighter catalog

```bash
janus init
janus market sync
```

## 2. Create two clusters and add three assets

```bash
janus cluster add crypto_bluechip --name "Crypto Blue-Chip"
janus cluster add crypto_defi      --name "Crypto DeFi"

janus asset add BTC --class crypto --cluster crypto_bluechip
janus asset add ETH --class crypto --cluster crypto_bluechip
janus asset add UNI --class crypto --cluster crypto_defi
```

## 3. Loosen the trend gate and run coverage

The directive ladder treats MA structure as a hard entry condition. Real Lighter
market data may be below the SMAs on any given day, so this recipe relaxes the
gate to make `INITIATE` more likely with arbitrary snapshots.

```bash
janus param set trend_gate_long 0
janus param set require_golden_for_long 0
janus coverage run
```

`require_golden_for_long 0` removes the 50/200 golden-cross requirement, and
`trend_gate_long 0` only requires price to be at or above the 50-day SMA. This
keeps the trend gate meaningful while letting the recipe produce trade directives
reliably.

If an asset is skipped because of too little history, the recipe still works for
the assets that were covered.

## 4. Record macro and cluster reads

```bash
janus macro record --summary "breadth improving, regime neutral" --metric regime=0.5

janus cluster record crypto_bluechip --metric regime=0.5
janus cluster record crypto_defi      --metric regime=0.5
```

## 5. Screen all three assets

A `score` of 5 with `confidence=1` and the default `screen_threshold=1.0` gives
`screen_score=5`, which flags the asset.

```bash
janus screen record BTC --metric score=5 --metric confidence=1
janus screen record ETH --metric score=5 --metric confidence=1
janus screen record UNI --metric score=5 --metric confidence=1
```

## 6. Score BTC and ETH with bullish factors that pass the trend gate

The exact directive depends on the coverage data. With a bullish coverage
snapshot (price above SMA 50/200), the factors below should produce
`INITIATE` directives for both BTC and ETH.

```bash
janus score record BTC \
  --factor catalyst=2 \
  --factor trend=2 \
  --factor secular=1 \
  --factor crowding=50 \
  --factor divergence=0 \
  --factor confidence=1

janus score record ETH \
  --factor catalyst=2 \
  --factor trend=2 \
  --factor secular=1 \
  --factor crowding=50 \
  --factor divergence=0 \
  --factor confidence=1
```

Reprint a stored plan without re-entering factors:

```bash
janus score show BTC
janus score show ETH
```

## 7. Expected result

For both `BTC` and `ETH` you should see:

```json
{
  "ok": true,
  "data": {
    "symbol": "BTC",
    "directive": "INITIATE",
    "plan": {
      "directive": "INITIATE",
      "trend_gate": "pass",
      "entry_plan": { "side": "long", "max_units": 3 }
    }
  }
}
```

If the coverage snapshot is not above the SMAs, the trend gate may report
`fail` and the directive becomes `STAND_ASIDE` instead.

## 8. Open the recommended trades

```bash
janus trade open BTC --direction long --price 65000 --stop 62000 --risk 500 --notional 5000 --tag core
janus trade open ETH --direction long --price 3400 --stop 3200 --risk 500 --notional 5000 --tag core
```

Verify the open book:

```bash
janus trade list --open
janus trade show 1
```

## 9. Clean up

```bash
rm -f $JANUS_DB
```
