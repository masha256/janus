
# WIKI — Daily asset second brain wiki update

Load `secondbrain/SPEC.md` (relative to `/home/ubuntu/.openclaw/workspace-raymond`) and follow its write contract precisely. This job's only job is to keep `secondbrain/wiki/assets/` current — it does NOT touch `secondbrain/wiki/mechanics/`, `themes/`, or `watchlist.md` (those are out of scope until Mike explicitly expands this job).

Do this ENTIRELY IN THIS SINGLE TURN, synchronously. Do NOT call sessions_spawn or sessions_yield — same reasoning as the Score Phase job: this is an isolated cron session that cannot resume after a yield.

`cd /home/ubuntu/.openclaw/workspace-raymond` first — everything below is relative to that directory.

Steps:

1. Read today's `reports/YYYY-MM-DD.md` (today = New York date). If it doesn't exist yet, stop and report — the Score Phase job hasn't run or hasn't finished; do not proceed on a missing report.

2. From the report's "Open trades" and "Scores" tables, get the list of every symbol that appears today (open positions + everything scored, including STAND_ASIDE).

3. For each symbol in that list, check whether `secondbrain/wiki/assets/<SYMBOL>.md` exists:
   - **If it doesn't exist**, create it with the same structure as the existing backfilled pages (header with class/cluster/status, a "Position history" or "Thesis evolution" table, footer with `Last updated` + source). Pull today's row from the report — do not invent history for dates before today; a brand-new page only has today's entry.
   - **If it exists**, add exactly one new row/entry for today to the existing table (or "Position history" list for assets with open trades), using today's `directive`, `direction`, `conviction`, and `rationale`/`directive_reason` verbatim from the report. Do NOT rewrite the rest of the page. Do NOT re-summarize or re-interpret old entries — append only.
   - If a trade closed today (check `janus trade list` for any `closed_on` matching today's date), add an "Outcome" section to that asset's page the same way `UNI.md` and `ONDO.md` are structured in the existing backfill, with realized/net P&L pulled from `janus trade show <id>`.
   - If a trade opened today, update the page's header `Status` line to reflect the new open position (trade id, side, entry price, stop) — this is the one thing that DOES get overwritten each time it changes, since it's a current-status line, not a historical log entry.

4. Read `secondbrain/raw/sources/YYYY-MM-DD/` if it exists (the citation logs from today's Score Phase run — only present if that job's prompt has been updated to write them, see `DRAFT-score-phase-prompt-with-citations.md`). If present, weave a brief "sources" note into today's new entry on the relevant asset page (e.g., "see raw/sources/YYYY-MM-DD/NVDA.md for citations") rather than duplicating the citation content into the wiki page itself.

5. Update `secondbrain/wiki/index.md`'s asset table: status column for any symbol whose position changed today (opened, closed, or directive changed in a way worth reflecting — new INITIATE/EXIT, not routine HOLD/STAND_ASIDE repeats).

6. Every page you touch gets its footer updated: `Last updated: YYYY-MM-DD, source: reports/YYYY-MM-DD.md`.

Hard rules (from SPEC.md, restated here so this job doesn't need to re-derive them):
- Never write a number that didn't come from today's report or a direct `janus` query you ran this turn. Never carry forward a number from memory of a prior day — read it fresh from the page's own prior entry if you need it, or from janus if the page doesn't have it yet.
- Targeted updates only — touch only the asset pages implicated by today's report. Do not open or rewrite unrelated pages.
- Do not touch `secondbrain/wiki/mechanics/`, `themes/`, or `watchlist.md` — out of scope for this job.
- Do not modify `reports/*.md` — those belong to the Score Phase job only.

When done: `git add secondbrain/wiki/` (only that directory — never `-A`), commit with message `secondbrain: wiki update YYYY-MM-DD`, push. If nothing changed (no new symbols, no status changes), skip the commit and say so — do not force an empty commit.

Report to Mike: which asset pages were created vs. updated today, and any trade opens/closes reflected. Keep it short — this is maintenance, not a market brief.
