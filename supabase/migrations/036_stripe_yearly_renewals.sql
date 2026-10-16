-- 036: renovaciones anuales de iOS cobradas por Stripe (Corregido).
--
-- renewals_sales_yearly_ios incluye renovaciones anuales de usuarios iOS cobradas por Stripe ($55,285 en
-- 2026); Net Sales las netea con la comisión de Apple (0.85 − 6 % impuesto). Pepis decidió (2026-10-15)
-- que en "Corregido" vayan a la comisión de Stripe (0.965). La réplica necesita esa suma aparte:
-- nueva columna stripe_yr_sales en la vista, el rollup y kpi_daily_agg. Después de correrla:
--   npx tsx scripts/backfill-kpi-daily.ts --rollup --from 2024-01-01 --to <hoy>

CREATE OR REPLACE VIEW v_kpi_daily_bucketed AS
SELECT
  k.date,
  COALESCE(k.kinedu_region, 'null')   AS kinedu_region,
  COALESCE(k.country, 'null')         AS country,
  COALESCE(k.os, 'null')              AS os,
  COALESCE(k.kinedu_language, 'null') AS kinedu_language,
  COALESCE(k.network, 'null')         AS network,
  COALESCE(k.payment_processor, 'null') AS payment_processor,
  COALESCE(k.plan_type, 'null')       AS plan_type,
  k.signups::numeric AS signups,
  k.fts_started::numeric AS fts_started,
  k.fts_converted::numeric AS fts_converted,
  k.downloads::numeric AS downloads,
  k.spend::numeric AS spend,
  k.new_subscriptions::numeric AS new_subscriptions,
  k.new_subscriptions_sales::numeric AS new_subscriptions_sales,
  k.renewals::numeric AS renewals,
  k.renewals_sales::numeric AS renewals_sales,
  k.renewals_yearly_ios::numeric AS renewals_yearly_ios,
  k.renewals_sales_yearly_ios::numeric AS renewals_sales_yearly_ios,
  k.other_sales::numeric AS other_sales,
  k.other_purchases::numeric AS other_purchases,
  k.refunds_total_amount_refund_date::numeric AS refunds_total_amount_refund_date,
  k.num_of_refunds_refund_date::numeric AS num_of_refunds_refund_date,
  k.refunds_total_amount_sale_date::numeric AS refunds_total_amount_sale_date,
  k.num_of_refunds_sale_date::numeric AS num_of_refunds_sale_date,
  (CASE WHEN k.network = 'stripe' THEN k.other_sales ELSE 0 END)::numeric AS other_sales_stripe_net,
  (CASE WHEN k.network = 'shopify' THEN k.other_sales ELSE 0 END)::numeric AS other_sales_shopify_net,
  (CASE WHEN k.payment_processor = 'stripe' THEN k.new_subscriptions_sales ELSE 0 END)::numeric AS stripe_ns_sales,
  (CASE WHEN k.payment_processor = 'stripe' THEN k.renewals_sales ELSE 0 END)::numeric AS stripe_ren_sales,
  (CASE WHEN k.os = 'iOS' AND COALESCE(k.payment_processor,'') <> 'stripe' THEN k.renewals_sales ELSE 0 END)::numeric AS ios_ren,
  (CASE WHEN k.os = 'iOS' AND COALESCE(k.payment_processor,'') <> 'stripe' THEN k.new_subscriptions_sales ELSE 0 END)::numeric AS ios_ns,
  (CASE WHEN k.os = 'iOS' AND COALESCE(k.payment_processor,'') <> 'stripe' THEN k.refunds_total_amount_sale_date ELSE 0 END)::numeric AS ios_rsd,
  (CASE WHEN k.os = 'iOS' AND k.payment_processor = 'stripe' THEN k.renewals_sales ELSE 0 END)::numeric AS ios_ren_s,
  (CASE WHEN k.os = 'iOS' AND k.payment_processor = 'stripe' THEN k.new_subscriptions_sales ELSE 0 END)::numeric AS ios_ns_s,
  (CASE WHEN k.os = 'iOS' AND k.payment_processor = 'stripe' THEN k.refunds_total_amount_sale_date ELSE 0 END)::numeric AS ios_rsd_s,
  (CASE WHEN k.os = 'Android' AND COALESCE(k.payment_processor,'') <> 'stripe' THEN k.renewals_sales ELSE 0 END)::numeric AS and_ren,
  (CASE WHEN k.os = 'Android' AND COALESCE(k.payment_processor,'') <> 'stripe' THEN k.new_subscriptions_sales ELSE 0 END)::numeric AS and_ns,
  (CASE WHEN k.os = 'Android' AND COALESCE(k.payment_processor,'') <> 'stripe' THEN k.refunds_total_amount_sale_date ELSE 0 END)::numeric AS and_rsd,
  (CASE WHEN k.os = 'Android' AND k.payment_processor = 'stripe' THEN k.renewals_sales ELSE 0 END)::numeric AS and_ren_s,
  (CASE WHEN k.os = 'Android' AND k.payment_processor = 'stripe' THEN k.new_subscriptions_sales ELSE 0 END)::numeric AS and_ns_s,
  (CASE WHEN k.os = 'Android' AND k.payment_processor = 'stripe' THEN k.refunds_total_amount_sale_date ELSE 0 END)::numeric AS and_rsd_s,
  (CASE WHEN k.os = 'Web' AND COALESCE(k.payment_processor,'') <> 'stripe' THEN k.renewals_sales ELSE 0 END)::numeric AS web_ren,
  (CASE WHEN k.os = 'Web' AND COALESCE(k.payment_processor,'') <> 'stripe' THEN k.new_subscriptions_sales ELSE 0 END)::numeric AS web_ns,
  (CASE WHEN k.os = 'Web' AND COALESCE(k.payment_processor,'') <> 'stripe' THEN k.refunds_total_amount_sale_date ELSE 0 END)::numeric AS web_rsd,
  (CASE WHEN k.os = 'Web' AND k.payment_processor = 'stripe' THEN k.renewals_sales ELSE 0 END)::numeric AS web_ren_s,
  (CASE WHEN k.os = 'Web' AND k.payment_processor = 'stripe' THEN k.new_subscriptions_sales ELSE 0 END)::numeric AS web_ns_s,
  (CASE WHEN k.os = 'Web' AND k.payment_processor = 'stripe' THEN k.refunds_total_amount_sale_date ELSE 0 END)::numeric AS web_rsd_s,
  (CASE WHEN k.os = 'Unknown' AND COALESCE(k.payment_processor,'') <> 'stripe' THEN k.renewals_sales ELSE 0 END)::numeric AS unk_ren,
  (CASE WHEN k.os = 'Unknown' AND COALESCE(k.payment_processor,'') <> 'stripe' THEN k.new_subscriptions_sales ELSE 0 END)::numeric AS unk_ns,
  (CASE WHEN k.os = 'Unknown' AND COALESCE(k.payment_processor,'') <> 'stripe' THEN k.refunds_total_amount_sale_date ELSE 0 END)::numeric AS unk_rsd,
  (CASE WHEN k.os = 'Unknown' AND k.payment_processor = 'stripe' THEN k.renewals_sales ELSE 0 END)::numeric AS unk_ren_s,
  (CASE WHEN k.os = 'Unknown' AND k.payment_processor = 'stripe' THEN k.new_subscriptions_sales ELSE 0 END)::numeric AS unk_ns_s,
  (CASE WHEN k.os = 'Unknown' AND k.payment_processor = 'stripe' THEN k.refunds_total_amount_sale_date ELSE 0 END)::numeric AS unk_rsd_s,
  (CASE WHEN k.payment_processor = 'stripe' THEN k.renewals_sales_yearly_ios ELSE 0 END)::numeric AS stripe_yr_sales
FROM kpi_daily k;

ALTER TABLE kpi_rollup ADD COLUMN IF NOT EXISTS stripe_yr_sales numeric NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION refresh_kpi_rollup(p_start date, p_end date)
RETURNS TABLE (weeks_from date, weeks_to date, months_from date, months_to date, rows_written bigint)
LANGUAGE plpgsql AS $fn$
DECLARE
  ws date := date_trunc('week', p_start)::date;
  we date := (date_trunc('week', p_end) + interval '6 days')::date;
  ms date := date_trunc('month', p_start)::date;
  me date := (date_trunc('month', p_end) + interval '1 month - 1 day')::date;
  n1 bigint; n2 bigint;
BEGIN
  DELETE FROM kpi_rollup WHERE grain = 'week' AND period BETWEEN ws AND we;
  INSERT INTO kpi_rollup (grain, period, kinedu_region, country, os, kinedu_language, signups, fts_started, fts_converted, downloads, spend, new_subscriptions, new_subscriptions_sales, renewals, renewals_sales, renewals_yearly_ios, renewals_sales_yearly_ios, other_sales, other_purchases, refunds_total_amount_refund_date, num_of_refunds_refund_date, refunds_total_amount_sale_date, num_of_refunds_sale_date, other_sales_stripe_net, other_sales_shopify_net, stripe_ns_sales, stripe_ren_sales, ios_ren, ios_ns, ios_rsd, ios_ren_s, ios_ns_s, ios_rsd_s, and_ren, and_ns, and_rsd, and_ren_s, and_ns_s, and_rsd_s, web_ren, web_ns, web_rsd, web_ren_s, web_ns_s, web_rsd_s, unk_ren, unk_ns, unk_rsd, unk_ren_s, unk_ns_s, unk_rsd_s, stripe_yr_sales)
  SELECT 'week', date_trunc('week', b.date)::date, b.kinedu_region, b.country, b.os, b.kinedu_language,
    SUM(b.signups),
    SUM(b.fts_started),
    SUM(b.fts_converted),
    SUM(b.downloads),
    SUM(b.spend),
    SUM(b.new_subscriptions),
    SUM(b.new_subscriptions_sales),
    SUM(b.renewals),
    SUM(b.renewals_sales),
    SUM(b.renewals_yearly_ios),
    SUM(b.renewals_sales_yearly_ios),
    SUM(b.other_sales),
    SUM(b.other_purchases),
    SUM(b.refunds_total_amount_refund_date),
    SUM(b.num_of_refunds_refund_date),
    SUM(b.refunds_total_amount_sale_date),
    SUM(b.num_of_refunds_sale_date),
    SUM(b.other_sales_stripe_net),
    SUM(b.other_sales_shopify_net),
    SUM(b.stripe_ns_sales),
    SUM(b.stripe_ren_sales),
    SUM(b.ios_ren),
    SUM(b.ios_ns),
    SUM(b.ios_rsd),
    SUM(b.ios_ren_s),
    SUM(b.ios_ns_s),
    SUM(b.ios_rsd_s),
    SUM(b.and_ren),
    SUM(b.and_ns),
    SUM(b.and_rsd),
    SUM(b.and_ren_s),
    SUM(b.and_ns_s),
    SUM(b.and_rsd_s),
    SUM(b.web_ren),
    SUM(b.web_ns),
    SUM(b.web_rsd),
    SUM(b.web_ren_s),
    SUM(b.web_ns_s),
    SUM(b.web_rsd_s),
    SUM(b.unk_ren),
    SUM(b.unk_ns),
    SUM(b.unk_rsd),
    SUM(b.unk_ren_s),
    SUM(b.unk_ns_s),
    SUM(b.unk_rsd_s),
    SUM(b.stripe_yr_sales)
  FROM v_kpi_daily_bucketed b WHERE b.date BETWEEN ws AND we
  GROUP BY 2, 3, 4, 5, 6;
  GET DIAGNOSTICS n1 = ROW_COUNT;

  DELETE FROM kpi_rollup WHERE grain = 'month' AND period BETWEEN ms AND me;
  INSERT INTO kpi_rollup (grain, period, kinedu_region, country, os, kinedu_language, signups, fts_started, fts_converted, downloads, spend, new_subscriptions, new_subscriptions_sales, renewals, renewals_sales, renewals_yearly_ios, renewals_sales_yearly_ios, other_sales, other_purchases, refunds_total_amount_refund_date, num_of_refunds_refund_date, refunds_total_amount_sale_date, num_of_refunds_sale_date, other_sales_stripe_net, other_sales_shopify_net, stripe_ns_sales, stripe_ren_sales, ios_ren, ios_ns, ios_rsd, ios_ren_s, ios_ns_s, ios_rsd_s, and_ren, and_ns, and_rsd, and_ren_s, and_ns_s, and_rsd_s, web_ren, web_ns, web_rsd, web_ren_s, web_ns_s, web_rsd_s, unk_ren, unk_ns, unk_rsd, unk_ren_s, unk_ns_s, unk_rsd_s, stripe_yr_sales)
  SELECT 'month', date_trunc('month', b.date)::date, b.kinedu_region, b.country, b.os, b.kinedu_language,
    SUM(b.signups),
    SUM(b.fts_started),
    SUM(b.fts_converted),
    SUM(b.downloads),
    SUM(b.spend),
    SUM(b.new_subscriptions),
    SUM(b.new_subscriptions_sales),
    SUM(b.renewals),
    SUM(b.renewals_sales),
    SUM(b.renewals_yearly_ios),
    SUM(b.renewals_sales_yearly_ios),
    SUM(b.other_sales),
    SUM(b.other_purchases),
    SUM(b.refunds_total_amount_refund_date),
    SUM(b.num_of_refunds_refund_date),
    SUM(b.refunds_total_amount_sale_date),
    SUM(b.num_of_refunds_sale_date),
    SUM(b.other_sales_stripe_net),
    SUM(b.other_sales_shopify_net),
    SUM(b.stripe_ns_sales),
    SUM(b.stripe_ren_sales),
    SUM(b.ios_ren),
    SUM(b.ios_ns),
    SUM(b.ios_rsd),
    SUM(b.ios_ren_s),
    SUM(b.ios_ns_s),
    SUM(b.ios_rsd_s),
    SUM(b.and_ren),
    SUM(b.and_ns),
    SUM(b.and_rsd),
    SUM(b.and_ren_s),
    SUM(b.and_ns_s),
    SUM(b.and_rsd_s),
    SUM(b.web_ren),
    SUM(b.web_ns),
    SUM(b.web_rsd),
    SUM(b.web_ren_s),
    SUM(b.web_ns_s),
    SUM(b.web_rsd_s),
    SUM(b.unk_ren),
    SUM(b.unk_ns),
    SUM(b.unk_rsd),
    SUM(b.unk_ren_s),
    SUM(b.unk_ns_s),
    SUM(b.unk_rsd_s),
    SUM(b.stripe_yr_sales)
  FROM v_kpi_daily_bucketed b WHERE b.date BETWEEN ms AND me
  GROUP BY 2, 3, 4, 5, 6;
  GET DIAGNOSTICS n2 = ROW_COUNT;

  RETURN QUERY SELECT ws, we, ms, me, n1 + n2;
END
$fn$;

-- La firma de salida cambia (columna nueva): hay que borrar y recrear.
DROP FUNCTION IF EXISTS kpi_daily_agg(date, date, text, text, text[], text[], text[], text[]);
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
RETURNS TABLE (period date, grp text, signups numeric, fts_started numeric, fts_converted numeric, downloads numeric, spend numeric, new_subscriptions numeric, new_subscriptions_sales numeric, renewals numeric, renewals_sales numeric, renewals_yearly_ios numeric, renewals_sales_yearly_ios numeric, other_sales numeric, other_purchases numeric, refunds_total_amount_refund_date numeric, num_of_refunds_refund_date numeric, refunds_total_amount_sale_date numeric, num_of_refunds_sale_date numeric, other_sales_stripe_net numeric, other_sales_shopify_net numeric, stripe_ns_sales numeric, stripe_ren_sales numeric, ios_ren numeric, ios_ns numeric, ios_rsd numeric, ios_ren_s numeric, ios_ns_s numeric, ios_rsd_s numeric, and_ren numeric, and_ns numeric, and_rsd numeric, and_ren_s numeric, and_ns_s numeric, and_rsd_s numeric, web_ren numeric, web_ns numeric, web_rsd numeric, web_ren_s numeric, web_ns_s numeric, web_rsd_s numeric, unk_ren numeric, unk_ns numeric, unk_rsd numeric, unk_ren_s numeric, unk_ns_s numeric, unk_rsd_s numeric, stripe_yr_sales numeric)
LANGUAGE plpgsql STABLE AS $fn$
DECLARE
  -- El rollup solo tiene las 4 dimensiones del filtro; agrupar por network/processor/plan va al diario.
  can_roll boolean := p_group IN ('none', 'os', 'country', 'kinedu_language', 'kinedu_region');
  use_month boolean := can_roll AND p_grain IN ('month', 'quarter', 'year', 'total');
  use_week  boolean := can_roll AND p_grain = 'week';
  -- Ventana cubierta por periodos COMPLETOS: [c_lo, c_hi)
  c_lo date; c_hi date;
BEGIN
  IF use_month THEN
    c_lo := CASE WHEN p_start = date_trunc('month', p_start)::date THEN p_start ELSE (date_trunc('month', p_start) + interval '1 month')::date END;
    c_hi := date_trunc('month', p_end + 1)::date;
  ELSIF use_week THEN
    c_lo := CASE WHEN p_start = date_trunc('week', p_start)::date THEN p_start ELSE (date_trunc('week', p_start) + interval '7 days')::date END;
    c_hi := date_trunc('week', p_end + 1)::date;
  END IF;
  IF c_lo IS NULL OR c_lo >= c_hi THEN c_lo := NULL; c_hi := NULL; END IF;

  RETURN QUERY
  WITH src AS (
    SELECT r.period AS d, r.kinedu_region, r.country, r.os, r.kinedu_language,
           ''::text AS network, ''::text AS payment_processor, ''::text AS plan_type,
           r.signups, r.fts_started, r.fts_converted, r.downloads, r.spend, r.new_subscriptions, r.new_subscriptions_sales, r.renewals, r.renewals_sales, r.renewals_yearly_ios, r.renewals_sales_yearly_ios, r.other_sales, r.other_purchases, r.refunds_total_amount_refund_date, r.num_of_refunds_refund_date, r.refunds_total_amount_sale_date, r.num_of_refunds_sale_date, r.other_sales_stripe_net, r.other_sales_shopify_net, r.stripe_ns_sales, r.stripe_ren_sales, r.ios_ren, r.ios_ns, r.ios_rsd, r.ios_ren_s, r.ios_ns_s, r.ios_rsd_s, r.and_ren, r.and_ns, r.and_rsd, r.and_ren_s, r.and_ns_s, r.and_rsd_s, r.web_ren, r.web_ns, r.web_rsd, r.web_ren_s, r.web_ns_s, r.web_rsd_s, r.unk_ren, r.unk_ns, r.unk_rsd, r.unk_ren_s, r.unk_ns_s, r.unk_rsd_s, r.stripe_yr_sales
    FROM kpi_rollup r
    WHERE c_lo IS NOT NULL
      AND r.grain = CASE WHEN use_week THEN 'week' ELSE 'month' END
      AND r.period >= c_lo AND r.period < c_hi
    UNION ALL
    SELECT b.date, b.kinedu_region, b.country, b.os, b.kinedu_language, b.network, b.payment_processor, b.plan_type,
           b.signups, b.fts_started, b.fts_converted, b.downloads, b.spend, b.new_subscriptions, b.new_subscriptions_sales, b.renewals, b.renewals_sales, b.renewals_yearly_ios, b.renewals_sales_yearly_ios, b.other_sales, b.other_purchases, b.refunds_total_amount_refund_date, b.num_of_refunds_refund_date, b.refunds_total_amount_sale_date, b.num_of_refunds_sale_date, b.other_sales_stripe_net, b.other_sales_shopify_net, b.stripe_ns_sales, b.stripe_ren_sales, b.ios_ren, b.ios_ns, b.ios_rsd, b.ios_ren_s, b.ios_ns_s, b.ios_rsd_s, b.and_ren, b.and_ns, b.and_rsd, b.and_ren_s, b.and_ns_s, b.and_rsd_s, b.web_ren, b.web_ns, b.web_rsd, b.web_ren_s, b.web_ns_s, b.web_rsd_s, b.unk_ren, b.unk_ns, b.unk_rsd, b.unk_ren_s, b.unk_ns_s, b.unk_rsd_s, b.stripe_yr_sales
    FROM v_kpi_daily_bucketed b
    WHERE b.date BETWEEN p_start AND p_end
      AND (c_lo IS NULL OR b.date < c_lo OR b.date >= c_hi)
  )
  SELECT
    (CASE p_grain
      WHEN 'week'    THEN date_trunc('week', s.d)::date
      WHEN 'month'   THEN date_trunc('month', s.d)::date
      WHEN 'quarter' THEN date_trunc('quarter', s.d)::date
      WHEN 'year'    THEN date_trunc('year', s.d)::date
      WHEN 'total'   THEN p_start
      ELSE s.d
    END) AS period,
    (CASE p_group
      WHEN 'os'                THEN s.os
      WHEN 'country'           THEN s.country
      WHEN 'kinedu_language'   THEN s.kinedu_language
      WHEN 'kinedu_region'     THEN s.kinedu_region
      WHEN 'network'           THEN s.network
      WHEN 'payment_processor' THEN s.payment_processor
      WHEN 'plan_type'         THEN s.plan_type
      ELSE ''
    END) AS grp,
    SUM(s.signups),
    SUM(s.fts_started),
    SUM(s.fts_converted),
    SUM(s.downloads),
    SUM(s.spend),
    SUM(s.new_subscriptions),
    SUM(s.new_subscriptions_sales),
    SUM(s.renewals),
    SUM(s.renewals_sales),
    SUM(s.renewals_yearly_ios),
    SUM(s.renewals_sales_yearly_ios),
    SUM(s.other_sales),
    SUM(s.other_purchases),
    SUM(s.refunds_total_amount_refund_date),
    SUM(s.num_of_refunds_refund_date),
    SUM(s.refunds_total_amount_sale_date),
    SUM(s.num_of_refunds_sale_date),
    SUM(s.other_sales_stripe_net),
    SUM(s.other_sales_shopify_net),
    SUM(s.stripe_ns_sales),
    SUM(s.stripe_ren_sales),
    SUM(s.ios_ren),
    SUM(s.ios_ns),
    SUM(s.ios_rsd),
    SUM(s.ios_ren_s),
    SUM(s.ios_ns_s),
    SUM(s.ios_rsd_s),
    SUM(s.and_ren),
    SUM(s.and_ns),
    SUM(s.and_rsd),
    SUM(s.and_ren_s),
    SUM(s.and_ns_s),
    SUM(s.and_rsd_s),
    SUM(s.web_ren),
    SUM(s.web_ns),
    SUM(s.web_rsd),
    SUM(s.web_ren_s),
    SUM(s.web_ns_s),
    SUM(s.web_rsd_s),
    SUM(s.unk_ren),
    SUM(s.unk_ns),
    SUM(s.unk_rsd),
    SUM(s.unk_ren_s),
    SUM(s.unk_ns_s),
    SUM(s.unk_rsd_s),
    SUM(s.stripe_yr_sales)
  FROM src s
  WHERE (p_region  IS NULL OR s.kinedu_region   = ANY(p_region))
    AND (p_country IS NULL OR s.country         = ANY(p_country))
    AND (p_os      IS NULL OR s.os              = ANY(p_os))
    AND (p_lang    IS NULL OR s.kinedu_language = ANY(p_lang))
  GROUP BY 1, 2
  ORDER BY 1, 2;
END
$fn$;

