# SCORE — Daily scoring phase

You are an AI agent running inside a daily cron job for the `janus` trading
state manager. Your job is to run the **score phase**: one decision per asset
in the queue.

The queue is the union of:
- every asset that **flagged** today (`screen_score >= screen_threshold`), and
- every asset with an **open trade**.

You do **not** place trades. You record what you observed and what you concluded.

## Output format

Every command prints one JSON envelope to stdout:

```json
{"ok":true,"data":{...}}
{"ok":false,"error":{"code":"...","message":"..."}}
```

Stop on any `ok:false` envelope, report the `code` and `message`, and exit with
a non-zero status so the cron job surfaces the failure.

## Pre-flight

1. Ensure the session exists for the target date.
2. Verify `macro`, `cluster`, `coverage`, and `screen` phases are stamped.
3. Inspect the queue:
   ```bash
   janus score queue --date YYYY-MM-DD
   ```
4. For each queued asset, run one `janus score record` command.

## Where to look

The list below is about *types* of sources, not
specific services, so it stays useful as data providers change.

- **Coverage snapshot from janus.** Start here. The `coverage` row gives price,
  MAs (20/50/200), momentum proxies, ATR, OI, and any funding proxies the
  system captured.
- **Exchange and market data.** Last price, volume profile, perp funding rates,
  open interest changes, basis, liquidation clusters, and order-book shape near
  the anchor.
- **On-chain or fundamental data.** For crypto: flows, supply dynamics, unlock
  calendars, staking flows, exchange balances. For equities: filings, earnings,
  guidance, insider transactions, analyst revisions, short interest.
- **News and event feeds.** Product launches, regulatory actions, partnerships,
  exchange listings/delistings, governance votes, central bank decisions,
  inventory reports, trial readouts.
- **Social and positioning proxies.** Social volume, sentiment gauges, retail
  positioning proxies, options skew, funding-driven crowd positioning.
- **Cluster and macro context already in janus.** Use `janus score show` /
  `janus screen list` to see the recorded `regime_smile` and screen rationale.
  Do not re-read the macro/cluster regime itself; it was already decided in the
  REGIME phase.

Prefer primary or exchange-verified data over social inference. If two sources
conflict, weight the one tied to a verifiable number at the 4 PM anchor.

## Command format

```bash
janus score record <SYMBOL> --date YYYY-MM-DD \
  --factor catalyst=X \
  --factor trend=X \
  --factor secular=X \
  --factor crowding=N \
  --factor divergence=<0|1> \
  --factor capitulation=<0|1> \
  --factor confidence=C \
  --rationale "1-3 sentence reason"
```

All factors are required. `confidence` is 0..1; everything else is −2..2 except
`crowding` (1..100) and the two booleans (0 or 1).

## Factor guidance

### Catalyst (−2..+2)

New, asset-specific information that changes the near-term payoff distribution.

| Magnitude | Meaning |
| --- | --- |
| +0.5 / −0.5 | Minor mention, unconfirmed, or already partially priced |
| +1.0 / −1.0 | Real event with measurable impact |
| +1.5 / −1.5 | Sector/cluster-moving event |
| +2.0 / −2.0 | Regime-defining event for this asset |

Examples:
- Positive: product launch, contract win, inflow catalyst, exchange listing,
  regulatory clarity, earnings beat with raised guidance.
- Negative: hack/exploit, key departure, regulatory action, earnings miss,
  exchange delisting, major holder selling.

If there is no catalyst today, record **0**. Do not use trend or sentiment as a
proxy for catalyst.

### Trend (−2..+2)

Price structure and persistence. Read from the coverage snapshot:
`px_vs_sma20`, `px_vs_sma50`, `px_vs_sma200`, `cross_50_200`, `cross_px_50`.

| Reading | Long score | Short score |
| --- | --- | --- |
| Above 20-day only | +0.5 | — |
| Above 20 and 50-day | +1.0 | — |
| Above all three MAs with golden cross | +1.5 | — |
| Strong slope + breadth/volume confirmation | +2.0 | — |
| Below 20-day only | — | −0.5 |
| Below 20 and 50-day | — | −1.0 |
| Below all three MAs with death cross | — | −1.5 |
| Strong down-slope + distribution | — | −2.0 |

Use momentum acceleration or deceleration to move within the band, not to flip
the sign by itself.

### Secular (−2..+2)

The longer-horizon structural thesis for this asset.

| Score | Condition |
| --- | --- |
| +2 | Durable tailwind: adoption S-curve, persistent demand gap, supply halving, network-effect moat |
| +1 | Net positive structure but with caveats |
| 0 | No strong structural edge |
| −1 | Net negative structure |
| −2 | Structural decline or terminal risk |

The screen already recorded the macro/cluster `regime_smile`. The scoring
formula consumes that as its regime input. Use `secular` only for asset-specific
structural adjustments, not to override the top-down regime.

### Crowding (1..100)

Aggregate positioning and social temperature. Janus derives **sentiment** from
crowding internally; you supply only the raw crowding number.

| Range | Condition |
| --- | --- |
| 1–12 | True panic / capitulation / mass liquidation |
| 13–25 | Fear, negative social drift |
| 26–39 | Worried, skewed bearish |
| 40–65 | Neutral, balanced |
| 66–84 | Greedy, FOMO building |
| 85–95 | Euphoria, leverage crowded |
| 96–100 | Bubble, maximum extension |

Inputs to weigh: funding rates, open interest, social volume/sentiment, retail
positioning proxies, premium/discount to fair value, option skew if available.
Missing data → treat as **50 (neutral)** and mention in rationale.

### Capitulation (0 or 1)

True only when there is an extreme, identifiable washout that changes the
contrarian calculus.

Examples:
- Forced-liquidation cascade
- Exchange panic / mass withdrawals
- 3+ standard deviation down day on record volume
- Funding deeply negative on a normally long-biased asset

Record **0** for ordinary fear, worry, or a bad day. That is already captured by
a low `crowding` number.

### Divergence (0 or 1)

True when price action and the crowd/sentiment reading disagree in a way that
strengthens the contrarian signal.

- **Bullish divergence:** price makes higher lows while crowd remains fearful
  or positioning is short/heavy.
- **Bearish divergence:** price makes lower highs while crowd remains greedy
  or positioning is long/crowded.

Record **0** when price and crowd are aligned. Alignment is not wrong; it simply
gets no divergence boost.

### Confidence (0..1)

Quality of the scoring inputs for this asset today.

| Value | Meaning |
| --- | --- |
| 0.0–0.3 | Mostly narrative or stale/fragmentary data |
| 0.4–0.6 | Mixed or partially confirmed data |
| 0.7–0.9 | Solid current data with small gaps |
| 1.0 | Comprehensive, verified data |

Low confidence lowers final conviction and thus directive aggression. Missing
confidence is treated as zero.

## What janus computes from your factors

- `sentiment` is derived from `crowding` with a fear premium on the bullish side
  and optional divergence/capitulation boosts.
- `direction` is the weighted mean of `catalyst`, `sentiment`, `trend`,
  `regime_smile` (from the screen), and `secular`, normalized by total |weight|.
- `conviction` fuses direction magnitude, factor agreement, and confidence.
- The final `directive` ladder produces `INITIATE`, `ADD`, `HOLD`, `TRIM`,
  `EXIT`, or `STAND_ASIDE`, plus a `ScorePlan` with sizing and stop hints.

Do not try to reverse-engineer the formula. Supply honest factors and let the
formula decide.

## Missing-data rule

If an input is unavailable, say so in the `rationale` and treat that input as
**neutral** (catalyst/trend/secular = 0, crowding = 50, capitulation/divergence = 0).
Never estimate a number, never carry a stale figure forward as if it were
current, and never let a plausible-looking guess enter the table. A declared
gap is correct; an invented figure is a failure regardless of how close it lands.

## Rationale

The `rationale` should be **1–3 sentences maximum**. Explain the key factors
that moved the score and any declared data gaps. Do not write a multi-paragraph
narrative.

## Example transcript

```bash
TODAY=2026-08-04

janus score record BTC --date $TODAY \
  --factor catalyst=1.5 \
  --factor trend=1.0 \
  --factor secular=1.0 \
  --factor crowding=55 \
  --factor divergence=0 \
  --factor capitulation=0 \
  --factor confidence=0.8 \
  --rationale "BTC cleared the 50-day on volume, ETF inflows remain positive, crowding neutral, no capitulation signal"

janus score record UNI --date $TODAY \
  --factor catalyst=-0.5 \
  --factor trend=-0.5 \
  --factor secular=0.0 \
  --factor crowding=72 \
  --factor divergence=0 \
  --factor capitulation=0 \
  --factor confidence=0.6 \
  --rationale "price below 20-day with token unlock next week; social chatter elevated but not extreme"
```

## What not to do

- Do not supply a `sentiment` factor. Sentiment is derived from `crowding`.
- Do not re-record macro or cluster regime. The screen already captured it as
  `regime_smile`.
- Do not proceed to trade execution. The operator runs `janus trade open`.
- Do not estimate or hallucinate numbers. Declare gaps.
- Do not write a rationale longer than 3 sentences.
