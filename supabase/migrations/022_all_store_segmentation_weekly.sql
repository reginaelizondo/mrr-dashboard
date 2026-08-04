-- ============================================================================
-- 022 — All-store segmentation + weekly granularity for Google/Stripe
-- ============================================================================
-- 1) transactions_refunds_weekly_range: ISO-week aggregation from transactions
--    (mirrors 014's monthly semantics: ABS on units/amount, charge+refund).
--    Enables the Refunds page weekly view for Google / Stripe / All stores
--    (Apple keeps its SALES-report weekly path for App Store Connect parity).
--
-- 2) refund_calendar_breakdown: CALENDAR-basis segmentation (SKU / country /
--    plan duration) for any store, so the segmentation section can follow the
--    store filter instead of being iOS-only. Numerator = refunds that HAPPENED
--    in the window (kinedu_refunds.refund_date, exact backend linkage);
--    denominator = charges MADE in the window (live transactions + refunded
--    charges carried on kinedu_refunds). Net-basis rate computed in the app.

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
  SELECT
    date_trunc('week', transaction_date)::date AS week_start,
    (date_trunc('week', transaction_date)::date + 6) AS week_end,
    SUM(CASE WHEN transaction_type = 'charge'
              THEN ABS(COALESCE(units, 0)) ELSE 0 END)::BIGINT AS charge_units,
    SUM(CASE WHEN transaction_type = 'refund'
              THEN ABS(COALESCE(units, 0)) ELSE 0 END)::BIGINT AS refund_units,
    SUM(CASE WHEN transaction_type = 'charge'
              THEN ABS(COALESCE(amount_gross, 0)) ELSE 0 END) AS charge_gross,
    SUM(CASE WHEN transaction_type = 'refund'
              THEN ABS(COALESCE(amount_gross, 0)) ELSE 0 END) AS refund_gross
  FROM transactions
  WHERE source = src
    AND transaction_type IN ('charge', 'refund')
    AND transaction_date >= start_date
    AND transaction_date <= end_date
  GROUP BY 1, 2
  ORDER BY 1;
$$;

CREATE OR REPLACE FUNCTION refund_calendar_breakdown(
  dim TEXT,          -- 'sku' | 'country' | 'duration'
  src TEXT,          -- 'apple' | 'google' | 'stripe' | 'all'
  start_month TEXT,
  end_month TEXT,
  top_n INT DEFAULT 15
)
RETURNS TABLE(
  bucket TEXT,
  refunds BIGINT,
  paid_events BIGINT
) AS $$
  WITH bounds AS (
    SELECT (start_month || '-01')::date AS d0,
           ((end_month || '-01')::date + INTERVAL '1 month')::date AS d1
  ),
  ref AS (
    -- refunds that HAPPENED in the window (calendar attribution)
    SELECT
      CASE
        WHEN dim = 'sku' THEN COALESCE(r.sku, '(unknown)')
        WHEN dim = 'country' THEN COALESCE(r.country_code, '(unknown)')
        ELSE CASE
          WHEN r.sku IS NULL THEN '(unknown)'
          WHEN position('lifetime' in lower(r.sku)) > 0 THEN 'lifetime'
          WHEN position('_12_' in r.sku) > 0 OR r.sku ~ '_12$' THEN 'yearly'
          WHEN position('_6_' in r.sku) > 0 OR r.sku ~ '_6$' THEN 'semesterly'
          WHEN position('_3_' in r.sku) > 0 OR r.sku ~ '_3$' THEN 'quarterly'
          WHEN position('_1_' in r.sku) > 0 OR r.sku ~ '_1$' THEN 'monthly'
          ELSE 'other'
        END
      END AS bucket,
      COUNT(*)::BIGINT AS n
    FROM kinedu_refunds r
    CROSS JOIN bounds b
    WHERE r.refund_date >= b.d0 AND r.refund_date < b.d1
      AND (src IS NULL OR src = 'all' OR r.source = src)
    GROUP BY 1
  ),
  chg AS (
    -- charges MADE in the window: live tx (not refunded) + refunded charges
    SELECT x.bucket, COUNT(*)::BIGINT AS n FROM (
      SELECT
        CASE
          WHEN dim = 'sku' THEN COALESCE(t.sku, '(unknown)')
          WHEN dim = 'country' THEN COALESCE(t.country_code, '(unknown)')
          ELSE COALESCE(t.plan_type, '(unknown)')
        END AS bucket
      FROM transactions t
      CROSS JOIN bounds b
      LEFT JOIN kinedu_refunds kr
        ON kr.sale_id = substring(t.external_id FROM 'kinedu_sale_(\d+)')::BIGINT
      WHERE t.transaction_type = 'charge'
        AND t.external_id LIKE 'kinedu_sale_%'
        AND t.transaction_date >= b.d0 AND t.transaction_date < b.d1
        AND (src IS NULL OR src = 'all' OR t.source = src)
        AND kr.sale_id IS NULL
      UNION ALL
      SELECT
        CASE
          WHEN dim = 'sku' THEN COALESCE(r.sku, '(unknown)')
          WHEN dim = 'country' THEN COALESCE(r.country_code, '(unknown)')
          ELSE CASE
            WHEN r.sku IS NULL THEN '(unknown)'
            WHEN position('lifetime' in lower(r.sku)) > 0 THEN 'lifetime'
            WHEN position('_12_' in r.sku) > 0 OR r.sku ~ '_12$' THEN 'yearly'
            WHEN position('_6_' in r.sku) > 0 OR r.sku ~ '_6$' THEN 'semesterly'
            WHEN position('_3_' in r.sku) > 0 OR r.sku ~ '_3$' THEN 'quarterly'
            WHEN position('_1_' in r.sku) > 0 OR r.sku ~ '_1$' THEN 'monthly'
            ELSE 'other'
          END
        END AS bucket
      FROM kinedu_refunds r
      CROSS JOIN bounds b
      WHERE r.charge_date IS NOT NULL
        AND r.charge_date >= b.d0 AND r.charge_date < b.d1
        AND (src IS NULL OR src = 'all' OR r.source = src)
    ) x
    GROUP BY 1
  )
  SELECT
    COALESCE(ref.bucket, chg.bucket) AS bucket,
    COALESCE(ref.n, 0) AS refunds,
    COALESCE(chg.n, 0) AS paid_events
  FROM ref
  FULL OUTER JOIN chg ON chg.bucket = ref.bucket
  ORDER BY COALESCE(ref.n, 0) DESC
  LIMIT top_n;
$$ LANGUAGE sql STABLE;
