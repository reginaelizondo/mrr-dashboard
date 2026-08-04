-- ============================================
-- 019 — REFUND COHORTS v2 (self-contained refund rows)
-- ============================================
-- Root cause found while validating 018: when a charge is refunded, the kinedu
-- backend flips sales.payment_status 'paid' → 'canceled', and the dashboard
-- sync only pulls 'paid' rows. So refunded charges are DELETED from
-- `transactions` whenever their window is re-synced — the join in 018 could
-- only ever match the few refunds whose charge row froze before the status
-- flipped. (This is also the exact mechanism behind the known ~10% dashboard
-- vs store gap: the dashboard is structurally net-of-refunded-charges.)
--
-- Fix: `kinedu_refunds` now carries the ORIGINAL CHARGE info (date, USD gross,
-- source) pulled from the backend `sales` row, so the cohort view is
-- self-contained:
--   denominator = live charges in `transactions` (not refunded)
--               + refunded charges from `kinedu_refunds`
--   numerator   = refunded charges from `kinedu_refunds`

DROP TABLE IF EXISTS kinedu_refunds;
CREATE TABLE kinedu_refunds (
  sale_id     BIGINT PRIMARY KEY,   -- kinedu backend sales.id
  refund_date DATE NOT NULL,
  charge_date DATE,                 -- sales.created_at (the cohort key)
  usd_amount  NUMERIC(12,2),        -- sales.usd_amount (gross USD of the charge)
  source      TEXT,                 -- 'apple' | 'google' | 'stripe' (mapped from sales.store)
  synced_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kinedu_refunds_date ON kinedu_refunds(refund_date);
CREATE INDEX IF NOT EXISTS idx_kinedu_refunds_charge_date ON kinedu_refunds(charge_date);

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
  WITH live AS (
    -- charges still present in transactions (refunded ones get dropped by the
    -- sync when their window is re-pulled; any stragglers are excluded via the
    -- anti-join so they aren't double-counted)
    SELECT t.transaction_date AS charge_date, t.amount_gross AS gross
    FROM transactions t
    LEFT JOIN kinedu_refunds r
      ON r.sale_id = substring(t.external_id FROM 'kinedu_sale_(\d+)')::BIGINT
    WHERE t.transaction_type = 'charge'
      AND t.external_id LIKE 'kinedu_sale_%'
      AND (src IS NULL OR src = 'all' OR t.source = src)
      AND r.sale_id IS NULL
  ),
  unified AS (
    SELECT charge_date, gross, FALSE AS refunded, NULL::INT AS days_to_refund FROM live
    UNION ALL
    SELECT r.charge_date, COALESCE(r.usd_amount, 0), TRUE, (r.refund_date - r.charge_date)
    FROM kinedu_refunds r
    WHERE r.charge_date IS NOT NULL
      AND (src IS NULL OR src = 'all' OR r.source = src)
  )
  SELECT
    to_char(charge_date, 'YYYY-MM') AS cohort_month,
    COUNT(*)::BIGINT AS charge_units,
    COALESCE(SUM(gross), 0) AS charge_gross,
    (COUNT(*) FILTER (WHERE refunded))::BIGINT AS refunded_units,
    COALESCE(SUM(gross) FILTER (WHERE refunded), 0) AS refunded_gross,
    AVG(days_to_refund) FILTER (WHERE refunded) AS avg_days_to_refund
  FROM unified
  WHERE to_char(charge_date, 'YYYY-MM') >= start_month
    AND to_char(charge_date, 'YYYY-MM') <= end_month
  GROUP BY 1
  ORDER BY 1;
$$ LANGUAGE sql STABLE;
