-- 043: la pestaña "Breakdown SKU" se calcula en Postgres (2026-10-27, reportado por Pepis: "no abre").
--
-- Antes la página bajaba TODOS los cargos de 31 meses a Node (272K filas en 272 páginas de 1000, una tras
-- otra). En Vercel la conexión se caía a mitad ("TypeError: fetch failed" tras ~111K filas) y la pestaña
-- no abría. Ahora Postgres hace la acumulación y devuelve sólo el agregado (sku × plan × mes), ~5K filas.
--
-- Metodología idéntica a lib/sku-breakdown.ts (y a snapshots.ts): cada cargo aporta
-- amount_gross / meses_del_plan a cada mes que cubre (mes de venta → + ceil(meses) − 1); mismos filtros de
-- calidad (planes 'test', cargos sueltos de Stripe, plan_type = 'other'). Los nulos de plan_type se
-- conservan como 'other' con 1 mes, igual que el snapshot.
--
-- Devuelve jsonb (un solo valor) para no toparse con el límite de 1000 filas de PostgREST.

CREATE OR REPLACE FUNCTION sku_breakdown_monthly(p_start_month date, p_end_month date)
RETURNS jsonb
LANGUAGE sql STABLE
SET statement_timeout = '120s'
AS $fn$
WITH base AS (
  SELECT COALESCE(t.sku, '(sin SKU)') AS sku,
         COALESCE(t.plan_type, 'other') AS plan_type,
         (CASE t.plan_type WHEN 'monthly' THEN 1 WHEN 'yearly' THEN 12 WHEN 'semesterly' THEN 6
                           WHEN 'quarterly' THEN 3 WHEN 'weekly' THEN 0.25 WHEN 'lifetime' THEN 60
                           ELSE 1 END)::numeric AS pm,
         COALESCE(t.amount_gross, 0)::numeric AS amount_gross,
         date_trunc('month', t.transaction_date)::date AS sale_month,
         COALESCE(t.is_new_subscription, false) AS is_new
  FROM transactions t
  WHERE t.transaction_type = 'charge'
    -- 13 meses de lookback: alcanza cualquier anual que siga acumulando en el primer mes mostrado.
    AND t.transaction_date >= (p_start_month - interval '13 months')::date
    AND t.transaction_date <  (p_end_month + interval '1 month')::date
    AND lower(COALESCE(t.plan_name, '')) NOT LIKE '%test%'
    AND NOT (COALESCE(t.source, '') = 'stripe'
             AND (lower(COALESCE(t.plan_name, '')) LIKE '% charge'
                  OR lower(COALESCE(t.plan_name, '')) IN ('payment for invoice', 'none')))
    AND t.plan_type IS DISTINCT FROM 'other'
),
spread AS (
  SELECT b.sku, b.plan_type, b.is_new,
         b.amount_gross / b.pm AS contrib,
         (b.sale_month + make_interval(months => k))::date AS month
  FROM base b
  CROSS JOIN LATERAL generate_series(0, CASE WHEN b.pm < 1 THEN 0 ELSE ceil(b.pm)::int - 1 END) AS k
),
agg AS (
  SELECT sku, plan_type, month,
         SUM(CASE WHEN is_new THEN contrib ELSE 0 END) AS new_rev,
         SUM(CASE WHEN is_new THEN 0 ELSE contrib END) AS rec_rev,
         COUNT(*)                                        AS vol
  FROM spread
  WHERE month BETWEEN p_start_month AND p_end_month
  GROUP BY sku, plan_type, month
)
SELECT COALESCE(
  jsonb_agg(jsonb_build_object('sku', sku, 'plan_type', plan_type, 'month', month,
                               'new_rev', new_rev, 'rec_rev', rec_rev, 'vol', vol)),
  '[]'::jsonb)
FROM agg
$fn$;

-- Prueba rápida (debe tardar unos segundos y el total por mes = mrr_gross del snapshot):
-- SELECT r->>'month' AS month, ROUND(SUM((r->>'new_rev')::numeric + (r->>'rec_rev')::numeric)) AS rev
-- FROM jsonb_array_elements(sku_breakdown_monthly('2026-08-01', '2026-10-01')) r GROUP BY 1 ORDER BY 1;
