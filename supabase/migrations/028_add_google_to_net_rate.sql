-- ============================================================================
-- 028 · Agrega GOOGLE (real, desde earnings CSV) a la vista de tasa neta
-- ============================================================================
-- Google en `transactions` estaba plano a 15% a propósito (backfill-google-net.js).
-- La tasa REAL vive en los earnings CSV de Google Play. El script
-- scripts/backfill-google-rates.js los parsea y llena `google_net_rate_monthly`
-- con el NET DE CAJA (charge − fee − tax reales, con las retenciones de Brasil
-- ya incluidas; refunds excluidos).
--
-- Validado contra datos reales (dry-run 2025-01…2026-01): reproduce EXACTO las
-- constantes de cohortes — US/CO/AR/CL 0.826, MX 0.688 (tras IVA), ES/GB 0.85 —
-- y revela Brasil real ≈0.64 variando 0.60-0.68/mes (la constante 0.50 lo
-- subestimaba).
--
-- CAPA DE IVA-CONSUMIDOR (política, no dato): el earnings da el cash de Google
-- (~0.826 US y MX por igual). En MX Google le paga a Kinedu el IVA del consumidor
-- (16%) y Kinedu lo remite al SAT, así que hay que restarlo para el net real,
-- igual que cohortes ya hace para Apple. Se resta AQUÍ, en SQL, SOLO para MX
-- (único país confirmado como responsabilidad de Kinedu — resto = flag finanzas).
-- Extender a otros países = cambiar el CASE de abajo.
-- ============================================================================

CREATE TABLE IF NOT EXISTS google_net_rate_monthly (
  country_code  CHAR(2)  NOT NULL,
  year_month    CHAR(7)  NOT NULL,      -- YYYY-MM
  gross_usd     NUMERIC(14,2) NOT NULL, -- SUM(Charge)
  cash_net_usd  NUMERIC(14,2) NOT NULL, -- SUM(Charge + Google fee + Tax), refunds excl.
  charge_units  BIGINT   NOT NULL DEFAULT 0,
  synced_at     TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (country_code, year_month)
);

DROP MATERIALIZED VIEW IF EXISTS mv_store_net_rate_monthly CASCADE;

CREATE MATERIALIZED VIEW mv_store_net_rate_monthly AS
-- APPLE (real: apple_sales_daily; precio y proceeds a USD por separado)
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

-- STRIPE (fee modelado, desde transactions ya re-sincronizado)
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

-- GOOGLE (real, desde google_net_rate_monthly). net = cash − IVA-consumidor(MX).
SELECT
  'google'::text                             AS store,
  country_code,
  year_month,
  gross_usd,
  cash_net_usd - gross_usd * (CASE country_code WHEN 'MX' THEN 0.16/1.16 ELSE 0 END) AS net_usd,
  charge_units
FROM google_net_rate_monthly;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_store_net_rate_pk
  ON mv_store_net_rate_monthly (store, country_code, year_month);

-- Vista pública (solo tasa + volumen). Lo único que lee cohortes.
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
-- ORDEN DE APLICACIÓN:
--   1) correr esta migración (crea la tabla + MV; google sale vacío aún)
--   2) node scripts/backfill-google-rates.js apply   (llena google_net_rate_monthly)
--   3) SELECT refresh_store_net_rate_mvs();           (materializa google en la MV)
-- VALIDAR:
--   SELECT store, country_code, year_month, neto_sobre_precio, charge_units
--   FROM v_store_net_rate_monthly WHERE store='google'
--     AND country_code IN ('US','MX','BR') AND year_month>='2025-06'
--   ORDER BY country_code, year_month DESC;
--   Esperado: US≈0.826, MX≈0.688, BR≈0.60-0.68 variando.
-- NOTA: Google NO se auto-actualiza (lee tabla estática). Re-correr el backfill
--   mensual, o wirearlo al cron leyendo de GCS (lib/sync/google.ts) — follow-up.
-- ============================================================================
