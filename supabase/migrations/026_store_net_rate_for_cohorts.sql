-- ============================================================================
-- 026 · Tasa NETA por tienda/país/mes para el app de Cohortes
-- ============================================================================
-- Objetivo: que cohortes deje de usar tasas hardcodeadas (Apple ~34% all-in,
-- Google 17.4%, Stripe 3.6%) y lea la deducción REAL medida, refrescada cada
-- noche. Cohortes consume SOLO la tasa derivada vía la anon key — nunca las
-- tablas transaccionales crudas.
--
-- ── ESTADO (2026-08-20): APPLE-ONLY ───────────────────────────────────────
-- Solo Apple sale de una fuente real (apple_sales_daily). Google y Stripe se
-- EXCLUYEN por ahora: `transactions` solo tiene tasas planas para ellos (ver
-- nota al final del bloque de la MV). Cohortes usa sus constantes validadas
-- para google/stripe hasta que exista fuente real.
--
-- `neto_sobre_precio` = proceeds ÷ precio  (fracción que se retiene tras
-- comisión + tax). La "deducción" que usa cohortes = 1 - esto.
--
-- ── Decisiones de correctitud (por tienda) ─────────────────────────────────
-- APPLE (fuente: apple_sales_daily, el Sales report granular):
--   · MONEDA: developer_proceeds va en currency_of_proceeds y customer_price
--     en customer_currency, que pueden diferir. Se convierten AMBOS a USD con
--     apple_sales_to_usd() (helper de 007) ANTES de dividir.
--   · TIER 30/15: developer_proceeds ya refleja la comisión+IVA real que Apple
--     aplicó por transacción → el ratio ya trae el mix 30/15 horneado. No hace
--     falta apple_subscription_events para el blended.
--
-- GOOGLE (fuente: transactions source=google):
--   · Cada orden se guarda en VARIAS filas (ver lib/sync/google.ts): la fila
--     `charge` ya trae amount_net = gross − fee de Google; el IVA-sobre-el-fee
--     entra como fila `tax`; y el fee se DUPLICA como fila `commission` (solo
--     auditoría). Por eso net = SUM(net de charges) − SUM(tax), IGNORANDO las
--     filas `commission` (si no, se resta el fee dos veces).
--
-- STRIPE (fuente: transactions source=stripe):
--   · La fila `charge` ya trae bt.net / bt.fee REALES de la API de Stripe
--     (lib/sync/stripe.ts). Stripe Tax está OFF → sin filas tax. net = SUM(net
--     de charges).
--
-- Google/Stripe ya están normalizados a USD en el sync → sin FX por fila aquí.
--
-- ⚠️ VALIDAR antes de que cohortes confíe en Google/Stripe: correr la query de
--    validación (abajo, comentada) y comparar contra las constantes conocidas
--    (Apple MX ya cuadró a 0.3pts; Google MX≈0.688 / US≈0.826; Stripe≈0.964).
--    Si Stripe sale ≈0.971 (=2.9% plano) es que hay filas viejas pre-fix del
--    sync → re-sincronizar antes de conmutar.
--
-- REEMBOLSOS excluidos en todas: esta vista mide comisión+tax sobre un cargo;
-- los refunds son un ajuste de LTV aparte que cohortes maneja por su lado.
-- ============================================================================

DROP MATERIALIZED VIEW IF EXISTS mv_store_net_rate_monthly CASCADE;
DROP MATERIALIZED VIEW IF EXISTS mv_apple_net_rate_monthly CASCADE;  -- por si quedó de un intento previo

-- ----------------------------------------------------------------------------
-- MV INTERNA — dólares absolutos (gross/net) por tienda/país/mes. NO se expone.
-- ----------------------------------------------------------------------------
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
WHERE units > 0
  AND customer_price > 0
  AND product_type_identifier IN ('IAY','IAC','IAS','IA1','IA9')  -- solo suscripciones
GROUP BY country_code, TO_CHAR(begin_date, 'YYYY-MM');

-- ⚠️ GOOGLE y STRIPE: EXCLUIDOS a propósito (VALIDADO 2026-08-20 contra datos
-- reales). La tabla `transactions` NO trae su economía real, solo tasas PLANAS:
--   · google → 0.8500 en TODO país/mes (= solo 15% de fee; le falta el
--     IVA-sobre-fee y las retenciones CIDE/IRRF de Brasil). Cero varianza.
--   · stripe → 0.9710 en TODO (= 2.9% plano, no el 3.6% real de bt.fee).
-- Ambas darían números PEORES que las constantes que cohortes ya tiene
-- (google MX 0.688/US 0.826/BR 0.50; stripe 0.964). Por eso la vista es
-- Apple-only y cohortes cae a sus constantes para google/stripe vía COALESCE.
-- Reincorporar a esta MV (UNION ALL) cuando exista fuente REAL:
--   · Google = desglose de tax de los earnings CSV materializado en una tabla.
--   · Stripe = re-sync con lib/sync/stripe.ts (ya lee bt.fee real) — verificar
--     si el 2.9% son filas viejas pre-fix.

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_store_net_rate_pk
  ON mv_store_net_rate_monthly (store, country_code, year_month);

-- ----------------------------------------------------------------------------
-- VISTA PÚBLICA — expone SOLO la tasa + volumen (para ponderar). Oculta montos.
-- Es lo único que lee cohortes.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_store_net_rate_monthly AS
SELECT
  store,
  country_code,
  year_month,
  ROUND(net_usd / NULLIF(gross_usd, 0), 6) AS neto_sobre_precio,
  charge_units
FROM mv_store_net_rate_monthly
WHERE gross_usd > 0;

-- ----------------------------------------------------------------------------
-- GRANT — mismo patrón que la migración 016. Solo la vista pública; NI la MV
-- interna NI las tablas crudas. transactions/apple_sales_daily siguen cerradas
-- para anon.
-- ----------------------------------------------------------------------------
GRANT SELECT ON v_store_net_rate_monthly TO anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- REFRESH nocturno. Reutiliza el enfoque de refresh_apple_refund_mvs (016/017).
-- Enganchar en app/api/cron/apple-events/route.ts junto al refresh existente.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION refresh_store_net_rate_mvs()
RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_store_net_rate_monthly;
END;
$$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION refresh_store_net_rate_mvs() TO service_role;

-- ============================================================================
-- VALIDACIÓN (correr a mano tras aplicar; NO es parte de la migración) --------
-- ============================================================================
-- SELECT store, country_code, year_month, neto_sobre_precio, charge_units
-- FROM   v_store_net_rate_monthly
-- WHERE  country_code IN ('US','MX','BR')
--   AND  year_month >= '2026-01'
-- ORDER  BY store, country_code, year_month DESC;
--   Esperado (aprox, contra constantes validadas):
--     apple  MX ≈ 0.62 · US ≈ 0.70   (BR debe MOVERSE mes a mes)
--     google MX ≈ 0.688 · US ≈ 0.826 (BR ≈ 0.50 y volátil)
--     stripe US ≈ 0.964  (si sale ≈0.971 → filas viejas, re-sync)
-- ============================================================================
