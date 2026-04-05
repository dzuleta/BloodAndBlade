CREATE TABLE IF NOT EXISTS player_account (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        VARCHAR(40) NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS player_stats (
    player_id   UUID PRIMARY KEY REFERENCES player_account(id) ON DELETE CASCADE,
    kills_total INT NOT NULL DEFAULT 0,
    deaths_total INT NOT NULL DEFAULT 0,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_player_stats_kills ON player_stats(kills_total DESC);
