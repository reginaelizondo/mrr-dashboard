-- 041: el MRR Net resta reembolsos (2026-10-27, pedido de Pepis).
--
-- Antes, mrr_net = bruto − comisiones y los reembolsos sólo se mostraban aparte (total_refunds), que además
-- venía de filas 'refund' en `transactions` cargadas una sola vez (Apple abr-2025 → may-2026) y por eso
-- valía $0 desde jun-2026.
--
-- Ahora el snapshot toma los reembolsos de `store_daily` (lo que cada tienda reporta por día, sincronizado
-- cada hora, migración 037) y los guarda por tienda en dos bases:
--   refunds_<store>      = lo que se le devolvió al cliente (base bruta, misma que total_refunds)
--   refunds_net_<store>  = lo que la tienda nos descuenta del depósito (base neta: sin comisión)
-- y define
--   mrr_<store>_net = bruto − comisión − refunds_net_<store>
--   mrr_net         = Σ mrr_<store>_net            (= bruto − comisiones − total_refunds_net)
-- El bruto y las comisiones NO cambian.
--
-- Cobertura de store_daily: Apple desde 2025-04-07, Google desde 2026-01 (earnings), Stripe todo.
-- Después de aplicarla: POST /api/sync/recompute-snapshots por tramos de 2 meses desde 2024-01.

ALTER TABLE mrr_daily_snapshots
  ADD COLUMN IF NOT EXISTS refunds_apple      NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refunds_google     NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refunds_stripe     NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refunds_net_apple  NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refunds_net_google NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refunds_net_stripe NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_refunds_net  NUMERIC DEFAULT 0;

COMMENT ON COLUMN mrr_daily_snapshots.total_refunds     IS 'Reembolsos del mes devueltos al cliente (base bruta), suma de store_daily.refunds_paid_usd. Ver migración 041.';
COMMENT ON COLUMN mrr_daily_snapshots.total_refunds_net IS 'Reembolsos del mes descontados del depósito (base neta), suma de store_daily.refunds_net_usd; es lo que se resta en mrr_net. Ver migración 041.';

-- Reembolsos del mes por tienda, agregados en Postgres (evita paginar ~3K filas/mes desde el snapshot).
CREATE OR REPLACE FUNCTION store_refunds_by_store(p_start date, p_end date)
RETURNS TABLE (store text, refunds_paid_usd numeric, refunds_net_usd numeric, refunds_n bigint)
LANGUAGE sql STABLE AS $fn$
  SELECT store,
         COALESCE(SUM(refunds_paid_usd), 0),
         COALESCE(SUM(refunds_net_usd), 0),
         COALESCE(SUM(refunds_n), 0)
  FROM store_daily
  WHERE date >= p_start AND date < p_end
  GROUP BY store
$fn$;
