-- ============================================================================
-- 029 · Ajusta el IVA-consumidor de Google MX por la migración de cuenta
-- ============================================================================
-- HALLAZGO (2026-08-20): Kinedu migró de cuenta de Google Play ~feb-2026.
--   · Cuenta vieja (settlement MXN, hasta ~2025): cobraba Mexico-VAT-on-fee y
--     Kinedu remitía el IVA del consumidor mexicano → MX net = cash 0.826 − IVA
--     = 0.688.
--   · Cuenta nueva (settlement USD, 2026+): SIN Mexico-VAT-on-fee, y el merchant
--     of record ya no es la entidad mexicana → Google recauda/remite el IVA del
--     consumidor MX, Kinedu ya NO lo remite (confirmado por Pepis) → MX net =
--     cash 0.850, SIN restar IVA.
--
-- Por eso la resta de IVA-consumidor MX se vuelve consciente de la fecha:
--   year_month <= '2025-12'  → resta 0.16/1.16 (cuenta MXN)
--   year_month >= '2026-01'  → no resta (cuenta USD; 2026-01 es transición y se
--                              asienta en 0.85 cuando el cron trae los datos GCS)
--
-- Resto igual que 028 (recrea MV Apple+Stripe+Google, vista, grant, refresh).
-- ============================================================================

DROP MATERIALIZED VIEW IF EXISTS mv_store_net_rate_monthly CASCADE;

CREATE MATERIALIZED VIEW mv_store_net_rate_monthly AS
-- APPLE
SELECT
  'apple'::text                              AS store,
  country_code,
  TO_CHAR(begin_date, 'YYYY-MM')             AS year_month,
  SUM(apple_sales_to_usd(customer_price     * units, customer_currency,    TO_CHAR(begin_date, 'YYYY-MM'))) AS gross_usd,
  SUM(apple_sales_to_usd(developer_proceeds * units, currency_of_proceeds, TO_CHAR(begin_date, 'YYYY-MM'))) AS net_usd,
  SUM(units)::BIGINT                          AS charge_units
FROM apple_sales_daily
WHERE units > 0 AND customer_price > 0
  AND product_type_identifier IN ('IAY','IAC','IAS','IA1','IA9')
GROUP BY country_code, TO_CHAR(begin_date, 'YYYY-MM')

UNION ALL

-- STRIPE
SELECT
  'stripe'::text                             AS store,
  country_code,
  TO_CHAR(transaction_date, 'YYYY-MM')       AS year_month,
  SUM(amount_gross) FILTER (WHERE transaction_type = 'charge')                       AS gross_usd,
  SUM(amount_net)   FILTER (WHERE transaction_type = 'charge')
    - COALESCE(SUM(tax_amount) FILTER (WHERE transaction_type = 'tax'), 0)           AS net_usd,
  (SUM(units) FILTER (WHERE transaction_type = 'charge'))::BIGINT                     AS charge_units
FROM transactions
WHERE source = 'stripe' AND transaction_type IN ('charge', 'tax')
GROUP BY country_code, TO_CHAR(transaction_date, 'YYYY-MM')

UNION ALL

-- GOOGLE. net = cash − IVA-consumidor(MX SOLO en el periodo de la cuenta MXN).
SELECT
  'google'::text                             AS store,
  country_code,
  year_month,
  gross_usd,
  cash_net_usd - gross_usd * (
    CASE WHEN country_code = 'MX' AND year_month <= '2025-12' THEN 0.16/1.16 ELSE 0 END
  )                                          AS net_usd,
  charge_units
FROM google_net_rate_monthly;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_store_net_rate_pk
  ON mv_store_net_rate_monthly (store, country_code, year_month);

CREATE OR REPLACE VIEW v_store_net_rate_monthly AS
SELECT store, country_code, year_month,
  ROUND(net_usd / NULLIF(gross_usd, 0), 6) AS neto_sobre_precio,
  charge_units
FROM mv_store_net_rate_monthly
WHERE gross_usd > 0;

GRANT SELECT ON v_store_net_rate_monthly TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION refresh_store_net_rate_mvs()
RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_store_net_rate_monthly;
END;
$$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION refresh_store_net_rate_mvs() TO service_role;

-- ============================================================================
-- VALIDAR tras aplicar:
--   SELECT store, country_code, year_month, neto_sobre_precio
--   FROM v_store_net_rate_monthly WHERE store='google' AND country_code='MX'
--   ORDER BY year_month DESC LIMIT 6;
--   Esperado: 2025 → 0.688 ; 2026 → 0.850 (una vez que el cron traiga GCS).
-- ============================================================================
