-- ============================================================================
-- Weekly aggregate of Apple sales (ISO weeks, Mon→Sun). Mirrors
-- v_apple_sales_monthly so the dashboard can toggle between monthly/weekly
-- granularity using the same code path.
-- ============================================================================

CREATE OR REPLACE VIEW v_apple_sales_weekly AS
SELECT
  TO_CHAR(date_trunc('week', begin_date), 'YYYY-MM-DD') AS week_start,
  TO_CHAR(date_trunc('week', begin_date) + INTERVAL '6 days', 'YYYY-MM-DD') AS week_end,
  SUM(CASE WHEN units > 0 AND customer_price > 0 THEN units ELSE 0 END)::BIGINT AS charge_units,
  SUM(CASE WHEN units < 0 THEN -units ELSE 0 END)::BIGINT AS refund_units,
  SUM(CASE WHEN units > 0 AND customer_price > 0
            THEN apple_sales_to_usd(customer_price * units, customer_currency, TO_CHAR(begin_date, 'YYYY-MM'))
            ELSE 0 END) AS charge_gross_usd,
  SUM(CASE WHEN units < 0
            THEN apple_sales_to_usd(customer_price * units, customer_currency, TO_CHAR(begin_date, 'YYYY-MM'))
            ELSE 0 END) AS refund_gross_usd
FROM apple_sales_daily
WHERE product_type_identifier IN ('IAY','IAC','IAS','IA1','IA9')
GROUP BY date_trunc('week', begin_date)
ORDER BY date_trunc('week', begin_date);
