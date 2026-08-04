-- ============================================
-- 020 — refund_cohorts_monthly perf fix
-- ============================================
-- v2 (019) filtered by to_char(...) AFTER the union, so the anti-join scanned
-- the whole transactions table with a per-row regex → statement timeout.
-- This version pushes real DATE bounds into both branches (index-friendly:
-- idx_transactions_date / idx_kinedu_refunds_charge_date), so the regex only
-- runs on the rows inside the requested window.

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
  WITH bounds AS (
    SELECT (start_month || '-01')::date AS d0,
           ((end_month || '-01')::date + INTERVAL '1 month')::date AS d1
  ),
  live AS (
    -- non-refunded charges still present in transactions
    SELECT t.transaction_date AS charge_date, t.amount_gross AS gross
    FROM transactions t
    CROSS JOIN bounds b
    LEFT JOIN kinedu_refunds r
      ON r.sale_id = substring(t.external_id FROM 'kinedu_sale_(\d+)')::BIGINT
    WHERE t.transaction_type = 'charge'
      AND t.external_id LIKE 'kinedu_sale_%'
      AND t.transaction_date >= b.d0
      AND t.transaction_date < b.d1
      AND (src IS NULL OR src = 'all' OR t.source = src)
      AND r.sale_id IS NULL
  ),
  ref AS (
    -- refunded charges (authoritative, carried on kinedu_refunds)
    SELECT r.charge_date, COALESCE(r.usd_amount, 0) AS gross,
           (r.refund_date - r.charge_date) AS days_to_refund
    FROM kinedu_refunds r
    CROSS JOIN bounds b
    WHERE r.charge_date IS NOT NULL
      AND r.charge_date >= b.d0
      AND r.charge_date < b.d1
      AND (src IS NULL OR src = 'all' OR r.source = src)
  )
  SELECT
    to_char(u.charge_date, 'YYYY-MM') AS cohort_month,
    COUNT(*)::BIGINT AS charge_units,
    COALESCE(SUM(u.gross), 0) AS charge_gross,
    (COUNT(*) FILTER (WHERE u.refunded))::BIGINT AS refunded_units,
    COALESCE(SUM(u.gross) FILTER (WHERE u.refunded), 0) AS refunded_gross,
    AVG(u.days_to_refund) FILTER (WHERE u.refunded) AS avg_days_to_refund
  FROM (
    SELECT charge_date, gross, FALSE AS refunded, NULL::INT AS days_to_refund FROM live
    UNION ALL
    SELECT charge_date, gross, TRUE, days_to_refund FROM ref
  ) u
  GROUP BY 1
  ORDER BY 1;
$$ LANGUAGE sql STABLE;
