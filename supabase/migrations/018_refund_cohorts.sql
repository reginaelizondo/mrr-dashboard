-- ============================================
-- 018 — REFUND COHORTS (charge-date attribution)
-- ============================================
-- The Refunds tab shows CALENDAR views (refunds that happened in a period,
-- regardless of when the charge was). This migration adds the COHORT view:
-- "of the charges made in month X, how many were eventually refunded?"
--
-- Linkage: the kinedu backend `refunds` table references `sales.id` (100%
-- match, validated in BigQuery). Dashboard charges from the backend carry
-- external_id = 'kinedu_sale_<id>', so refunds join exactly per-charge.
--
-- `kinedu_refunds` is populated by:
--   • scripts/backfill-kinedu-refunds.js  (one-off full backfill from BigQuery)
--   • the daily cron (syncKineduRefunds — incremental, last 45 days)

CREATE TABLE IF NOT EXISTS kinedu_refunds (
  sale_id     BIGINT PRIMARY KEY,   -- kinedu backend sales.id
  refund_date DATE NOT NULL,
  synced_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kinedu_refunds_date ON kinedu_refunds(refund_date);

-- Cohort aggregation: charges grouped by their CHARGE month, refund flag from
-- the exact linked refund. src: 'apple' | 'google' | 'stripe' | 'all'.
CREATE OR REPLACE FUNCTION refund_cohorts_monthly(
  src TEXT,
  start_month TEXT,
  end_month TEXT
)
RETURNS TABLE(
  cohort_month TEXT,
  charge_units BIGINT,
  charge_gross NUMERIC,
  refunded_units BIGINT,
  refunded_gross NUMERIC,
  avg_days_to_refund NUMERIC
) AS $$
  SELECT
    to_char(t.transaction_date, 'YYYY-MM') AS cohort_month,
    COUNT(*)::BIGINT AS charge_units,
    COALESCE(SUM(t.amount_gross), 0) AS charge_gross,
    COUNT(r.sale_id)::BIGINT AS refunded_units,
    COALESCE(SUM(CASE WHEN r.sale_id IS NOT NULL THEN t.amount_gross END), 0) AS refunded_gross,
    AVG(CASE WHEN r.sale_id IS NOT NULL THEN (r.refund_date - t.transaction_date) END) AS avg_days_to_refund
  FROM transactions t
  LEFT JOIN kinedu_refunds r
    ON r.sale_id = substring(t.external_id FROM 'kinedu_sale_(\d+)')::BIGINT
  WHERE t.transaction_type = 'charge'
    AND t.external_id LIKE 'kinedu_sale_%'
    AND (src IS NULL OR src = 'all' OR t.source = src)
    AND to_char(t.transaction_date, 'YYYY-MM') >= start_month
    AND to_char(t.transaction_date, 'YYYY-MM') <= end_month
  GROUP BY 1
  ORDER BY 1;
$$ LANGUAGE sql STABLE;
