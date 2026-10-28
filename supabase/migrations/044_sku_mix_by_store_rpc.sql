-- 044: mezcla anual vs mensual por tienda (2026-10-27, pedido de Pepis).
--
-- Devuelve, por mes de cobro (caja, NO acumulación) × tienda × familia de SKU × nueva/renovación,
-- el número de cargos y el bruto USD. Alimenta la sección "Mezcla anual vs mensual por tienda"
-- de la pestaña Breakdown SKU.
--
-- La familia se clasifica por el NOMBRE del SKU y no por plan_type: en Apple, el mes intro de
-- $3.99 de los anuales (kinedu_learn_12_ht_c, _mt_c, _ht_d, …) queda guardado con plan_type =
-- 'monthly' (reprice-intro), así que por plan_type Apple parecería ~30% mensual cuando en
-- realidad es ~2%. Regla: '_12' en el SKU = anual, '_1' = mensual; lo demás cae a plan_type.
-- Mismos filtros de calidad que los snapshots (planes 'test', cargos sueltos de Stripe, 'other').
--
-- Devuelve jsonb (un solo valor) para esquivar el tope de 1000 filas de PostgREST.

CREATE OR REPLACE FUNCTION sku_mix_by_store_monthly(p_from date, p_to date)
RETURNS jsonb
LANGUAGE sql STABLE
SET statement_timeout = '120s'
AS $fn$
WITH base AS (
  SELECT to_char(date_trunc('month', t.transaction_date), 'YYYY-MM-01') AS month,
         COALESCE(t.source, 'other') AS source,
         CASE
           WHEN lower(COALESCE(t.sku, '')) ~ '_12(_|$)' THEN 'anual'
           WHEN lower(COALESCE(t.sku, '')) ~ '_1(_|$)'  THEN 'mensual'
           WHEN t.plan_type = 'yearly'  THEN 'anual'
           WHEN t.plan_type = 'monthly' THEN 'mensual'
           ELSE 'otro'
         END AS family,
         CASE WHEN COALESCE(t.is_new_subscription, false) THEN 'new' ELSE 'ren' END AS kind,
         COALESCE(t.amount_gross, 0)::numeric AS amount_gross
  FROM transactions t
  WHERE t.transaction_type = 'charge'
    AND t.transaction_date >= p_from
    AND t.transaction_date <  p_to
    AND lower(COALESCE(t.plan_name, '')) NOT LIKE '%test%'
    AND NOT (COALESCE(t.source, '') = 'stripe'
             AND (lower(COALESCE(t.plan_name, '')) LIKE '% charge'
                  OR lower(COALESCE(t.plan_name, '')) IN ('payment for invoice', 'none')))
    AND t.plan_type IS DISTINCT FROM 'other'
),
agg AS (
  SELECT month, source, family, kind, COUNT(*) AS n, SUM(amount_gross) AS gross
  FROM base
  GROUP BY month, source, family, kind
)
SELECT COALESCE(
  jsonb_agg(jsonb_build_object('month', month, 'source', source, 'family', family, 'kind', kind,
                               'n', n, 'gross', gross)),
  '[]'::jsonb)
FROM agg
$fn$;

-- Prueba rápida:
-- SELECT r->>'source' s, r->>'family' f, SUM((r->>'n')::int) n
-- FROM jsonb_array_elements(sku_mix_by_store_monthly('2026-01-01', '2026-11-01')) r
-- WHERE r->>'kind' = 'new' GROUP BY 1, 2 ORDER BY 1, 2;
