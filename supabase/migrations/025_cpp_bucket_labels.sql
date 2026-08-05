-- ============================================================================
-- 025 — Clearer "Consecutive Paid Periods" bucket labels
-- ============================================================================
-- The old labels were '0 (initial)' and '1 (initial paid)': both said
-- "initial", so it was impossible to tell which one had actually paid.
--
-- Apple's `consecutive_paid_periods` = number of completed PAID periods:
--   0 → still in the introductory offer / free trial, has NOT paid yet
--   1 → completed the first paid period (the conversion)
--
-- Relabelled at read time so the materialized view (and its unique index /
-- CONCURRENTLY refresh) stay untouched.
--
-- NOTE on the 0 bucket: its refund count and its "paid events" count come from
-- different populations — nearly every CPP=0 event is Start Introductory Offer
-- / Cancel / Billing Retry (classified 'other'), so the paid denominator is a
-- handful of rare reactivations while refunds of intro charges do land here.
-- The ratio is therefore meaningless and the UI suppresses it (shows n/a).

CREATE OR REPLACE FUNCTION apple_refunds_by_cpp_range(start_date DATE, end_date DATE)
RETURNS TABLE(bucket TEXT, refunds BIGINT, paid_events BIGINT) AS $$
  SELECT
    CASE bucket
      WHEN '0 (initial)'      THEN '0 (in intro/trial — not paid yet)'
      WHEN '1 (initial paid)' THEN '1 (first paid period)'
      ELSE bucket
    END AS bucket,
    SUM(refunds)::BIGINT,
    SUM(paid_events)::BIGINT
  FROM mv_apple_refunds_by_cpp_daily
  WHERE event_date BETWEEN start_date AND end_date
  GROUP BY 1, bucket_order
  ORDER BY bucket_order;
$$ LANGUAGE SQL STABLE;
