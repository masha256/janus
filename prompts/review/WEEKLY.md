# WEEKLY — janus system and Raymond retrospective

Run this with Claude Code from the janus repo root, with Mike in the loop. The
output is one file, `reviews/YYYY-MM-DD.md` (today's date), following the
template at the bottom. The review evolves: when a new thing turns out to be
worth checking, add it to the checklist here and, if it needs numbers, to
`prompts/review/queries.sql`, so next week measures it the same way.

Three parties are under review, and every finding names which one it is about:

- **system** — janus formulas, gates, parameters, prompts.
- **agent** — Raymond, the harness running the daily pipeline and writing the
  reports. Its inputs (factors, regimes, rationales) are half the system.
- **operator** — execution of directives, stops on the venue, vetoes.

## Inputs

| What | Where |
| --- | --- |
| Live DB copy | `../retrobot-raymond/janus/janus.db` |
| Daily reports | `../retrobot-raymond/reports/YYYY-MM-DD.md` |
| Standard queries | `prompts/review/queries.sql` |
| What changed and why | `CHANGELOG.md`, `IDEAS.md` |
| Previous review | newest file in `reviews/` |

## Procedure

1. **Two windows.** The **week** runs from the day after the previous
   review's date (or 7 days ago if there is no previous review) to today; it
   tells you what is new. The **full history** runs from the first live
   session (2026-08-05) to today; it is the only basis for a change judgement.
   State both at the top of the review.
2. **Freshness.** `max(session_date)` in the DB copy must be today or
   yesterday, and every session in the window must have all five phase stamps.
   If not, say so first and review what is there.
3. **Numbers.** Run the standard queries twice, once per window, and keep
   both raw outputs as the review's appendix, so weeks compare like for like:
   ```
   sqlite3 -header -column ../retrobot-raymond/janus/janus.db \
     ".parameter set :since \"'YYYY-MM-DD'\"" ".read prompts/review/queries.sql"   # week
   sqlite3 -header -column ../retrobot-raymond/janus/janus.db \
     ".parameter set :since \"'2026-08-05'\"" ".read prompts/review/queries.sql"   # full history
   ```
   Every number in the body cites its query and window, e.g. `(Q4, full)`.
   Ad-hoc queries are fine for digging; if one earns a place, add it to
   `queries.sql`.
4. **Reports.** Skim every report in the window. Read fully any day with an
   action (INITIATE/ADD/TRIM/EXIT), any day with a regime move of 0.5 or more,
   and one ordinary day picked at random for the correctness spot check.
5. **Checklist.** Work through every section below. "Nothing to report" is a
   valid finding and is written down as one.
6. **Write** `reviews/YYYY-MM-DD.md` from the template. Action items are
   tagged system / agent / operator and are specific enough to check next week.
7. **Follow-through.** With Mike, decide which action items ship. A parameter
   or formula change goes through `CHANGELOG.md` with its evidence and its
   expected effect; a deferred one goes to `IDEAS.md` with a "do it when".
   The review itself changes no parameters.

## Checklist

### A. Missed opportunities — are INITIATE requirements too tight?

Queries 3, 4, 5, 17.

- Which gate is doing the killing this week? Compare the `directive_reason`
  mix to last week's.
- The near-miss ledger (Q4): flat assets at |direction| ≥ 0.8 that did not
  enter. For each, which gate failed and what would have had to be true.
  Were any of them the same asset on consecutive days (persistence resetting
  because the asset dropped out of the queue)?
- Forward returns: do the near-misses (Q4) beat the actual INITIATEs (Q5) at
  5 and 10 sessions? Keep a running tally across reviews; the 08-29 replay
  said 0.8 would roughly triple entries at a lower hit rate, so a loosening
  needs at least ~20 near-misses with forward returns before it is argued
  from data rather than mechanism. Q17 keeps the tally by class.
- Are `signal_direction_initiate` 0.9 and `signal_persist_days` 2 still the
  right selectivity levers, or is a different gate the bottleneck now?

### B. Position longevity — are positions living too long?

Queries 6, 7, 8. History is thin; build the ledger, do not tune on it yet.

- Open positions: days in trade, R now, and the directive run since entry.
  How many HOLD days at conviction below `conv_hold` (4)? Is the decay gate
  the thing that ends trades, and is it firing at the right time?
- Closed trades: days held, R, and what ended it (decay, time stop, stop hit
  on venue, discretionary). Compare days held to `max_time_stop_days` (42).
- Operator latency: sessions between the first EXIT/TRIM directive and the
  actual exit (Q6 `units_closed`). ZEC printed EXIT three days running before
  closing.
- Winners: did the ladder do its job (breakeven, partial, trail), or did the
  position give back open profit while directives stayed HOLD?

### C. Directive → execution fidelity

Queries 5, 6, 16, plus Mike.

- Every INITIATE/ADD/TRIM/EXIT in the window: executed, when, and at what
  price versus the coverage mark. Unexecuted directives are policy
  violations since 2026-08-29 unless the asset was deactivated.
- Fill vs plan (Q16): entry versus the coverage mark, unit risk versus
  `sizing_risk_dollars`, and minutes from score to trade open. A fill well
  off the mark changes the dollar risk unless the size is recomputed.
- Stops: janus stores notes, the venue holds the real stops. Ask Mike whether
  the resting stops on Lighter match `trade_unit.stop` for every open unit,
  and whether any stop fired that janus does not know about.
- Any trade in the DB that janus did not recommend, or a size that differs
  from the sizing plan.

### D. Raymond's input quality

Queries 9–12, 15, and the reports.

- **Factor drift** (Q9, Q10): day-over-day crowding and trend changes with
  no price move behind them. The 08-29 review found sentiment re-reads were
  the biggest day-2 leak; is that still true after the hysteresis change?
- **Catalyst discipline** (Q11): since 08-29 Raymond should record 0 unless
  something is new today. The nonzero share should be low and falling;
  spot-check a few nonzero rows against their rationales.
- **Confidence**: is it pinned in 0.6–0.75, or does it carry information?
- **Regime whipsaw** (Q12): any macro move of more than 0.5 must cite the
  number that moved. Check the summary for each such day. Cluster reads:
  deltas within the ±0.7 band, sign flips backed by two signals.
- **Cutoff leaks**: rationales that explain a post-10:00 move with a story.
  Read the day's rationales on any session with a large price move.
- **Declared gaps** (Q15): are they real gaps, and did the same gap recur
  (e.g. an asset whose identity is unclear)?
- **Report correctness**: for the random day, check the report against the DB:
  heat table matches `janus heat`, table 3 has every actionable row, no
  number that is not in an envelope, sections present on a quiet day.
- **Pipeline reliability** (Q1): incomplete sessions, reruns, failed pushes,
  anything Raymond reported as an error in the window.

### E. Screen and roster

Queries 13, 14.

- Flag rate per session: stable, or swinging with Raymond's mood? Days with
  0 or 20+ flags get a look.
- Assets never flagged in the window, and assets flagged nearly every day.
  Dead weight gets a deactivate proposal; permanent flags mean the screen is
  not discriminating for that asset.
- Class balance: where are entries and near-misses coming from (crypto vs
  equity), and does that still match the August finding that equity longs
  lost and crypto alts won?

### F. Follow-through

- Previous review's action items: done, not done, dropped and why.
- Each `CHANGELOG.md` entry still inside its evaluation window: did it do
  what it said it would (e.g. hysteresis was expected to raise INITIATEs)?
- `IDEAS.md`: has any "do it when" condition been met?

### G. Scorecard

Queries 7, 8. Closed trades R and days, open trades R, cumulative R since
the execute-every-directive policy (2026-08-29). Report it; do not tune on
it until there are dozens of trades.

## Rules

- Evidence before opinion. Every claim cites a query, a report, or a row.
- **The week is for noticing, the full history is for deciding.** A change
  proposal cites full-history numbers. One week of data can raise a question
  or add to a running tally; it cannot by itself justify moving a parameter,
  a gate, or a prompt. If the full history is still too thin, the finding
  goes on the watch list, not the action list.
- n is tiny. Prefer mechanism arguments; say "not enough data" when it is.
- Separate the three parties. A bad factor is an agent finding, a bad gate is
  a system finding, a late exit is an operator finding.
- No parameter changes during the review. Proposals go to CHANGELOG/IDEAS
  with Mike's agreement.
- Keep the body short; the appendix carries the raw numbers.

## Review template

```markdown
# Review — YYYY-MM-DD

Week: YYYY-MM-DD → YYYY-MM-DD (N sessions). Full history: 2026-08-05 → YYYY-MM-DD (N sessions). DB copy through YYYY-MM-DD.

## Summary
Three to five lines: the one or two things that matter this week.

## A. Missed opportunities
## B. Position longevity
## C. Execution fidelity
## D. Raymond's input quality
## E. Screen and roster
## F. Follow-through
## G. Scorecard

## Watch list
Findings with a real mechanism but not enough history yet; carried forward
each week with the count so far, e.g. "near-misses with fwd10: 9 of ~20".

## Action items
- [ ] (system|agent|operator) what, and how next week's review will know it happened

## Appendix — query output
### Week
<raw output of queries.sql, :since = week start>
### Full history
<raw output of queries.sql, :since = 2026-08-05>
```
