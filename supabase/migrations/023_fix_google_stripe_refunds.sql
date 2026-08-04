-- ============================================================================
-- 023 — FIX: Google/Stripe calendar refund rates were reading ~0%
-- ============================================================================
-- Found while validating 022: the `transactions` table holds almost NO refund
-- rows (google: 0, stripe: 16 lifetime) because the kinedu backend marks a
-- refunded sale by flipping payment_status 'paid'→'canceled' — it never emits
-- a refund row, and the store-API refund syncs only ever covered Apple.
-- Backend truth for 2026 alone: 761 Google + 390 Stripe refunds.
--
-- Result: the Refunds page showed a ~0% refund rate for Android and Web, and
-- understated "All stores". Apple was unaffected (it reads the Apple SALES
-- report via v_apple_sales_monthly, not `transactions`).
--
-- Fix: source Google/Stripe refunds from `kinedu_refunds` (exact per-charge
-- backend linkage, same table powering the cohort views).
--   refunds = refunds whose refund_date falls in the window (calendar basis)
--   charges = charges made in the window: live rows in `transactions`
--             + refunded charges carried on kinedu_refunds (they were dropped
--             from `transactions` when their status flipped)

CREATE OR REPLACE FUNCTION transactions_refunds_monthly_range(
  src         TEXT,
  start_month TEXT,
  end_month   TEXT
)
RETURNS TABLE (
  month         TEXT,
  charge_units  BIGINT,
  refund_units  BIGINT,
  charge_gross  NUMERIC,
  refund_gross  NUMERIC
)
LANGUAGE SQL STABLE AS $$
  WITH bounds AS (
    SELECT (start_month || '-01')::date AS d0,
           ((end_month || '-01')::date + INTERVAL '1 month')::date AS d1
  ),
  charges AS (
    SELECT to_char(t.transaction_date, 'YYYY-MM') AS m,
           1::BIGINT AS units, ABS(COALESCE(t.amount_gross, 0)) AS gross
    FROM transactions t
    CROSS JOIN bounds b
    LEFT JOIN kinedu_refunds kr
      ON kr.sale_id = substring(t.external_id FROM 'kinedu_sale_(\d+)')::BIGINT
    WHERE t.source = src
      AND t.transaction_type = 'charge'
      AND t.transaction_date >= b.d0 AND t.transaction_date < b.d1
      AND kr.sale_id IS NULL
    UNION ALL
    SELECT to_char(r.charge_date, 'YYYY-MM'), 1, COALESCE(r.usd_amount, 0)
    FROM kinedu_refunds r
    CROSS JOIN bounds b
    WHERE r.source = src
      AND r.charge_date IS NOT NULL
      AND r.charge_date >= b.d0 AND r.charge_date < b.d1
  ),
  refunds AS (
    SELECT to_char(r.refund_date, 'YYYY-MM') AS m,
           COUNT(*)::BIGINT AS units, COALESCE(SUM(r.usd_amount), 0) AS gross
    FROM kinedu_refunds r
    CROSS JOIN bounds b
    WHERE r.source = src
      AND r.refund_date >= b.d0 AND r.refund_date < b.d1
    GROUP BY 1
  ),
  c AS (SELECT m, SUM(units)::BIGINT AS units, SUM(gross) AS gross FROM charges GROUP BY 1)
  SELECT
    COALESCE(c.m, refunds.m) AS month,
    COALESCE(c.units, 0) AS charge_units,
    COALESCE(refunds.units, 0) AS refund_units,
    COALESCE(c.gross, 0) AS charge_gross,
    COALESCE(refunds.gross, 0) AS refund_gross
  FROM c
  FULL OUTER JOIN refunds ON refunds.m = c.m
  ORDER BY 1;
$$;

CREATE OR REPLACE FUNCTION transactions_refunds_weekly_range(
  src        TEXT,
  start_date DATE,
  end_date   DATE
)
RETURNS TABLE (
  week_start   DATE,
  week_end     DATE,
  charge_units BIGINT,
  refund_units BIGINT,
  charge_gross NUMERIC,
  refund_gross NUMERIC
)
LANGUAGE SQL STABLE AS $$
  WITH charges AS (
    SELECT date_trunc('week', t.transaction_date)::date AS w,
           1::BIGINT AS units, ABS(COALESCE(t.amount_gross, 0)) AS gross
    FROM transactions t
    LEFT JOIN kinedu_refunds kr
      ON kr.sale_id = substring(t.external_id FROM 'kinedu_sale_(\d+)')::BIGINT
    WHERE t.source = src
      AND t.transaction_type = 'charge'
      AND t.transaction_date >= start_date AND t.transaction_date <= end_date
      AND kr.sale_id IS NULL
    UNION ALL
    SELECT date_trunc('week', r.charge_date)::date, 1, COALESCE(r.usd_amount, 0)
    FROM kinedu_refunds r
    WHERE r.source = src
      AND r.charge_date IS NOT NULL
      AND r.charge_date >= start_date AND r.charge_date <= end_date
  ),
  refunds AS (
    SELECT date_trunc('week', r.refund_date)::date AS w,
           COUNT(*)::BIGINT AS units, COALESCE(SUM(r.usd_amount), 0) AS gross
    FROM kinedu_refunds r
    WHERE r.source = src
      AND r.refund_date >= start_date AND r.refund_date <= end_date
    GROUP BY 1
  ),
  c AS (SELECT w, SUM(units)::BIGINT AS units, SUM(gross) AS gross FROM charges GROUP BY 1)
  SELECT
    COALESCE(c.w, refunds.w) AS week_start,
    (COALESCE(c.w, refunds.w) + 6) AS week_end,
    COALESCE(c.units, 0) AS charge_units,
    COALESCE(refunds.units, 0) AS refund_units,
    COALESCE(c.gross, 0) AS charge_gross,
    COALESCE(refunds.gross, 0) AS refund_gross
  FROM c
  FULL OUTER JOIN refunds ON refunds.w = c.w
  ORDER BY 1;
$$;
