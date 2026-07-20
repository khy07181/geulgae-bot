CREATE TABLE cycles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week_start TEXT NOT NULL UNIQUE,
  goal_count INTEGER NOT NULL DEFAULT 1,
  penalty_per_post INTEGER NOT NULL DEFAULT 10000,
  channel_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  settled_at TEXT
);

CREATE TABLE participants (
  cycle_id INTEGER NOT NULL REFERENCES cycles(id),
  user_id TEXT NOT NULL,
  joined_via TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (cycle_id, user_id)
);

CREATE TABLE submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle_id INTEGER NOT NULL REFERENCES cycles(id),
  user_id TEXT NOT NULL,
  url TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  fetch_status TEXT,
  fetch_title TEXT,
  UNIQUE (user_id, url)
);

CREATE TABLE penalty_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  kind TEXT NOT NULL,
  cycle_id INTEGER REFERENCES cycles(id),
  reason TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX ux_settlement_once
  ON penalty_entries (cycle_id, user_id) WHERE kind = 'settlement';
