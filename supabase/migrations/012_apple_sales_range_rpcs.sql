-- ============================================================================
-- Apple Sales aggregate RPCs with date range + optional country filter.
--
-- Replaces direct queries on v_apple_sales_weekly / v_apple_sales_monthly.
-- Why RPCs instead of views:
--   1) The views use TO_CHAR on indexed columns which breaks predicate
--      pushdown → every query scans the full 259k-row table. Adding a BETWEEN
--      clause directly on begin_date inside the function lets Postgres use
--      the idx_apple_sales_daily_begin_date index. Queries drop from ~1.8s
--      to ~60ms.
--   2) RPCs support an optional `country_codes` parameter so we can power
--      the country filter added to the Refunds tab.
-- ============================================================================

-- Weekly (ISO weeks, Mon→Sun)
CREATE OR REPLACE FUNCTION apple_sales_weekly_range(
  start_date DATE,
  end_date DATE,
  country_codes TEXT[] DEFAULT NULL
)
RETURNS TABLE (
  week_start       DATE,
  week_end         DATE,
  charge_units     BIGINT,
  refund_units     BIGINT,
  charge_gross_usd NUMERIC,
  refund_gross_usd NUMERIC
)
LANGUAGE SQL STABLE AS $$
  SELECT
    date_trunc('week', begin_date)::DATE AS week_start,
    (date_trunc('week', begin_date) + INTERVAL '6 days')::DATE AS week_end,
    SUM(CASE WHEN units > 0 AND customer_price > 0 THEN units ELSE 0 END)::BIGINT AS charge_units,
    SUM(CASE WHEN units < 0 THEN -units ELSE 0 END)::BIGINT AS refund_units,
    SUM(CASE WHEN units > 0 AND customer_price > 0
              THEN apple_sales_to_usd(customer_price * units, customer_currency, TO_CHAR(begin_date, 'YYYY-MM'))
              ELSE 0 END) AS charge_gross_usd,
    SUM(CASE WHEN units < 0
              THEN apple_sales_to_usd(customer_price * units, customer_currency, TO_CHAR(begin_date, 'YYYY-MM'))
              ELSE 0 END) AS refund_gross_usd
  FROM apple_sales_daily
  WHERE begin_date BETWEEN start_date AND end_date
    AND product_type_identifier IN ('IAY','IAC','IAS','IA1','IA9')
    AND (country_codes IS NULL OR country_code = ANY(country_codes))
  GROUP BY 1, 2
  ORDER BY 1;
$$;

-- Monthly (calendar months, matches ASC "Trends → Ventas")
CREATE OR REPLACE FUNCTION apple_sales_monthly_range(
  start_date DATE,
  end_date DATE,
  country_codes TEXT[] DEFAULT NULL
)
RETURNS TABLE (
  month            TEXT,   -- YYYY-MM
  charge_units     BIGINT,
  refund_units     BIGINT,
  charge_gross_usd NUMERIC,
  refund_gross_usd NUMERIC
)
LANGUAGE SQL STABLE AS $$
  SELECT
    TO_CHAR(begin_date, 'YYYY-MM') AS month,
    SUM(CASE WHEN units > 0 AND customer_price > 0 THEN units ELSE 0 END)::BIGINT AS charge_units,
    SUM(CASE WHEN units < 0 THEN -units ELSE 0 END)::BIGINT AS refund_units,
    SUM(CASE WHEN units > 0 AND customer_price > 0
              THEN apple_sales_to_usd(customer_price * units, customer_currency, TO_CHAR(begin_date, 'YYYY-MM'))
              ELSE 0 END) AS charge_gross_usd,
    SUM(CASE WHEN units < 0
              THEN apple_sales_to_usd(customer_price * units, customer_currency, TO_CHAR(begin_date, 'YYYY-MM'))
              ELSE 0 END) AS refund_gross_usd
  FROM apple_sales_daily
  WHERE begin_date BETWEEN start_date AND end_date
    AND product_type_identifier IN ('IAY','IAC','IAS','IA1','IA9')
    AND (country_codes IS NULL OR country_code = ANY(country_codes))
  GROUP BY 1
  ORDER BY 1;
$$;

-- Top countries by volume (for the country filter dropdown)
CREATE OR REPLACE FUNCTION apple_sales_top_countries(
  start_date DATE,
  end_date DATE,
  top_n INT DEFAULT 20
)
RETURNS TABLE (
  country_code CHAR(2),
  charges      BIGINT,
  gross_usd    NUMERIC
)
LANGUAGE SQL STABLE AS $$
  SELECT
    country_code,
    SUM(CASE WHEN units > 0 AND customer_price > 0 THEN units ELSE 0 END)::BIGINT AS charges,
    SUM(CASE WHEN units > 0 AND customer_price > 0
              THEN apple_sales_to_usd(customer_price * units, customer_currency, TO_CHAR(begin_date, 'YYYY-MM'))
              ELSE 0 END) AS gross_usd
  FROM apple_sales_daily
  WHERE begin_date BETWEEN start_date AND end_date
    AND product_type_identifier IN ('IAY','IAC','IAS','IA1','IA9')
    AND country_code IS NOT NULL
  GROUP BY country_code
  ORDER BY gross_usd DESC
  LIMIT top_n;
$$;
