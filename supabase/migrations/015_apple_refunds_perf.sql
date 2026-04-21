-- ============================================================================
-- 015_apple_refunds_perf.sql
--
-- Kills the statement_timeout (error code 57014) that blacked out the Apple
-- Refund Segmentation section on /dashboard/refunds for 12-month windows.
--
-- Problem:
--   The refunds RPCs filter and aggregate ~310k rows with
--     WHERE apple_event_class(event) IN ('refund', 'paid')
--   plus
--     SUM(CASE WHEN apple_event_class(event) = 'refund' THEN quantity ...)
--   which invokes the IMMUTABLE function once per row in both the filter and
--   the aggregation. With 6 RPCs firing in parallel (Promise.all from the
--   Refunds server component) two of them reliably passed the pooler's
--   statement_timeout on larger ranges.
--
-- Fix:
--   1. Pre-compute apple_event_class as a STORED generated column so the
--      expression never runs at query time — it's persisted on insert.
--   2. Add a composite index (event_date, event_class) so the WHERE filter
--      becomes a simple range + equality scan instead of a seq-scan + filter.
--   3. Rewrite the 3 refund RPCs to reference event_class directly.
--
-- Expected impact on 12-month window (from scripts/diagnose-refunds-rpc.ts):
--   apple_refunds_by_cpp_range:         ~2.0s  -> <300ms
--   apple_refunds_by_dimension_range:   ~3.0s  -> <400ms each
--   Total wall-clock for Promise.all:   ~3.0s  -> <500ms
--
-- Safe to re-run (idempotent).
-- ============================================================================

-- 1. Stored generated column. Backfills automatically on ALTER.
--    Requires apple_event_class() to be IMMUTABLE (it is — see 006_*).
ALTER TABLE apple_subscription_events
  ADD COLUMN IF NOT EXISTS event_class TEXT
  GENERATED ALWAYS AS (apple_event_class(event)) STORED;

-- 2. Composite index for the hot WHERE filter.
CREATE INDEX IF NOT EXISTS idx_ase_date_class
  ON apple_subscription_events(event_date, event_class);

-- 3. Rewritten RPCs — reference event_class instead of calling
--    apple_event_class(event) per row. Semantics unchanged.

CREATE OR REPLACE FUNCTION apple_refunds_by_cpp_range(start_date DATE, end_date DATE)
RETURNS TABLE(bucket TEXT, refunds BIGINT, paid_events BIGINT) AS $$
  SELECT
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
    SUM(CASE WHEN event_class = 'refund' THEN quantity ELSE 0 END)::BIGINT AS refunds,
    SUM(CASE WHEN event_class = 'paid'   THEN quantity ELSE 0 END)::BIGINT AS paid_events
  FROM apple_subscription_events
  WHERE event_date >= start_date
    AND event_date <= end_date
    AND event_class IN ('refund', 'paid')
  GROUP BY 1
  ORDER BY MIN(consecutive_paid_periods) NULLS LAST;
$$ LANGUAGE SQL STABLE;


CREATE OR REPLACE FUNCTION apple_refunds_by_days_to_refund_range(start_date DATE, end_date DATE)
RETURNS TABLE(bucket TEXT, refunds BIGINT) AS $$
  WITH r AS (
    SELECT
      CASE
        WHEN original_start_date IS NULL THEN NULL
        ELSE (event_date - original_start_date)
      END AS d,
      quantity
    FROM apple_subscription_events
    WHERE event_class = 'refund'
      AND event_date >= start_date
      AND event_date <= end_date
  )
  SELECT
    CASE
      WHEN d IS NULL THEN 'Unknown'
      WHEN d <= 1 THEN '0–1 days'
      WHEN d <= 7 THEN '2–7 days'
      WHEN d <= 30 THEN '8–30 days'
      WHEN d <= 90 THEN '31–90 days'
      ELSE '90+ days'
    END AS bucket,
    SUM(quantity)::BIGINT AS refunds
  FROM r
  GROUP BY 1
  ORDER BY MIN(d) NULLS LAST;
$$ LANGUAGE SQL STABLE;


CREATE OR REPLACE FUNCTION apple_refunds_by_dimension_range(
  dim TEXT,
  start_date DATE,
  end_date DATE,
  top_n INT DEFAULT 15
)
RETURNS TABLE(bucket TEXT, refunds BIGINT, paid_events BIGINT) AS $$
  SELECT
    COALESCE(NULLIF(TRIM(
      CASE dim
        WHEN 'sku'      THEN subscription_name
        WHEN 'country'  THEN country
        WHEN 'duration' THEN standard_subscription_duration
        WHEN 'offer'    THEN subscription_offer_type
        ELSE NULL
      END
    ), ''), '(unknown)') AS bucket,
    SUM(CASE WHEN event_class = 'refund' THEN quantity ELSE 0 END)::BIGINT AS refunds,
    SUM(CASE WHEN event_class = 'paid'   THEN quantity ELSE 0 END)::BIGINT AS paid_events
  FROM apple_subscription_events
  WHERE event_date >= start_date
    AND event_date <= end_date
    AND event_class IN ('refund', 'paid')
  GROUP BY 1
  ORDER BY refunds DESC
  LIMIT top_n;
$$ LANGUAGE SQL STABLE;

-- ANALYZE so the planner picks up the new column/index stats right away.
ANALYZE apple_subscription_events;
