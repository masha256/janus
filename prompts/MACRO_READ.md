---
Add a 6am daily cronjob using the ollama-cloud/kimi-k3 model to perform the Macro Regime Read in this file - do not modify the prompt. ask me if you think something in the prompt needs adjustment.
---

# Macro Regime Read

Produce **one number**: a regime score `R` on a continuous scale from **−2 to +2**, describing the state of the global macro tape for risk assets on a given day.

```
+2  maximum risk-on / easiest financial conditions / accelerating
 0  neutral — no directional pressure either way
−2  maximum risk-off / tightest financial conditions / decelerating
```

`R` is a *top-down* read. It describes the environment every asset trades inside, not any individual asset. Nothing name-specific — no single company, no single token, no single sector — belongs in it.

Report R as the `regime` metric to the macro read with Janus. Generate 3 to 4 sentences as a macro summary. Never ramble on or generate paragraphs of narrative. Do not report any other metrics to Janus.

---

## 1. Fix an anchor before you read anything

There is **one** anchor: 4PM yesterday in New York timezone. Every input you use must be dated at or before that anchor. State the anchor date explicitly in your output.

This matters more than it sounds:

- **The read must be reproducible.** If you were run three times on the same day at three different hours, all three runs must return the same `R`. The time of day you happen to run is not allowed to move the number.
- **Intraday moves after the anchor do not re-set `R`.**

---

## 2. Read these inputs

Gather a current value **with its as-of date** for each. Search for real published figures; do not work from memory of what these levels usually are.

| Domain | What to capture |
|---|---|
| **Policy** | Current policy rate and the last decision (hold/cut/hike, vote split, dissents); the market-implied path for the next 1–2 meetings; any guidance shift |
| **Inflation** | Latest headline and core prints vs expectations; direction of the last three prints |
| **Rates & curve** | Benchmark 10-year yield and its direction into the anchor; the 2s10s spread in bp and whether it is steepening or flattening, and *why* (growth fear vs policy repricing — these are opposite signals) |
| **Credit** | High-yield spread (OAS) level, and its distance in bp above its 3-month low. Credit is the tape's most honest risk gauge — weight it |
| **Liquidity / dollar** | Broad dollar index level and direction; any funding-stress or reserve-drain signals |
| **Volatility** | Equity vol index level **and its term structure** — an inverted front end is a different regime from a flat 18 print at the same level |
| **Commodities** | Crude, and any supply/geopolitical premium in it. Persistent energy strength is an inflation input, not a growth input |
| **Breadth** | Share of the index above its 200-day; whether leadership is broad or narrow; whether the tape is two-sided rotation or a one-way flush |

**Missing data rules.** If a value is unavailable, treat that input as **neutral**. Never estimate a number, never carry a stale figure forward as if it were current, and never let a plausible-looking guess enter the output. A declared gap is correct; an invented figure is a failure regardless of how close it lands.

---

## 3. Run three hard stress triggers

These are binary — each is ON or OFF, with the number that decided it:

- **(a) Labor.** 3-month average payroll growth below ~50K, **or** any negative print.
- **(b) Curve.** 2s10s re-inverts, **or** bull-steepens more than ~25bp within a month on growth fears.
- **(c) Credit.** High-yield OAS more than ~75bp above its 3-month low.

These are a floor check on your own judgment: **two or more triggers ON is not compatible with a positive `R`.** If your narrative read and the triggers disagree, the triggers win and you rewrite the narrative.

---

## 4. Calibration — what the numbers mean

Be honest about how rare the tails are. Most days are not interesting.

| `R` | Condition |
|---|---|
| **+1.7 to +2.0** | Genuine euphoria. Vol crushed and term structure steep, credit at cycle tights, breadth broad and extended, policy easing into strength, retail and leverage stretched. Rare — a handful of days a year |
| **+0.8 to +1.6** | Clear risk-on. Conditions easing, credit firm, breadth healthy, no live stress trigger |
| **+0.2 to +0.7** | Mild tailwind. Constructive but unremarkable |
| **−0.1 to +0.1** | Neutral. Mixed or offsetting signals — use this freely; it is often the correct answer |
| **−0.2 to −0.7** | Mild headwind. Two-sided tape, some deterioration, nothing broken |
| **−0.8 to −1.6** | Clear risk-off. Conditions tightening, credit widening, breadth deteriorating, or policy uncertainty overhanging |
| **−1.7 to −2.0** | Panic. Vol spiking with an inverted front end, credit gapping, correlations to one, forced-liquidation behavior. Rare |

**Resolution: one decimal.** `−0.8`, not `−0.75` and not "moderately negative."

Guard against two specific failure modes:

- **Tail inflation.** Do not print beyond ±1.7 for an ordinary bad week or a strong rally. Reserve the extremes for conditions you could name in a sentence and defend with three cited numbers. If you can't, you're at ±1.2, not ±1.9.
- **Narrative drift.** A worrying story is not a regime change. Ask what *number* moved since the last anchor. If none did, the reading holds.

---

## 5. Persistence — justify the delta, not the level

If a prior reading exists, start from it. State it. Then move it only when an anchor-dated fact moved, and name the fact and the size of its contribution.

A reading that drifts every day without a cited cause is noise wearing a decimal point. A reading that never moves through a real deterioration is stale. Both are errors; the first is more common.

When you hold a prior value, write one line saying *why nothing moved it* — that line is part of the deliverable, not filler.



