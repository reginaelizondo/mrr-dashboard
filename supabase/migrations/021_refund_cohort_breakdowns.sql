-- ============================================
-- 021 — Cohort-basis breakdowns (SKU / country / plan duration)
-- ============================================
-- Adds sku + country_code to kinedu_refunds and a dimension RPC so the iOS
-- Refund Segmentation section can toggle calendar ↔ cohort basis for the
-- dimensions where cohort attribution is possible (SKU, country, duration).
-- The other 3 dimensions (consecutive paid period, days-to-refund buckets,
-- offer type) are attributes of Apple's event report only — calendar basis.

ALTER TABLE kinedu_refunds
  ADD COLUMN IF NOT EXISTS sku TEXT,
  ADD COLUMN IF NOT EXISTS country_code TEXT;

CREATE OR REPLACE FUNCTION refund_cohort_breakdown(
  dim TEXT,          -- 'sku' | 'country' | 'duration'
  src TEXT,          -- 'apple' | 'google' | 'stripe' | 'all'
  start_month TEXT,
  end_month TEXT,
  top_n INT DEFAULT 15
)
RETURNS TABLE(
  bucket TEXT,
  charge_units BIGINT,
  refunded_units BIGINT,
  charge_gross NUMERIC,
  refunded_gross NUMERIC
) AS $$
  WITH bounds AS (
    SELECT (start_month || '-01')::date AS d0,
           ((end_month || '-01')::date + INTERVAL '1 month')::date AS d1
  ),
  live AS (
    SELECT
      CASE
        WHEN dim = 'sku' THEN COALESCE(t.sku, '(unknown)')
        WHEN dim = 'country' THEN COALESCE(t.country_code, '(unknown)')
        ELSE COALESCE(t.plan_type, '(unknown)')
      END AS bucket,
      t.amount_gross AS gross
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
    SELECT
      CASE
        WHEN dim = 'sku' THEN COALESCE(r.sku, '(unknown)')
        WHEN dim = 'country' THEN COALESCE(r.country_code, '(unknown)')
        ELSE CASE  -- plan duration derived from SKU, mirroring getPlanTypeFromSku
          WHEN r.sku IS NULL THEN '(unknown)'
          WHEN position('lifetime' in lower(r.sku)) > 0 THEN 'lifetime'
          WHEN position('_12_' in r.sku) > 0 OR r.sku ~ '_12$' THEN 'yearly'
          WHEN position('_6_' in r.sku) > 0 OR r.sku ~ '_6$' THEN 'semesterly'
          WHEN position('_3_' in r.sku) > 0 OR r.sku ~ '_3$' THEN 'quarterly'
          WHEN position('_1_' in r.sku) > 0 OR r.sku ~ '_1$' THEN 'monthly'
          ELSE 'other'
        END
      END AS bucket,
      COALESCE(r.usd_amount, 0) AS gross
    FROM kinedu_refunds r
    CROSS JOIN bounds b
    WHERE r.charge_date IS NOT NULL
      AND r.charge_date >= b.d0
      AND r.charge_date < b.d1
      AND (src IS NULL OR src = 'all' OR r.source = src)
  )
  SELECT
    u.bucket,
    COUNT(*)::BIGINT AS charge_units,
    (COUNT(*) FILTER (WHERE u.refunded))::BIGINT AS refunded_units,
    COALESCE(SUM(u.gross), 0) AS charge_gross,
    COALESCE(SUM(u.gross) FILTER (WHERE u.refunded), 0) AS refunded_gross
  FROM (
    SELECT bucket, gross, FALSE AS refunded FROM live
    UNION ALL
    SELECT bucket, gross, TRUE FROM ref
  ) u
  GROUP BY u.bucket
  ORDER BY (COUNT(*) FILTER (WHERE u.refunded)) DESC
  LIMIT top_n;
$$ LANGUAGE sql STABLE;
