-- ============================================================================
-- Apple Ratings Summary (per-country snapshot)
--
-- Pulled from public iTunes Lookup API:
--   https://itunes.apple.com/lookup?id={APP_ID}&country=XX
--
-- Unlike apple_reviews (which only has WRITTEN reviews), this table captures
-- the full rating counts (star taps with or without text). These are the
-- numbers ASC shows in "Valoraciones y reseñas".
--
-- We snapshot a row per country per sync so we can see trends over time.
-- ============================================================================

CREATE TABLE IF NOT EXISTS apple_ratings_summary (
  id                SERIAL PRIMARY KEY,
  snapshot_date     DATE NOT NULL,           -- the day we pulled
  app_id            TEXT NOT NULL,
  country_code      CHAR(2) NOT NULL,        -- ISO-2 (e.g. US, MX, ES)
  rating_count      INTEGER NOT NULL,        -- total current-version ratings
  avg_rating        NUMERIC(4,3),            -- e.g. 4.569
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (snapshot_date, app_id, country_code)
);

CREATE INDEX IF NOT EXISTS idx_apple_ratings_summary_date
  ON apple_ratings_summary (snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_apple_ratings_summary_country
  ON apple_ratings_summary (country_code);
