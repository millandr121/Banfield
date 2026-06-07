-- Banfield, The Game — D1 schema
-- Apply with:
--   npx wrangler d1 execute banfieldthegame --remote --file=server/schema.sql
-- (use --local instead of --remote to seed the local dev database)

-- One row per player account. `name` is the login identity for now; `secret`
-- + `email` back the proper login / recovery flow we add next.
CREATE TABLE IF NOT EXISTS players (
  name           TEXT PRIMARY KEY,
  secret         TEXT,           -- per-device claim token (account lock); null = unclaimed
  email          TEXT,           -- for password/recovery later
  region         TEXT,
  x              REAL,
  y              REAL,
  money          INTEGER NOT NULL DEFAULT 0,
  banfielder_pts INTEGER NOT NULL DEFAULT 0,
  hp             REAL,
  max_hp         REAL,
  hunger         REAL,
  skills         TEXT,           -- JSON: { skillName: rawXp, ... }
  inventory      TEXT,           -- JSON: { itemId: qty, ... }
  appearance     TEXT,           -- JSON: { skin, hair, shirt }
  discoveries    TEXT,           -- JSON logbook (species/plants found) — future
  created_at     INTEGER,
  updated_at     INTEGER
);

-- Leaderboards (unofficial mayor, BMSC president by species logged, etc.)
CREATE INDEX IF NOT EXISTS idx_players_pts  ON players (banfielder_pts DESC);
CREATE INDEX IF NOT EXISTS idx_players_seen ON players (updated_at DESC);
