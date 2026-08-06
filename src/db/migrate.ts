import type { DatabaseSync } from "node:sqlite";

export const MIGRATIONS: string[] = [
  `
CREATE TABLE cluster (
  id          INTEGER PRIMARY KEY,
  key         TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT,
  notes       TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE cluster_param (
  cluster_id  INTEGER NOT NULL REFERENCES cluster(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  value       REAL NOT NULL,
  PRIMARY KEY (cluster_id, key)
);

CREATE TABLE global_param (key TEXT PRIMARY KEY, value REAL NOT NULL);

CREATE TABLE market (
  market_id       INTEGER PRIMARY KEY,
  symbol          TEXT NOT NULL UNIQUE,
  market_type     TEXT NOT NULL,
  status          TEXT NOT NULL,
  price_decimals  INTEGER NOT NULL,
  size_decimals   INTEGER NOT NULL,
  listed_at       TEXT NOT NULL,
  synced_at       TEXT NOT NULL
);

CREATE TABLE asset (
  id          INTEGER PRIMARY KEY,
  market_id   INTEGER NOT NULL UNIQUE REFERENCES market(market_id),
  symbol      TEXT NOT NULL UNIQUE,
  class       TEXT NOT NULL
              CHECK (class IN ('crypto','equity','etf','commodity','fx','index')),
  cluster_id  INTEGER REFERENCES cluster(id) ON DELETE SET NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  notes       TEXT,
  added_at    TEXT NOT NULL
);

CREATE TABLE session (
  session_date  TEXT PRIMARY KEY,
  opened_at     TEXT NOT NULL,
  macro_at      TEXT,
  cluster_at    TEXT,
  coverage_at   TEXT,
  screen_at     TEXT,
  score_at      TEXT
);

CREATE TABLE macro_read (
  session_date  TEXT PRIMARY KEY REFERENCES session(session_date) ON DELETE CASCADE,
  summary       TEXT NOT NULL,
  recorded_at   TEXT NOT NULL
);

-- What the read observed.
CREATE TABLE macro_read_metric (
  session_date  TEXT NOT NULL REFERENCES macro_read(session_date) ON DELETE CASCADE,
  key           TEXT NOT NULL,
  value_num     REAL,
  value_text    TEXT,
  PRIMARY KEY (session_date, key)
);

-- What it concluded, derived from the above at record time.
CREATE TABLE macro_read_result (
  session_date  TEXT NOT NULL REFERENCES macro_read(session_date) ON DELETE CASCADE,
  key           TEXT NOT NULL,
  value_num     REAL,
  value_text    TEXT,
  PRIMARY KEY (session_date, key)
);

CREATE TABLE cluster_read (
  session_date  TEXT NOT NULL REFERENCES session(session_date) ON DELETE CASCADE,
  cluster_id    INTEGER NOT NULL REFERENCES cluster(id) ON DELETE CASCADE,
  summary       TEXT,
  recorded_at   TEXT NOT NULL,
  PRIMARY KEY (session_date, cluster_id)
);

CREATE TABLE cluster_read_metric (
  session_date  TEXT NOT NULL,
  cluster_id    INTEGER NOT NULL,
  key           TEXT NOT NULL,
  value_num     REAL,
  value_text    TEXT,
  PRIMARY KEY (session_date, cluster_id, key),
  FOREIGN KEY (session_date, cluster_id) REFERENCES cluster_read(session_date, cluster_id)
    ON DELETE CASCADE
);

CREATE TABLE cluster_read_result (
  session_date  TEXT NOT NULL,
  cluster_id    INTEGER NOT NULL,
  key           TEXT NOT NULL,
  value_num     REAL,
  value_text    TEXT,
  PRIMARY KEY (session_date, cluster_id, key),
  FOREIGN KEY (session_date, cluster_id) REFERENCES cluster_read(session_date, cluster_id)
    ON DELETE CASCADE
);

CREATE TABLE coverage (
  session_date     TEXT NOT NULL REFERENCES session(session_date) ON DELETE CASCADE,
  asset_id         INTEGER NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  open             REAL, high REAL, low REAL, close REAL NOT NULL, volume REAL,
  mark_price       REAL,
  index_price      REAL,
  open_interest    REAL,
  daily_change_pct REAL,
  sma20 REAL, sma50 REAL, sma200 REAL,
  ema12 REAL, ema26 REAL,
  atr14 REAL,
  px_vs_sma20 REAL, px_vs_sma50 REAL, px_vs_sma200 REAL,
  cross_50_200     TEXT CHECK (cross_50_200 IN ('golden','death')),
  cross_50_200_age INTEGER,
  cross_px_50      TEXT CHECK (cross_px_50 IN ('above','below')),
  cross_px_50_age  INTEGER,
  bars_available   INTEGER NOT NULL,
  fetched_at       TEXT NOT NULL,
  PRIMARY KEY (session_date, asset_id)
);

CREATE TABLE screen (
  session_date  TEXT NOT NULL REFERENCES session(session_date) ON DELETE CASCADE,
  asset_id      INTEGER NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  flagged       INTEGER NOT NULL,
  rationale     TEXT,
  binary_date   TEXT,
  binary_reason TEXT,
  recorded_at   TEXT NOT NULL,
  PRIMARY KEY (session_date, asset_id)
);

CREATE TABLE screen_result (
  session_date  TEXT NOT NULL,
  asset_id      INTEGER NOT NULL,
  key           TEXT NOT NULL,
  value_num     REAL,
  value_text    TEXT,
  PRIMARY KEY (session_date, asset_id, key),
  FOREIGN KEY (session_date, asset_id) REFERENCES screen(session_date, asset_id)
    ON DELETE CASCADE
);

CREATE TABLE screen_metric (
  session_date  TEXT NOT NULL,
  asset_id      INTEGER NOT NULL,
  key           TEXT NOT NULL,
  value_num     REAL,
  value_text    TEXT,
  PRIMARY KEY (session_date, asset_id, key),
  FOREIGN KEY (session_date, asset_id) REFERENCES screen(session_date, asset_id)
    ON DELETE CASCADE
);

-- direction and conviction are columns, not results: every score has them, and
-- they are what you sort and filter a session's decisions by.
CREATE TABLE score (
  session_date    TEXT NOT NULL REFERENCES session(session_date) ON DELETE CASCADE,
  asset_id        INTEGER NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  direction       REAL NOT NULL,
  conviction      REAL NOT NULL,
  directive       TEXT NOT NULL,
  queue_reason    TEXT NOT NULL,
  position_state  TEXT NOT NULL,
  rationale       TEXT,
  recorded_at     TEXT NOT NULL,
  PRIMARY KEY (session_date, asset_id)
);

-- The factors the agent supplied.
CREATE TABLE score_metric (
  session_date  TEXT NOT NULL,
  asset_id      INTEGER NOT NULL,
  key           TEXT NOT NULL,
  value_num     REAL,
  value_text    TEXT,
  PRIMARY KEY (session_date, asset_id, key),
  FOREIGN KEY (session_date, asset_id) REFERENCES score(session_date, asset_id)
    ON DELETE CASCADE
);

-- What the scoring formula concluded: direction, conviction, applied weights.
CREATE TABLE score_result (
  session_date  TEXT NOT NULL,
  asset_id      INTEGER NOT NULL,
  key           TEXT NOT NULL,
  value_num     REAL,
  value_text    TEXT,
  PRIMARY KEY (session_date, asset_id, key),
  FOREIGN KEY (session_date, asset_id) REFERENCES score(session_date, asset_id)
    ON DELETE CASCADE
);

CREATE TABLE trade (
  id                  INTEGER PRIMARY KEY,
  asset_id            INTEGER NOT NULL REFERENCES asset(id),
  direction           TEXT NOT NULL CHECK (direction IN ('long','short')),
  status              TEXT NOT NULL CHECK (status IN ('open','closed')),
  opened_on           TEXT NOT NULL,
  initial_price       REAL NOT NULL,
  initial_stop        REAL NOT NULL,
  initial_risk        REAL NOT NULL,
  thesis              TEXT,
  origin_session_date TEXT,
  closed_on           TEXT,
  target_price        REAL,
  add_window_open     INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL
);

CREATE UNIQUE INDEX trade_one_open_per_asset
  ON trade(asset_id) WHERE status = 'open';

CREATE TABLE trade_unit (
  id           INTEGER PRIMARY KEY,
  trade_id     INTEGER NOT NULL REFERENCES trade(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  entry_on     TEXT NOT NULL,
  entry_price  REAL NOT NULL,
  notional     REAL NOT NULL,
  risk         REAL NOT NULL,
  stop         REAL NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('open','closed')),
  exit_on      TEXT,
  exit_price   REAL,
  funding      REAL DEFAULT 0,
  tag          TEXT,
  partial_exited INTEGER NOT NULL DEFAULT 0,
  breakeven_moved_at TEXT,
  time_stop_date TEXT,
  notes        TEXT,
  UNIQUE (trade_id, seq)
);

CREATE TABLE trade_event (
  id            INTEGER PRIMARY KEY,
  trade_id      INTEGER NOT NULL REFERENCES trade(id) ON DELETE CASCADE,
  unit_seq      INTEGER,
  event_type    TEXT NOT NULL,
  event_date    TEXT NOT NULL,
  old_stop      REAL,
  new_stop      REAL,
  old_notional  REAL,
  new_notional  REAL,
  price         REAL,
  r_multiple    REAL,
  reason        TEXT,
  recorded_at   TEXT NOT NULL
);
`,
  // Four columns were added to the baseline schema and never read. partial_exited
  // is the only one the stop ladder actually uses, so the rest go. MIGRATIONS[0]
  // is left alone: a fresh database creates them and this drops them, landing in
  // the same state as a database that predates the ladder work.
  `
ALTER TABLE trade DROP COLUMN target_price;
ALTER TABLE trade DROP COLUMN add_window_open;
ALTER TABLE trade_unit DROP COLUMN breakeven_moved_at;
ALTER TABLE trade_unit DROP COLUMN time_stop_date;
`,
];

export function migrate(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  let version = row.user_version;
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[i]!);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    version = i + 1;
  }
  return version;
}
