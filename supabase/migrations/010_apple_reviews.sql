-- ============================================================================
-- Apple Customer Reviews
-- Pulled from App Store Connect API: GET /v1/apps/{id}/customerReviews
-- One row per review. `review_id` is Apple's stable GUID.
-- Topic categorization is done client-side during sync (rule-based) and
-- stored in `topics` (array) + `primary_topic` (most severe / first match)
-- so the dashboard can filter fast without re-running NLP.
-- ============================================================================

CREATE TABLE IF NOT EXISTS apple_reviews (
  review_id           TEXT PRIMARY KEY,
  rating              SMALLINT NOT NULL,      -- 1..5
  title               TEXT,
  body                TEXT,
  reviewer_nickname   TEXT,
  territory           CHAR(3) NOT NULL,       -- ISO-3 from Apple (e.g. MEX, USA, ESP)
  created_at          TIMESTAMPTZ NOT NULL,   -- Apple createdDate
  app_id              TEXT NOT NULL,          -- ASC numeric app id
  language            TEXT,                   -- detected: es, en, pt, other
  topics              TEXT[] NOT NULL DEFAULT '{}',  -- ['pricing','free_trial','bugs',...]
  primary_topic       TEXT,                   -- dominant topic for grouping
  has_developer_reply BOOLEAN NOT NULL DEFAULT FALSE,
  synced_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_apple_reviews_created
  ON apple_reviews (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_apple_reviews_territory
  ON apple_reviews (territory);

CREATE INDEX IF NOT EXISTS idx_apple_reviews_rating
  ON apple_reviews (rating);

CREATE INDEX IF NOT EXISTS idx_apple_reviews_primary_topic
  ON apple_reviews (primary_topic);

CREATE INDEX IF NOT EXISTS idx_apple_reviews_topics_gin
  ON apple_reviews USING GIN (topics);
