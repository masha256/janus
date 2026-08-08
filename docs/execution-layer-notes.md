# Execution layer — exploratory notes

**Status:** not a spec, not approved, no work started. Captured 2026-08-07 from a
design conversation. Read this before designing automated/semi-automated trading.

## Where the code stands today

- `src/lighter/client.ts:26` — `LighterApi` is read-only, unauthenticated public
  REST. Three methods: markets, snapshot, daily bars. No signing anywhere in the
  repo; the only env vars are `JANUS_LIGHTER_URL` and `JANUS_DB`.
- The client is injected in exactly two places: `src/cli/coverage.ts:121` and
  `src/cli/market.ts:32`. That is the whole network surface.
- `trade` commands are pure SQLite writes of facts already true. `trade.ts:278`
  requires `--price` as an input.
- `initial_stop` / `trade_unit.stop` are notes-to-self. Nothing enforces them.
- `trade_event` (`migrate.ts:244`) already exists and is the natural audit trail.
- `trade_one_open_per_asset` (`migrate.ts:220`) assumes janus is the source of
  truth for position count. That assumption breaks when the venue is.

## Operator context that changes the design

The operator is **already placing resting stop orders on Lighter by hand.** So
the venue, not janus, holds the real stop. `janus trade set-stop`
(`src/cli/trade.ts:191`) writes a number the exchange has never heard of.

Consequence, today, not hypothetically: a resting stop that fires overnight
leaves janus showing the trade open with a stale stop, and the next session's
`score queue` includes an asset no longer held.

## Why `--execute` on the trade commands is the wrong shape

Direction-of-data problem. `trade open --price X` takes price as input;
execution *produces* price as output — after the fill, possibly across several
fills, possibly partial, possibly rejected. One command would both demand and
compute the same field.

It also welds two failure domains together. Order accepted + DB write fails =
untracked position. DB write succeeds + order rejected = phantom position. Four
commands with the flag = four places to get that wrong.

A per-venue action layer is also wrong: one venue, one implementation.

## The layer that is actually missing

Order lifecycle. Today `score` → human → `trade` (fact). Automated it becomes
`score` → `order` (intent: submitted → filled / partial / rejected / cancelled)
→ `trade` (fact). One table, one `janus order` command
(`submit` / `sync` / `cancel` / `list`), one `src/lighter/execute.ts` holding
the signing.

The trade commands do not change. The sync step calls them with the real fill
price. Semi-auto vs. auto is then just who runs `order submit` — a human, or a
timer. No flag, no mode.

## Recommended order of work

1. **`janus sync` — reconciliation, read-only, no signing.** Fetch account
   positions from Lighter, diff against `trade list --open`. Position gone but
   trade open → stop fired, prompt `trade exit --price <fill>`. Size mismatch →
   unrecorded partial. Open unit with no resting stop order → naked. Reuses the
   existing `createLighterClient` seam, `withDb`, and the envelope shape from
   `coverage run`. This fixes the problem that actually bites, and needs no keys.

2. **Stop amendment.** The order layer's first *write* is cancel-and-replace on
   the resting stop, so the DB number and the venue number cannot diverge. This
   is the one action worth putting on a timer: trailing a stop at 3am is what a
   human is bad at, and it has no fill-price ambiguity because nothing fills.

3. **Entries last.** Price-as-output, partial fills, and slippage all land here
   at once, and it is the one action the operator is awake for anyway.

## Verify before designing further

- Lighter signing: execution needs signed L2 transactions, and signing appears
  to ship as a native library inside their Python/Go SDKs. **Unconfirmed that a
  first-class TS signer exists.** If it doesn't, the seam is a shell-out to a
  Python helper — which argues even harder for one isolated module over a flag
  sprinkled across commands.
- Which account endpoints need auth. Positions by account index are believed to
  be public REST; active orders likely need a signed auth token. Confirm both —
  step 1 above depends on positions being fetchable without keys.
- Whether the operator places the resting stops through the Lighter UI or
  already scripts them outside janus. **Unanswered.** Changes whether step 2 is
  net-new or a migration.

## Explicitly deferred

Order table, signer module, entry automation. Add the order table when stop
amendment goes automatic — not before.
