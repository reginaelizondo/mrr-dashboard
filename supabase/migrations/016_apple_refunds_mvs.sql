-- ============================================================================
-- 016_apple_refunds_mvs.sql
--
-- True fix for the refunds tab sluggishness. Migration 015 helped but
-- aggregation over 310k rows in `apple_subscription_events` is still the
-- dominant cost for cpp + dimension RPCs on anything past ~6 months.
--
-- Approach: pre-aggregate each breakdown into a daily materialized view.
-- Queries then select from tiny pre-aggregated tables (≤50k rows each
-- regardless of event volume growth) and finish in <200ms.
--
-- Expected impact (12m window):
--   apple_refunds_by_cpp_range:    ~2.2s -> <100ms
--   apple_refunds_by_dimension:    ~3.0s -> <100ms each
--   Total Promise.all:             ~3.0s -> <300ms
--
-- Freshness: MVs are refreshed at the end of the apple-events sync cron
-- (see scripts/refresh-apple-refund-mvs.sql + app/api/cron/apple-events).
-- That matches the pre-existing sync cadence, so dashboard data is no
-- less fresh than before.
--
-- Safe to re-run (CREATE OR REPLACE / CREATE MATERIALIZED VIEW IF NOT
-- EXISTS / DROP FUNCTION IF EXISTS patterns).
-- ============================================================================

-- Give this statement a longer budget — building MVs on 310k rows takes
-- a few seconds and the default SQL editor timeout can bite.
SET LOCAL statement_timeout = '5min';


-- ---------------------------------------------------------------------------
-- 1. Materialized views (one per breakdown dimension)
-- ---------------------------------------------------------------------------

-- 1a) Consecutive paid periods. Keeps `bucket_order` so we can preserve the
--     original ORDER BY MIN(consecutive_paid_periods) NULLS LAST ordering
--     after aggregating away from the raw column.
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_apple_refunds_by_cpp_daily AS
SELECT
  event_date,
  CASE
    WHEN consecutive_paid_periods IS NULL THEN 'Unknown'
    WHEN consecutive_paid_periods <= 0 THEN '0 (initial)'
    WHEN consecutive_paid_periods = 1 THEN '1 (initial paid)'
    WHEN consecutive_paid_periods = 2 THEN '2 (1st renewal)'
    WHEN consecutive_paid_periods = 3 THEN '3 (2nd renewal)'
    WHEN consecutive_paid_periods = 4 THEN '4 (3rd renewal)'
    WHEN consecutive_paid_periods <= 6 THEN '5–6 renewals'
    WHEN consecutive_paid_periods <= 12 THEN '7–12 renewals'
    ELSE '13+ renewals'
  END AS bucket,
  CASE
    WHEN consecutive_paid_periods IS NULL THEN 9999
    WHEN consecutive_paid_periods <= 0 THEN 0
    WHEN consecutive_paid_periods = 1 THEN 1
    WHEN consecutive_paid_periods = 2 THEN 2
    WHEN consecutive_paid_periods = 3 THEN 3
    WHEN consecutive_paid_periods = 4 THEN 4
    WHEN consecutive_paid_periods <= 6 THEN 5
    WHEN consecutive_paid_periods <= 12 THEN 7
    ELSE 13
  END AS bucket_order,
  SUM(CASE WHEN event_class = 'refund' THEN quantity ELSE 0 END)::BIGINT AS refunds,
  SUM(CASE WHEN event_class = 'paid'   THEN quantity ELSE 0 END)::BIGINT AS paid_events
FROM apple_subscription_events
WHERE event_class IN ('refund', 'paid')
GROUP BY event_date, bucket, bucket_order;

-- Unique composite index: required for REFRESH MATERIALIZED VIEW CONCURRENTLY
CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_cpp_pk
  ON mv_apple_refunds_by_cpp_daily(event_date, bucket);


-- 1b-e) Dimension MVs. Same shape; bucket is the dim value (sku, country,
--        duration, offer).

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_apple_refunds_by_sku_daily AS
SELECT
  event_date,
  COALESCE(NULLIF(TRIM(subscription_name), ''), '(unknown)') AS bucket,
  SUM(CASE WHEN event_class = 'refund' THEN quantity ELSE 0 END)::BIGINT AS refunds,
  SUM(CASE WHEN event_class = 'paid'   THEN quantity ELSE 0 END)::BIGINT AS paid_events
FROM apple_subscription_events
WHERE event_class IN ('refund', 'paid')
GROUP BY event_date, bucket;
CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_sku_pk
  ON mv_apple_refunds_by_sku_daily(event_date, bucket);


CREATE MATERIALIZED VIEW IF NOT EXISTS mv_apple_refunds_by_country_daily AS
SELECT
  event_date,
  COALESCE(NULLIF(TRIM(country), ''), '(unknown)') AS bucket,
  SUM(CASE WHEN event_class = 'refund' THEN quantity ELSE 0 END)::BIGINT AS refunds,
  SUM(CASE WHEN event_class = 'paid'   THEN quantity ELSE 0 END)::BIGINT AS paid_events
FROM apple_subscription_events
WHERE event_class IN ('refund', 'paid')
GROUP BY event_date, bucket;
CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_country_pk
  ON mv_apple_refunds_by_country_daily(event_date, bucket);


CREATE MATERIALIZED VIEW IF NOT EXISTS mv_apple_refunds_by_duration_daily AS
SELECT
  event_date,
  COALESCE(NULLIF(TRIM(standard_subscription_duration), ''), '(unknown)') AS bucket,
  SUM(CASE WHEN event_class = 'refund' THEN quantity ELSE 0 END)::BIGINT AS refunds,
  SUM(CASE WHEN event_class = 'paid'   THEN quantity ELSE 0 END)::BIGINT AS paid_events
FROM apple_subscription_events
WHERE event_class IN ('refund', 'paid')
GROUP BY event_date, bucket;
CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_duration_pk
  ON mv_apple_refunds_by_duration_daily(event_date, bucket);


CREATE MATERIALIZED VIEW IF NOT EXISTS mv_apple_refunds_by_offer_daily AS
SELECT
  event_date,
  COALESCE(NULLIF(TRIM(subscription_offer_type), ''), '(unknown)') AS bucket,
  SUM(CASE WHEN event_class = 'refund' THEN quantity ELSE 0 END)::BIGINT AS refunds,
  SUM(CASE WHEN event_class = 'paid'   THEN quantity ELSE 0 END)::BIGINT AS paid_events
FROM apple_subscription_events
WHERE event_class IN ('refund', 'paid')
GROUP BY event_date, bucket;
CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_offer_pk
  ON mv_apple_refunds_by_offer_daily(event_date, bucket);


-- ---------------------------------------------------------------------------
-- 2. Rewritten RPCs — query the MVs instead of the raw table
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION apple_refunds_by_cpp_range(start_date DATE, end_date DATE)
RETURNS TABLE(bucket TEXT, refunds BIGINT, paid_events BIGINT) AS $$
  SELECT
    bucket,
    SUM(refunds)::BIGINT,
    SUM(paid_events)::BIGINT
  FROM mv_apple_refunds_by_cpp_daily
  WHERE event_date BETWEEN start_date AND end_date
  GROUP BY bucket, bucket_order
  ORDER BY bucket_order;
$$ LANGUAGE SQL STABLE;


-- Dimension RPC: same TS-facing signature, switches to the correct MV.
-- plpgsql because SQL-language functions can't use IF/ELSIF for the switch.
CREATE OR REPLACE FUNCTION apple_refunds_by_dimension_range(
  dim TEXT,
  start_date DATE,
  end_date DATE,
  top_n INT DEFAULT 15
)
RETURNS TABLE(bucket TEXT, refunds BIGINT, paid_events BIGINT) AS $$
BEGIN
  IF dim = 'sku' THEN
    RETURN QUERY
      SELECT m.bucket, SUM(m.refunds)::BIGINT, SUM(m.paid_events)::BIGINT
      FROM mv_apple_refunds_by_sku_daily m
      WHERE m.event_date BETWEEN start_date AND end_date
      GROUP BY m.bucket
      ORDER BY SUM(m.refunds) DESC
      LIMIT top_n;
  ELSIF dim = 'country' THEN
    RETURN QUERY
      SELECT m.bucket, SUM(m.refunds)::BIGINT, SUM(m.paid_events)::BIGINT
      FROM mv_apple_refunds_by_country_daily m
      WHERE m.event_date BETWEEN start_date AND end_date
      GROUP BY m.bucket
      ORDER BY SUM(m.refunds) DESC
      LIMIT top_n;
  ELSIF dim = 'duration' THEN
    RETURN QUERY
      SELECT m.bucket, SUM(m.refunds)::BIGINT, SUM(m.paid_events)::BIGINT
      FROM mv_apple_refunds_by_duration_daily m
      WHERE m.event_date BETWEEN start_date AND end_date
      GROUP BY m.bucket
      ORDER BY SUM(m.refunds) DESC
      LIMIT top_n;
  ELSIF dim = 'offer' THEN
    RETURN QUERY
      SELECT m.bucket, SUM(m.refunds)::BIGINT, SUM(m.paid_events)::BIGINT
      FROM mv_apple_refunds_by_offer_daily m
      WHERE m.event_date BETWEEN start_date AND end_date
      GROUP BY m.bucket
      ORDER BY SUM(m.refunds) DESC
      LIMIT top_n;
  ELSE
    -- Unknown dim — return empty rather than error, to match old behaviour.
    RETURN;
  END IF;
END;
$$ LANGUAGE plpgsql STABLE;


-- apple_refunds_by_days_to_refund_range stays on the raw table — it's
-- already fast (<500ms even on 12m) because event_class='refund' is very
-- selective and we don't have a clean MV shape for a per-row d = event_date
-- - original_start_date derivation.


-- ---------------------------------------------------------------------------
-- 3. Refresh helper. Called from the apple-events sync cron.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION refresh_apple_refund_mvs()
RETURNS VOID AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_apple_refunds_by_cpp_daily;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_apple_refunds_by_sku_daily;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_apple_refunds_by_country_daily;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_apple_refunds_by_duration_daily;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_apple_refunds_by_offer_daily;
END;
$$ LANGUAGE plpgsql;


-- Grant SELECT on MVs and EXECUTE on the helper to the roles the dashboard
-- uses (anon + authenticated + service_role). Needed because MVs don't
-- inherit grants from the source table.
GRANT SELECT ON mv_apple_refunds_by_cpp_daily       TO anon, authenticated, service_role;
GRANT SELECT ON mv_apple_refunds_by_sku_daily       TO anon, authenticated, service_role;
GRANT SELECT ON mv_apple_refunds_by_country_daily   TO anon, authenticated, service_role;
GRANT SELECT ON mv_apple_refunds_by_duration_daily  TO anon, authenticated, service_role;
GRANT SELECT ON mv_apple_refunds_by_offer_daily     TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION refresh_apple_refund_mvs() TO service_role;

-- Update planner stats so the new RPCs pick the right plan immediately.
ANALYZE mv_apple_refunds_by_cpp_daily;
ANALYZE mv_apple_refunds_by_sku_daily;
ANALYZE mv_apple_refunds_by_country_daily;
ANALYZE mv_apple_refunds_by_duration_daily;
ANALYZE mv_apple_refunds_by_offer_daily;
