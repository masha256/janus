# Ideas

Changes considered but not made. Each entry says what the idea is, what
evidence prompted it, and what would have to be true to justify doing it.
Move an entry to `CHANGELOG.md` when it ships; delete it if it is disproven.

Evidence base as of 2026-08-29: 25 live sessions, 263 score rows, 4 INITIATEs,
2 executed trades. Everything below is mechanism-motivated; none of it is
validated by returns yet.

## Scoring

### Crowding anchor computed by janus, agent adjusts within a band
**Problem.** The biggest day-2 leak after a signal pass is the agent re-reading
crowding higher after an up day (mean sentiment Δ −0.11 vs catalyst −0.02).
The prompt already says to anchor on `funding_ref`, but the read is still a
free-text number.
**Idea.** Coverage already stores `funding_ref`, `mark_price`/`index_price`,
and `open_interest`. Have `deriveScore` compute the anchor band from the
prompt's own table and clamp the agent's `crowding` to anchor ± N (param,
e.g. 10). Store both `crowding_anchor` and `crowding_clamped`.
**Do it when** day-2 sentiment drift is still the top persistence killer after
the 2026-08-29 hysteresis change has run for a few weeks.
**Risk.** Equity perps have pinned-zero funding; the anchor is only meaningful
for crypto. Needs a per-class fallback (premium + OI trend) or class-scoped
params.

### Calm-middle sentiment plateau
**Problem.** Crowding 40–65 emits a flat 0.4·sign(trend)·fear_premium. It is
the heaviest weight, and 69% of flat rows sat in that band, so the factor
contributes ~30% of its range almost always and caps direction near 0.8 for a
catalyst-less uptrend.
**Idea A.** Make the calm middle linear in P (e.g. 0.6 at 40 sloping to 0.2 at
65) so mild-neutral still leans with trend more than warm-neutral.
**Idea B.** Raise the plateau to 0.6–0.8. Replay: 0.8 → 49 INITIATEs/month at
12/21 hits — that is "buy every uptrend", probably too loose.
**Do it when** you decide the system should be less contrarian and more
trend-following. This is a philosophy change, not a bug fix.

### Direction threshold 0.9 → 0.8
Replay: 24 INITIATEs at 7/17 hits (+10.5% mean fwd-10d), dominated by crypto
alts; every added equity entry lost. It is the selectivity lever and the
Aug-9 retune chose 0.9 deliberately. Revisit only with ≥50 trades of evidence.

### Catalyst persistence override on
`catalyst_persist_override` exists, default 0. Turning it on (1.5) would have
added MU 08-17, NVDA 08-27, SOL 08-27 — all losers in the replay window,
all same-day-news entries. Consistent with the cutoff making the system late.
Scopes are cluster or global only (no per-asset params exist). Note the venue:
Lighter trades equity perps 24/7, so after-hours earnings price into the perp
at 4:06pm, not at the cash open — there is no cutoff-lag difference between
crypto and equities here, and the override has the same weak case in both.
By the time janus scores, any news is already in the price and `trend` sees
it; `catalyst` can only capture post-event drift, which is a decaying memory
with a low weight, not an instant-entry rule. **Test before enabling:** once `catalyst_effective`
has a few weeks of history, compare fwd-10d returns of rows with
`|catalyst_effective| ≥ 1.5` that passed signal but failed persistence against
rows that persisted. Enable only if the former beat the latter; otherwise
delete the param.

### Class-aware weights
Equity and crypto share `DEFAULT_PARAMS` except where a cluster overrides.
Unclustered equities (AAPL, MSFT, META…) use the crypto-flavoured contrarian
defaults with funding pinned at zero → crowding always ~50 → sentiment always
0.5. A class-level rung in `resolveParams` (asset.class → params) would let
equities lean on trend/catalyst and crypto on sentiment. Needs a migration for
a `class_param` table or a convention on cluster keys.

### Conviction formula collinearity
Conviction ≈ f(|direction|) because agreement is 1.0 in 71% of rows and
confidence barely varies. `signal_conviction_initiate` is therefore redundant.
Either drop it or make conviction carry independent information (e.g. weight
confidence more: exponent 0.2 → 0.5). Low priority; nothing is broken.

## Gates

### Persistence across queue gaps
9 of 22 persistence failures were "asset not in yesterday's queue". The screen
threshold (score × confidence ≥ 4) decides queue membership, so a strong
scorer can vanish for a day on a confidence dip and reset persistence. Options:
(a) auto-queue any asset whose last score passed the signal gate within
`signal_persist_window_days`; (b) lower the screen threshold for assets with a
recent pass. (a) is cleaner — a `score queue` change, no formula change.

### Persistence should discount weekend equity prints
Weekend sessions run and Lighter's equity perps trade 24/7 on 1d bars
(`src/lighter/client.ts` fetches `1d` candles, so MAs/ATR include after-hours
and weekend trading). But weekend equity perp liquidity is thin and the mark
sits on a stale index, so a Saturday print on MSFT repeats Friday rather than
confirming it. Consider not counting a weekend print toward equity persistence
(or excluding equities from weekend queues) — crypto is unaffected.

### Evening catalyst pass
Because the perp is tradeable the moment after-hours news lands, a second,
narrow pass (say 18:00 ET, only assets with a fresh ≥1.5 catalyst) could act
before 18 hours of drift. It breaks the once-a-day, hard-cutoff design that
keeps scores reproducible, so it would need its own anchor and its own
`session` row (e.g. `YYYY-MM-DD-pm`). Only worth it if the drift-bet framing
of `catalyst` turns out to lose money to the lag; measure first with
`catalyst_effective` history.

## Execution and measurement

### Execute-every-directive policy (adopted 2026-08-29)
Half the system's INITIATEs were vetoed for outside-portfolio reasons; the
vetoed CRV 08-16 was +29% in 5 sessions. If an asset truly can't be held,
deactivate it (`asset.active = 0`) rather than silently skipping — the
system should only score what will be acted on.

### Paper-track unexecuted directives
If vetoes ever return, record them (`trade open --paper` or a `veto` event)
so the report can show what the system would have done. Cheap insurance for
the track record.

### Forward-return replay as a janus command
The 2026-08-29 review used a throwaway Python script joining `score`,
`score_metric`, `score_result`, and `coverage`. A `janus score replay
--param k=v ...` that recomputes every stored row under alternative params and
prints INITIATE count plus fwd-5/10 returns from coverage would make every
future tuning question a one-liner. `--recompute` already does the per-row
half.

### Signal quality by class
In the replay window every added equity long lost and every added crypto-alt
long won. n is tiny, but if it persists it argues for either class-aware
weights (above) or dropping unclustered equities from the roster.

## Reports

### Show `catalyst_effective` in table 4
Now that janus carries catalyst memory, the report should print the effective
value next to the recorded one so the operator can see a decaying story
without re-reading rationales.

### Near-miss list
A short section of flat assets at direction 0.8–0.89 (the "5 not 6" pile) with
what they lack — one factor away from an entry. Makes the gate visible instead
of silent.
