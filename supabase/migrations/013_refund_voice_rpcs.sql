-- ============================================================================
-- Refund Voice (refunds × reviews correlation) helper RPC.
--
-- The dashboard needs per-month × country sales aggregation to correlate
-- review topics with refund rates in the same bucket. Doing this client-side
-- by paginating apple_sales_daily takes 8-15s on weekly views (~600k rows
-- for 6 months). Pushing the GROUP BY into Postgres drops it to <500ms by
-- using the begin_date index for predicate pushdown.
--
-- Mirrors the filtering used by apple_sales_monthly_range (subscription
-- product types only, free trials excluded) so the totals match the rest
-- of the Refunds dashboard exactly.
-- ============================================================================

CREATE OR REPLACE FUNCTION apple_sales_monthly_by_country_range(
  start_date DATE,
  end_date DATE,
  country_codes TEXT[] DEFAULT NULL
)
RETURNS TABLE (
  month        TEXT,    -- YYYY-MM
  country_code CHAR(2),
  charge_units BIGINT,
  refund_units BIGINT
)
LANGUAGE SQL STABLE AS $$
  SELECT
    TO_CHAR(begin_date, 'YYYY-MM') AS month,
    country_code,
    SUM(CASE WHEN units > 0 AND customer_price > 0 THEN units ELSE 0 END)::BIGINT AS charge_units,
    SUM(CASE WHEN units < 0 THEN -units ELSE 0 END)::BIGINT AS refund_units
  FROM apple_sales_daily
  WHERE begin_date BETWEEN start_date AND end_date
    AND product_type_identifier IN ('IAY','IAC','IAS','IA1','IA9')
    AND country_code IS NOT NULL
    AND (country_codes IS NULL OR country_code = ANY(country_codes))
  GROUP BY 1, 2
  ORDER BY 1, 2;
$$;
