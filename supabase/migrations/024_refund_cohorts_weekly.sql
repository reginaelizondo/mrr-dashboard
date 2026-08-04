-- ============================================================================
-- 024 — Weekly refund cohorts
-- ============================================================================
-- The Refunds page granularity toggle (monthly/weekly) now also drives the
-- "Refunds by Cohort" section. Same semantics as refund_cohorts_monthly but
-- cohorts are ISO weeks of the CHARGE date.

CREATE OR REPLACE FUNCTION refund_cohorts_weekly(
  src        TEXT,
  start_date DATE,
  end_date   DATE
)
RETURNS TABLE(
  cohort_week    DATE,
  week_end       DATE,
  charge_units   BIGINT,
  charge_gross   NUMERIC,
  refunded_units BIGINT,
  refunded_gross NUMERIC,
  avg_days_to_refund NUMERIC
) AS $$
  WITH live AS (
    SELECT t.transaction_date AS charge_date, t.amount_gross AS gross
    FROM transactions t
    LEFT JOIN kinedu_refunds r
      ON r.sale_id = substring(t.external_id FROM 'kinedu_sale_(\d+)')::BIGINT
    WHERE t.transaction_type = 'charge'
      AND t.external_id LIKE 'kinedu_sale_%'
      AND t.transaction_date >= start_date
      AND t.transaction_date <= end_date
      AND (src IS NULL OR src = 'all' OR t.source = src)
      AND r.sale_id IS NULL
  ),
  ref AS (
    SELECT r.charge_date, COALESCE(r.usd_amount, 0) AS gross,
           (r.refund_date - r.charge_date) AS days_to_refund
    FROM kinedu_refunds r
    WHERE r.charge_date IS NOT NULL
      AND r.charge_date >= start_date
      AND r.charge_date <= end_date
      AND (src IS NULL OR src = 'all' OR r.source = src)
  )
  SELECT
    date_trunc('week', u.charge_date)::date AS cohort_week,
    (date_trunc('week', u.charge_date)::date + 6) AS week_end,
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
  GROUP BY 1, 2
  ORDER BY 1;
$$ LANGUAGE sql STABLE;
