# Changelog

Dated record of what changed and, more importantly, *why* — so a future session
can see which lever was pulled, what evidence motivated it, and what it was
expected to do. Newest first. Earlier history lives in `git log`.

Companion file: `IDEAS.md` holds changes considered but not made.

## 2026-08-29 — persistence hysteresis, catalyst memory, sentiment floor

**Context.** Review of the first 25 live sessions (2026-08-05 → 08-29, 263
score rows, 236 on flat assets; live DB copied from `retrobot-raymond/janus/`).
Outcome: 4 INITIATE, 1 ADD, 4 EXIT. Two system trades executed (NVDA −1.2R,
ZEC +5.6R); two INITIATEs (CRV 08-16, CRV 08-27) were vetoed by the operator
because of outside holdings — policy going forward is to execute every
directive so the track record measures the system.

**What the data said** (replay script was `scratchpad/sim.py`, not kept):

- Conviction is nearly a pure function of |direction| (agreement = 1.0 in 71%
  of rows, confidence 0.6–0.75). Conviction 5 ⇔ direction ≈ 0.72–0.89; 6 ⇔
  ≥ 0.9. The "stuck at 5" pile is really "direction lands 0.75–0.89".
- Direction plateaus at ~0.8 for a clean uptrend with a neutral crowd because
  the heaviest-weighted factor, sentiment, is pinned at 0.4·sign(trend)·
  fear_premium (= 0.5/0.6) whenever crowding sits in 40–65 — which was 69% of
  flat rows.
- 26 flat rows passed the signal gate; 22 died at the persistence gate: 9 had
  no prior print within a day (asset not in yesterday's queue), 6 had a prior
  at 0.80–0.89, 7 had a prior at 0.60–0.79. The gate accepted a ≥0.9 print of
  any age but rejected yesterday's 0.89.
- Mean direction change the day after a signal pass, by factor: sentiment
  −0.11, trend −0.07, regime −0.03, catalyst −0.02. Catalyst decay was the
  *smallest* day-2 leak; the agent re-reading crowding higher after an up day
  was the largest.
- Raising `w_catalyst` back to 0.25 *reduced* INITIATEs (4 → 1): weights are
  normalised, so boosting one factor taxes every row that lacks it.
- A strict "|catalyst| ≥ 1.5 skips persistence" rule would have added MU 08-17
  (−9% over 10d), NVDA 08-27, SOL 08-27 — all same-day-news entries, all
  losers, consistent with the Aug-9 note that the 10:00 ET cutoff makes the
  system structurally late to news. Shipped as a param, default **off**.

**Changes.**

1. `persistenceGate` (`src/domain/gates.ts`): today must clear
   `signal_direction_initiate`; each prior print only needs
   `signal_direction_persist` (new, 0.8) and must be within
   `signal_persist_window_days` (new, 3) of the print after it. Prior
   conviction is no longer checked (redundant with direction). Optional
   `catalyst_persist_override` (new, 0 = off). Replay on Aug data: 4 → 9
   INITIATEs. `ScoreResult` gained an optional `session_date`, set by
   `recentScores`.
2. Catalyst memory (`effectiveCatalyst` in `src/domain/score.ts`): the agent
   records only what is new today; janus carries the prior row's
   `catalyst_effective` forward, shrunk by `catalyst_decay_per_day` (new, 0.5)
   per calendar day, and uses the larger magnitude — except fresh news pointing
   the other way always wins. Stored as `catalyst_effective` in `score_result`;
   the same value is what `actionableNewSignal` and the gates see. Motivation
   was determinism, not throughput: the agent had been re-guessing the decayed
   value daily (LINK's Schwab story went 0.8 → 1.0 → 0.0 → 0.0 → 1.0 over five
   sessions). Expected effect ≈ +1 INITIATE/month at current weights.
3. `sentimentFromCrowding`: the 25–40 "getting fearful" band is floored at the
   calm-middle value (0.4) when trend > 0. Before, crowding 36 in an uptrend
   scored 0.2 while 50 scored 0.4 — a contrarian curve that penalised mild fear.
4. `prompts/SCORE.md`: catalyst section rewritten — same-day only, no
   hand-decay, negative fresh news overrides. `README.md`: new params
   documented. `dist/` rebuilt (the host runs `dist/cli.js`).

**Left alone, on purpose.** `signal_conviction_initiate` (already 5, redundant
with direction), `w_catalyst` (normalisation tax), `signal_direction_initiate`
0.9 (the selectivity lever; 0.8 would have produced 24 entries at 7/17 hits).

**Caveat on the replays.** One 3-week window of a crypto-alt melt-up and an
equity chop; n is far too small to rank rules by return. The changes were
chosen on mechanism, not on fitted P&L.

## 2026-08-17 — WIKI phase

Added `prompts/WIKI.md`; cron prompts became minimal pointers to the reference
docs (see `retrobot-raymond/MEMORY.md` for the sync procedure).

## 2026-08-16 — notional cap fixes (`bbb9e39`)

Per-asset notional cap now bounds `ADD` sizing; a position at cap sizes to
zero and reads as `HOLD ... at per-asset notional cap`.

## 2026-08-12 — heat command, score recompute, decay deadband

- `janus heat` is the single source for the report's portfolio-heat section.
- `janus score record --recompute` re-runs the formula on stored factors under
  current params without re-recording them.
- `decay_direction_deadband` (0.1): a prior direction wobbling across zero no
  longer resets the decay streak.

## 2026-08-09 — contrarian retune (`a167107`)

Defaults: `w_sentiment` .25→.30, `w_catalyst` .25→.15, `w_secular` .05→.10,
conviction floors initiate 6→5 / add 7→6, `per_trade_max_risk_pct` 5→2.5,
`max_heat_pct` 15→10, `trailing_atr_multiple` 2→3. Regime triggers read the
raw regime (the smile is sign-flipped and capped at |1.2|). Time stop only
exits positions still fully at risk. Account-scope params can no longer be
overridden per cluster. Coverage began capturing `funding_rate` / `funding_ref`
for the crowding anchor.

## 2026-08-06 — stop ladder and decay gate

Stop ladder wired into `stop_plan` (breakeven, partial, trail, time stop);
`decayGate` added (conviction below floor for N run-days on the held side →
EXIT). Partial exits split a unit.
