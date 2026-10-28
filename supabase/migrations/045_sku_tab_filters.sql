-- 045: filtros en la pestaña Breakdown SKU (2026-10-27, pedido de Pepis: "agrega estos filtros, mover timeline").
--
-- Los dos RPC de la pestaña (043 sku_breakdown_monthly, 044 sku_mix_by_store_monthly) reciben ahora filtros
-- opcionales por tienda (source), región (region) y país (country_code). NULL o vacío = todos.
-- Se eliminan las firmas viejas: si convivieran dos sobrecargas, PostgREST no sabría cuál elegir al llamar
-- sólo con fechas. Mientras esta migración no esté aplicada, la app cae al camino en Node (más lento).
--
-- Además, transactions_dim_values() devuelve los valores de región y país (últimos 24 meses de cargos) para
-- poblar los desplegables.

DROP FUNCTION IF EXISTS sku_breakdown_monthly(date, date);
DROP FUNCTION IF EXISTS sku_mix_by_store_monthly(date, date);

CREATE OR REPLACE FUNCTION sku_breakdown_monthly(
  p_start_month date, p_end_month date,
  p_sources text[] DEFAULT NULL, p_regions text[] DEFAULT NULL, p_countries text[] DEFAULT NULL)
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
    AND t.transaction_date >= (p_start_month - interval '13 months')::date
    AND t.transaction_date <  (p_end_month + interval '1 month')::date
    AND lower(COALESCE(t.plan_name, '')) NOT LIKE '%test%'
    AND NOT (COALESCE(t.source, '') = 'stripe'
             AND (lower(COALESCE(t.plan_name, '')) LIKE '% charge'
                  OR lower(COALESCE(t.plan_name, '')) IN ('payment for invoice', 'none')))
    AND t.plan_type IS DISTINCT FROM 'other'
    AND (p_sources   IS NULL OR cardinality(p_sources)   = 0 OR t.source       = ANY(p_sources))
    AND (p_regions   IS NULL OR cardinality(p_regions)   = 0 OR t.region       = ANY(p_regions))
    AND (p_countries IS NULL OR cardinality(p_countries) = 0 OR t.country_code = ANY(p_countries))
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

CREATE OR REPLACE FUNCTION sku_mix_by_store_monthly(
  p_from date, p_to date,
  p_sources text[] DEFAULT NULL, p_regions text[] DEFAULT NULL, p_countries text[] DEFAULT NULL)
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
    AND (p_sources   IS NULL OR cardinality(p_sources)   = 0 OR t.source       = ANY(p_sources))
    AND (p_regions   IS NULL OR cardinality(p_regions)   = 0 OR t.region       = ANY(p_regions))
    AND (p_countries IS NULL OR cardinality(p_countries) = 0 OR t.country_code = ANY(p_countries))
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

-- Valores para los desplegables: región y país con su número de cargos (últimos 24 meses).
CREATE OR REPLACE FUNCTION transactions_dim_values()
RETURNS jsonb
LANGUAGE sql STABLE
SET statement_timeout = '60s'
AS $fn$
WITH base AS (
  SELECT region, country_code
  FROM transactions
  WHERE transaction_type = 'charge'
    AND transaction_date >= (date_trunc('month', now()) - interval '24 months')::date
)
SELECT jsonb_build_object(
  'regions',   (SELECT COALESCE(jsonb_agg(jsonb_build_object('value', region, 'n', n) ORDER BY n DESC), '[]'::jsonb)
                FROM (SELECT region, COUNT(*) n FROM base WHERE region IS NOT NULL GROUP BY region) r),
  'countries', (SELECT COALESCE(jsonb_agg(jsonb_build_object('value', country_code, 'n', n) ORDER BY n DESC), '[]'::jsonb)
                FROM (SELECT country_code, COUNT(*) n FROM base WHERE country_code IS NOT NULL GROUP BY country_code) c)
)
$fn$;

-- Prueba rápida:
-- SELECT jsonb_array_length(sku_mix_by_store_monthly('2026-01-01','2026-11-01', ARRAY['apple'], NULL, ARRAY['MX']));
-- SELECT transactions_dim_values();
