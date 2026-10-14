-- 032: funciones de agregación sobre kpi_daily para la sección "Operativo" del dashboard
-- (réplica del Looker Operational Dashboard).
--
-- kpi_daily_agg: suma los campos base por periodo (día / semana ISO / mes / trimestre / año /
-- total) y opcionalmente por una dimensión, aplicando los mismos filtros que el Looker
-- (kinedu_region, country, os, kinedu_language). Devuelve además las sumas por "bucket" de
-- OS separadas en no-Stripe / Stripe, que es lo único que las fórmulas de Net Sales necesitan
-- para reproducir tanto la definición actual del Looker como la corregida (Variante 2).
-- Los KPIs se calculan en TypeScript (lib/kpi/replica.ts) para que exista UNA sola
-- implementación de las fórmulas, verificable contra BigQuery.
--
-- kpi_daily_dim_values: valores disponibles de cada dimensión (para los filtros).
-- kpi_daily_status: frescura de la réplica.

CREATE OR REPLACE FUNCTION kpi_daily_agg(
  p_start   date,
  p_end     date,
  p_grain   text DEFAULT 'day',    -- day | week | month | quarter | year | total
  p_group   text DEFAULT 'none',   -- none | os | country | kinedu_language | kinedu_region | network | payment_processor | plan_type
  p_region  text[] DEFAULT NULL,
  p_country text[] DEFAULT NULL,
  p_os      text[] DEFAULT NULL,
  p_lang    text[] DEFAULT NULL
)
RETURNS TABLE (
  period date,
  grp text,
  signups numeric, fts_started numeric, fts_converted numeric, downloads numeric, spend numeric,
  new_subscriptions numeric, new_subscriptions_sales numeric,
  renewals numeric, renewals_sales numeric, renewals_yearly_ios numeric, renewals_sales_yearly_ios numeric,
  other_sales numeric, other_purchases numeric,
  refunds_total_amount_refund_date numeric, num_of_refunds_refund_date numeric,
  refunds_total_amount_sale_date numeric, num_of_refunds_sale_date numeric,
  other_sales_stripe_net numeric, other_sales_shopify_net numeric,
  stripe_ns_sales numeric, stripe_ren_sales numeric,
  ios_ren numeric, ios_ns numeric, ios_rsd numeric, ios_ren_s numeric, ios_ns_s numeric, ios_rsd_s numeric,
  and_ren numeric, and_ns numeric, and_rsd numeric, and_ren_s numeric, and_ns_s numeric, and_rsd_s numeric,
  web_ren numeric, web_ns numeric, web_rsd numeric, web_ren_s numeric, web_ns_s numeric, web_rsd_s numeric,
  unk_ren numeric, unk_ns numeric, unk_rsd numeric, unk_ren_s numeric, unk_ns_s numeric, unk_rsd_s numeric
)
LANGUAGE sql STABLE AS $$
  SELECT
    CASE p_grain
      WHEN 'week'    THEN date_trunc('week', k.date)::date
      WHEN 'month'   THEN date_trunc('month', k.date)::date
      WHEN 'quarter' THEN date_trunc('quarter', k.date)::date
      WHEN 'year'    THEN date_trunc('year', k.date)::date
      WHEN 'total'   THEN p_start
      ELSE k.date
    END AS period,
    CASE p_group
      WHEN 'os'                THEN COALESCE(k.os, 'null')
      WHEN 'country'           THEN COALESCE(k.country, 'null')
      WHEN 'kinedu_language'   THEN COALESCE(k.kinedu_language, 'null')
      WHEN 'kinedu_region'     THEN COALESCE(k.kinedu_region, 'null')
      WHEN 'network'           THEN COALESCE(k.network, 'null')
      WHEN 'payment_processor' THEN COALESCE(k.payment_processor, 'null')
      WHEN 'plan_type'         THEN COALESCE(k.plan_type, 'null')
      ELSE ''
    END AS grp,
    SUM(k.signups)::numeric, SUM(k.fts_started)::numeric, SUM(k.fts_converted)::numeric, SUM(k.downloads)::numeric, SUM(k.spend),
    SUM(k.new_subscriptions)::numeric, SUM(k.new_subscriptions_sales),
    SUM(k.renewals)::numeric, SUM(k.renewals_sales), SUM(k.renewals_yearly_ios)::numeric, SUM(k.renewals_sales_yearly_ios),
    SUM(k.other_sales), SUM(k.other_purchases)::numeric,
    SUM(k.refunds_total_amount_refund_date), SUM(k.num_of_refunds_refund_date)::numeric,
    SUM(k.refunds_total_amount_sale_date), SUM(k.num_of_refunds_sale_date)::numeric,
    SUM(CASE WHEN k.network = 'stripe'  THEN k.other_sales ELSE 0 END),
    SUM(CASE WHEN k.network = 'shopify' THEN k.other_sales ELSE 0 END),
    SUM(CASE WHEN k.payment_processor = 'stripe' THEN k.new_subscriptions_sales ELSE 0 END),
    SUM(CASE WHEN k.payment_processor = 'stripe' THEN k.renewals_sales ELSE 0 END),
    -- iOS
    SUM(CASE WHEN k.os = 'iOS' AND COALESCE(k.payment_processor,'') <> 'stripe' THEN k.renewals_sales ELSE 0 END),
    SUM(CASE WHEN k.os = 'iOS' AND COALESCE(k.payment_processor,'') <> 'stripe' THEN k.new_subscriptions_sales ELSE 0 END),
    SUM(CASE WHEN k.os = 'iOS' AND COALESCE(k.payment_processor,'') <> 'stripe' THEN k.refunds_total_amount_sale_date ELSE 0 END),
    SUM(CASE WHEN k.os = 'iOS' AND k.payment_processor = 'stripe' THEN k.renewals_sales ELSE 0 END),
    SUM(CASE WHEN k.os = 'iOS' AND k.payment_processor = 'stripe' THEN k.new_subscriptions_sales ELSE 0 END),
    SUM(CASE WHEN k.os = 'iOS' AND k.payment_processor = 'stripe' THEN k.refunds_total_amount_sale_date ELSE 0 END),
    -- Android
    SUM(CASE WHEN k.os = 'Android' AND COALESCE(k.payment_processor,'') <> 'stripe' THEN k.renewals_sales ELSE 0 END),
    SUM(CASE WHEN k.os = 'Android' AND COALESCE(k.payment_processor,'') <> 'stripe' THEN k.new_subscriptions_sales ELSE 0 END),
    SUM(CASE WHEN k.os = 'Android' AND COALESCE(k.payment_processor,'') <> 'stripe' THEN k.refunds_total_amount_sale_date ELSE 0 END),
    SUM(CASE WHEN k.os = 'Android' AND k.payment_processor = 'stripe' THEN k.renewals_sales ELSE 0 END),
    SUM(CASE WHEN k.os = 'Android' AND k.payment_processor = 'stripe' THEN k.new_subscriptions_sales ELSE 0 END),
    SUM(CASE WHEN k.os = 'Android' AND k.payment_processor = 'stripe' THEN k.refunds_total_amount_sale_date ELSE 0 END),
    -- Web
    SUM(CASE WHEN k.os = 'Web' AND COALESCE(k.payment_processor,'') <> 'stripe' THEN k.renewals_sales ELSE 0 END),
    SUM(CASE WHEN k.os = 'Web' AND COALESCE(k.payment_processor,'') <> 'stripe' THEN k.new_subscriptions_sales ELSE 0 END),
    SUM(CASE WHEN k.os = 'Web' AND COALESCE(k.payment_processor,'') <> 'stripe' THEN k.refunds_total_amount_sale_date ELSE 0 END),
    SUM(CASE WHEN k.os = 'Web' AND k.payment_processor = 'stripe' THEN k.renewals_sales ELSE 0 END),
    SUM(CASE WHEN k.os = 'Web' AND k.payment_processor = 'stripe' THEN k.new_subscriptions_sales ELSE 0 END),
    SUM(CASE WHEN k.os = 'Web' AND k.payment_processor = 'stripe' THEN k.refunds_total_amount_sale_date ELSE 0 END),
    -- Unknown
    SUM(CASE WHEN k.os = 'Unknown' AND COALESCE(k.payment_processor,'') <> 'stripe' THEN k.renewals_sales ELSE 0 END),
    SUM(CASE WHEN k.os = 'Unknown' AND COALESCE(k.payment_processor,'') <> 'stripe' THEN k.new_subscriptions_sales ELSE 0 END),
    SUM(CASE WHEN k.os = 'Unknown' AND COALESCE(k.payment_processor,'') <> 'stripe' THEN k.refunds_total_amount_sale_date ELSE 0 END),
    SUM(CASE WHEN k.os = 'Unknown' AND k.payment_processor = 'stripe' THEN k.renewals_sales ELSE 0 END),
    SUM(CASE WHEN k.os = 'Unknown' AND k.payment_processor = 'stripe' THEN k.new_subscriptions_sales ELSE 0 END),
    SUM(CASE WHEN k.os = 'Unknown' AND k.payment_processor = 'stripe' THEN k.refunds_total_amount_sale_date ELSE 0 END)
  FROM kpi_daily k
  WHERE k.date BETWEEN p_start AND p_end
    AND (p_region  IS NULL OR COALESCE(k.kinedu_region, 'null')   = ANY(p_region))
    AND (p_country IS NULL OR COALESCE(k.country, 'null')         = ANY(p_country))
    AND (p_os      IS NULL OR COALESCE(k.os, 'null')              = ANY(p_os))
    AND (p_lang    IS NULL OR COALESCE(k.kinedu_language, 'null') = ANY(p_lang))
  GROUP BY 1, 2
  ORDER BY 1, 2;
$$;

-- Valores de cada dimensión con su volumen reciente, para poblar y ordenar los filtros.
CREATE OR REPLACE FUNCTION kpi_daily_dim_values(p_from date DEFAULT (CURRENT_DATE - 90))
RETURNS TABLE (dim text, value text, signups numeric, spend numeric)
LANGUAGE sql STABLE AS $$
  SELECT 'kinedu_region', COALESCE(kinedu_region, 'null'), SUM(signups)::numeric, SUM(spend) FROM kpi_daily WHERE date >= p_from GROUP BY 2
  UNION ALL
  SELECT 'country', COALESCE(country, 'null'), SUM(signups)::numeric, SUM(spend) FROM kpi_daily WHERE date >= p_from GROUP BY 2
  UNION ALL
  SELECT 'os', COALESCE(os, 'null'), SUM(signups)::numeric, SUM(spend) FROM kpi_daily WHERE date >= p_from GROUP BY 2
  UNION ALL
  SELECT 'kinedu_language', COALESCE(kinedu_language, 'null'), SUM(signups)::numeric, SUM(spend) FROM kpi_daily WHERE date >= p_from GROUP BY 2
  ORDER BY 1, 3 DESC;
$$;

-- Frescura de la réplica.
CREATE OR REPLACE FUNCTION kpi_daily_status()
RETURNS TABLE (min_date date, max_date date, rows_n bigint, last_synced_at timestamptz)
LANGUAGE sql STABLE AS $$
  SELECT MIN(date), MAX(date), COUNT(*), MAX(synced_at) FROM kpi_daily;
$$;
