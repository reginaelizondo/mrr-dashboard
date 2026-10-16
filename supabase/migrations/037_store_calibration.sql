-- 037: Corregido calibrado con lo que reporta cada tienda (Apple, Google, Stripe).
--
-- store_daily: lo que cada tienda reporta por día y país, en USD al tipo de cambio de la propia tienda:
--   paid_usd    = lo que pagó el cliente (con impuesto, misma base que Total Sales del Looker)
--   net_usd     = lo que deposita la tienda (sin impuesto ni comisión)  → base de Net Sales
--   refunds_*   = reembolsos del día (por fecha de reembolso), misma base
--   status      = 'final' (reporte definitivo) | 'estimado' (p. ej. Google del mes en curso, sin earnings)
-- Fuentes: Apple apple_sales_daily (desde 2025-04-07) · Google earnings mensuales (exacto) o reporte de
-- ventas diario + FX y comisión del último earnings (estimado) (desde 2026-01) · Stripe API (todo).
--
-- kpi_calibration: factor por (día, payment_processor, país) = tienda / BigQuery, sobre los 7 días que
-- terminan en ese día (suaviza husos horarios y países chicos). Si el país tiene < $50 de BigQuery en la
-- ventana se usa el factor del procesador completo. Días sin reporte de tienda todavía (Apple tarda 1–2
-- días) usan la ventana disponible y quedan status = 'estimado'. Sin datos de tienda → sin factor y la fila
-- usa las tasas fijas del Corregido (cal_uncal_gross lo marca).
--
-- La vista v_kpi_daily_bucketed agrega las columnas cal_* (Corregido) — el rollup y kpi_daily_agg las suman.
-- Después de correrla: npx tsx scripts/backfill-store-daily.ts --from 2024-01-01 --to <hoy>

CREATE TABLE IF NOT EXISTS store_daily (
  date              DATE NOT NULL,
  store             TEXT NOT NULL CHECK (store IN ('apple', 'google', 'stripe')),
  country           TEXT NOT NULL,
  paid_usd          NUMERIC NOT NULL DEFAULT 0,
  net_usd           NUMERIC NOT NULL DEFAULT 0,
  refunds_paid_usd  NUMERIC NOT NULL DEFAULT 0,
  refunds_net_usd   NUMERIC NOT NULL DEFAULT 0,
  charges           BIGINT  NOT NULL DEFAULT 0,
  refunds_n         BIGINT  NOT NULL DEFAULT 0,
  status            TEXT    NOT NULL DEFAULT 'final' CHECK (status IN ('final', 'estimado')),
  source            TEXT    NOT NULL,
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (date, store, country)
);
CREATE INDEX IF NOT EXISTS store_daily_store_date_idx ON store_daily (store, date);
COMMENT ON TABLE store_daily IS 'Ventas por tienda, día y país en USD de la propia tienda (base del Corregido calibrado). Ver migración 037.';

CREATE TABLE IF NOT EXISTS kpi_calibration (
  date              DATE NOT NULL,
  payment_processor TEXT NOT NULL,
  country           TEXT NOT NULL,
  k_gross           NUMERIC,
  k_net             NUMERIC,
  k_ref_gross       NUMERIC,
  k_ref_net         NUMERIC,
  level             TEXT NOT NULL,   -- 'pais' | 'procesador'
  status            TEXT NOT NULL,   -- 'real' | 'estimado'
  refreshed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (date, payment_processor, country)
);
COMMENT ON TABLE kpi_calibration IS 'Factores tienda/BigQuery por día × procesador × país (ventana 7 días). Ver migración 037.';

CREATE OR REPLACE FUNCTION refresh_kpi_calibration(p_start date, p_end date)
RETURNS bigint
LANGUAGE plpgsql AS $fn$
DECLARE n bigint;
BEGIN
  DELETE FROM kpi_calibration WHERE date BETWEEN p_start AND p_end;
  WITH bq AS (
    SELECT date, payment_processor AS pp, COALESCE(country, 'null') AS country,
      SUM(new_subscriptions_sales + refunds_total_amount_sale_date + renewals_sales + renewals_sales_yearly_ios + other_sales) AS gross,
      SUM(refunds_total_amount_refund_date) AS refunds
    FROM kpi_daily
    WHERE date BETWEEN p_start - 6 AND p_end AND payment_processor IN ('apple', 'google', 'stripe')
    GROUP BY 1, 2, 3
  ),
  st AS (
    SELECT date, store AS pp, country, paid_usd, net_usd, refunds_paid_usd, refunds_net_usd, status
    FROM store_daily WHERE date BETWEEN p_start - 6 AND p_end
  ),
  store_days AS (SELECT DISTINCT date, pp FROM st),
  days AS (SELECT d::date AS date FROM generate_series(p_start, p_end, interval '1 day') d),
  -- ventana de 7 días que termina en cada día, solo días con reporte de tienda (ambos lados)
  w_country AS (
    SELECT dd.date, x.pp, x.country,
      SUM(x.gross) AS bq_gross, SUM(x.refunds) AS bq_ref,
      SUM(x.s_paid) AS s_paid, SUM(x.s_net) AS s_net, SUM(x.s_rp) AS s_rp, SUM(x.s_rn) AS s_rn
    FROM days dd
    JOIN (
      SELECT COALESCE(b.date, s.date) AS date, COALESCE(b.pp, s.pp) AS pp, COALESCE(b.country, s.country) AS country,
        COALESCE(b.gross, 0) AS gross, COALESCE(b.refunds, 0) AS refunds,
        COALESCE(s.paid_usd, 0) AS s_paid, COALESCE(s.net_usd, 0) AS s_net, COALESCE(s.refunds_paid_usd, 0) AS s_rp, COALESCE(s.refunds_net_usd, 0) AS s_rn
      FROM bq b FULL JOIN st s ON s.date = b.date AND s.pp = b.pp AND s.country = b.country
    ) x ON x.date BETWEEN dd.date - 6 AND dd.date
    JOIN store_days sd ON sd.date = x.date AND sd.pp = x.pp
    GROUP BY 1, 2, 3
  ),
  w_pp AS (
    SELECT date, pp, SUM(bq_gross) AS bq_gross, SUM(bq_ref) AS bq_ref, SUM(s_paid) AS s_paid, SUM(s_net) AS s_net, SUM(s_rp) AS s_rp, SUM(s_rn) AS s_rn
    FROM w_country GROUP BY 1, 2
  ),
  cells AS (SELECT DISTINCT date, pp, country FROM bq WHERE date BETWEEN p_start AND p_end)
  INSERT INTO kpi_calibration (date, payment_processor, country, k_gross, k_net, k_ref_gross, k_ref_net, level, status)
  SELECT c.date, c.pp, c.country,
    CASE WHEN wc.bq_gross >= 50 AND wc.s_paid > 0 THEN wc.s_paid / wc.bq_gross ELSE wp.s_paid / NULLIF(wp.bq_gross, 0) END,
    CASE WHEN wc.bq_gross >= 50 AND wc.s_paid > 0 THEN wc.s_net / wc.bq_gross ELSE wp.s_net / NULLIF(wp.bq_gross, 0) END,
    CASE WHEN wc.bq_ref >= 50 AND wc.s_rp > 0 THEN wc.s_rp / wc.bq_ref WHEN wp.bq_ref >= 50 AND wp.s_rp > 0 THEN wp.s_rp / wp.bq_ref ELSE NULL END,
    CASE WHEN wc.bq_ref >= 50 AND wc.s_rp > 0 THEN wc.s_rn / wc.bq_ref WHEN wp.bq_ref >= 50 AND wp.s_rp > 0 THEN wp.s_rn / wp.bq_ref ELSE NULL END,
    CASE WHEN wc.bq_gross >= 50 AND wc.s_paid > 0 THEN 'pais' ELSE 'procesador' END,
    CASE WHEN EXISTS (SELECT 1 FROM st s WHERE s.date = c.date AND s.pp = c.pp AND s.status = 'final') THEN 'real' ELSE 'estimado' END
  FROM cells c
  JOIN w_pp wp ON wp.date = c.date AND wp.pp = c.pp AND wp.bq_gross > 0
  LEFT JOIN w_country wc ON wc.date = c.date AND wc.pp = c.pp AND wc.country = c.country;
  GET DIAGNOSTICS n = ROW_COUNT;
  -- Reembolsos sin ventana suficiente: misma base que las ventas (k_gross / k_net) para no mezclar tasas.
  UPDATE kpi_calibration SET k_ref_gross = k_gross, k_ref_net = k_net
  WHERE date BETWEEN p_start AND p_end AND k_ref_gross IS NULL;
  RETURN n;
END
$fn$;

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
  (CASE WHEN k.payment_processor = 'stripe' THEN k.renewals_sales_yearly_ios ELSE 0 END)::numeric AS stripe_yr_sales,
  (CASE WHEN c.k_gross IS NOT NULL THEN (k.new_subscriptions_sales + k.refunds_total_amount_sale_date + k.renewals_sales + k.renewals_sales_yearly_ios + k.other_sales) * c.k_gross ELSE (k.new_subscriptions_sales + k.refunds_total_amount_sale_date + k.renewals_sales + k.renewals_sales_yearly_ios + k.other_sales) END)::numeric AS cal_gross,
  (CASE WHEN c.k_gross IS NOT NULL THEN (k.new_subscriptions_sales + k.refunds_total_amount_sale_date) * c.k_gross ELSE (k.new_subscriptions_sales + k.refunds_total_amount_sale_date) END)::numeric AS cal_ns,
  (CASE WHEN c.k_gross IS NOT NULL THEN k.other_sales * c.k_gross ELSE k.other_sales END)::numeric AS cal_other,
  (CASE WHEN c.k_net IS NOT NULL THEN (k.new_subscriptions_sales + k.refunds_total_amount_sale_date + k.renewals_sales + k.renewals_sales_yearly_ios + k.other_sales) * c.k_net ELSE ((k.new_subscriptions_sales + k.refunds_total_amount_sale_date + k.renewals_sales) * (CASE WHEN k.payment_processor = 'stripe' THEN 0.965 WHEN k.os = 'iOS' THEN 0.64 WHEN k.os = 'Android' THEN 0.79 WHEN k.os IN ('Web','Unknown') THEN 0.98 ELSE 0.98 END) + k.renewals_sales_yearly_ios * (CASE WHEN k.payment_processor = 'stripe' THEN 0.965 ELSE 0.79 END) + k.other_sales * (CASE WHEN k.network = 'stripe' THEN 0.97 WHEN k.network = 'shopify' THEN 0.98 ELSE 0.98 END)) END)::numeric AS cal_net,
  (CASE WHEN c.k_ref_gross IS NOT NULL THEN k.refunds_total_amount_refund_date * c.k_ref_gross ELSE k.refunds_total_amount_refund_date END)::numeric AS cal_ref_gross,
  (CASE WHEN c.k_ref_net IS NOT NULL THEN k.refunds_total_amount_refund_date * c.k_ref_net ELSE k.refunds_total_amount_refund_date * (CASE WHEN (k.new_subscriptions_sales + k.refunds_total_amount_sale_date + k.renewals_sales + k.renewals_sales_yearly_ios + k.other_sales) > 0 THEN ((k.new_subscriptions_sales + k.refunds_total_amount_sale_date + k.renewals_sales) * (CASE WHEN k.payment_processor = 'stripe' THEN 0.965 WHEN k.os = 'iOS' THEN 0.64 WHEN k.os = 'Android' THEN 0.79 WHEN k.os IN ('Web','Unknown') THEN 0.98 ELSE 0.98 END) + k.renewals_sales_yearly_ios * (CASE WHEN k.payment_processor = 'stripe' THEN 0.965 ELSE 0.79 END) + k.other_sales * (CASE WHEN k.network = 'stripe' THEN 0.97 WHEN k.network = 'shopify' THEN 0.98 ELSE 0.98 END)) / (k.new_subscriptions_sales + k.refunds_total_amount_sale_date + k.renewals_sales + k.renewals_sales_yearly_ios + k.other_sales) ELSE (CASE WHEN k.payment_processor = 'stripe' THEN 0.965 WHEN k.os = 'iOS' THEN 0.64 WHEN k.os = 'Android' THEN 0.79 WHEN k.os IN ('Web','Unknown') THEN 0.98 ELSE 0.98 END) END) END)::numeric AS cal_ref_net,
  (CASE WHEN c.status = 'estimado' THEN (k.new_subscriptions_sales + k.refunds_total_amount_sale_date + k.renewals_sales + k.renewals_sales_yearly_ios + k.other_sales) ELSE 0 END)::numeric AS cal_est_gross,
  (CASE WHEN c.k_gross IS NULL THEN (k.new_subscriptions_sales + k.refunds_total_amount_sale_date + k.renewals_sales + k.renewals_sales_yearly_ios + k.other_sales) ELSE 0 END)::numeric AS cal_uncal_gross
FROM kpi_daily k
LEFT JOIN kpi_calibration c ON c.date = k.date AND c.payment_processor = k.payment_processor AND c.country = COALESCE(k.country, 'null');

ALTER TABLE kpi_rollup ADD COLUMN IF NOT EXISTS cal_gross numeric NOT NULL DEFAULT 0;
ALTER TABLE kpi_rollup ADD COLUMN IF NOT EXISTS cal_ns numeric NOT NULL DEFAULT 0;
ALTER TABLE kpi_rollup ADD COLUMN IF NOT EXISTS cal_other numeric NOT NULL DEFAULT 0;
ALTER TABLE kpi_rollup ADD COLUMN IF NOT EXISTS cal_net numeric NOT NULL DEFAULT 0;
ALTER TABLE kpi_rollup ADD COLUMN IF NOT EXISTS cal_ref_gross numeric NOT NULL DEFAULT 0;
ALTER TABLE kpi_rollup ADD COLUMN IF NOT EXISTS cal_ref_net numeric NOT NULL DEFAULT 0;
ALTER TABLE kpi_rollup ADD COLUMN IF NOT EXISTS cal_est_gross numeric NOT NULL DEFAULT 0;
ALTER TABLE kpi_rollup ADD COLUMN IF NOT EXISTS cal_uncal_gross numeric NOT NULL DEFAULT 0;

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
  INSERT INTO kpi_rollup (grain, period, kinedu_region, country, os, kinedu_language, signups, fts_started, fts_converted, downloads, spend, new_subscriptions, new_subscriptions_sales, renewals, renewals_sales, renewals_yearly_ios, renewals_sales_yearly_ios, other_sales, other_purchases, refunds_total_amount_refund_date, num_of_refunds_refund_date, refunds_total_amount_sale_date, num_of_refunds_sale_date, other_sales_stripe_net, other_sales_shopify_net, stripe_ns_sales, stripe_ren_sales, ios_ren, ios_ns, ios_rsd, ios_ren_s, ios_ns_s, ios_rsd_s, and_ren, and_ns, and_rsd, and_ren_s, and_ns_s, and_rsd_s, web_ren, web_ns, web_rsd, web_ren_s, web_ns_s, web_rsd_s, unk_ren, unk_ns, unk_rsd, unk_ren_s, unk_ns_s, unk_rsd_s, stripe_yr_sales, cal_gross, cal_ns, cal_other, cal_net, cal_ref_gross, cal_ref_net, cal_est_gross, cal_uncal_gross)
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
    SUM(b.stripe_yr_sales),
    SUM(b.cal_gross),
    SUM(b.cal_ns),
    SUM(b.cal_other),
    SUM(b.cal_net),
    SUM(b.cal_ref_gross),
    SUM(b.cal_ref_net),
    SUM(b.cal_est_gross),
    SUM(b.cal_uncal_gross)
  FROM v_kpi_daily_bucketed b WHERE b.date BETWEEN ws AND we
  GROUP BY 2, 3, 4, 5, 6;
  GET DIAGNOSTICS n1 = ROW_COUNT;

  DELETE FROM kpi_rollup WHERE grain = 'month' AND period BETWEEN ms AND me;
  INSERT INTO kpi_rollup (grain, period, kinedu_region, country, os, kinedu_language, signups, fts_started, fts_converted, downloads, spend, new_subscriptions, new_subscriptions_sales, renewals, renewals_sales, renewals_yearly_ios, renewals_sales_yearly_ios, other_sales, other_purchases, refunds_total_amount_refund_date, num_of_refunds_refund_date, refunds_total_amount_sale_date, num_of_refunds_sale_date, other_sales_stripe_net, other_sales_shopify_net, stripe_ns_sales, stripe_ren_sales, ios_ren, ios_ns, ios_rsd, ios_ren_s, ios_ns_s, ios_rsd_s, and_ren, and_ns, and_rsd, and_ren_s, and_ns_s, and_rsd_s, web_ren, web_ns, web_rsd, web_ren_s, web_ns_s, web_rsd_s, unk_ren, unk_ns, unk_rsd, unk_ren_s, unk_ns_s, unk_rsd_s, stripe_yr_sales, cal_gross, cal_ns, cal_other, cal_net, cal_ref_gross, cal_ref_net, cal_est_gross, cal_uncal_gross)
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
    SUM(b.stripe_yr_sales),
    SUM(b.cal_gross),
    SUM(b.cal_ns),
    SUM(b.cal_other),
    SUM(b.cal_net),
    SUM(b.cal_ref_gross),
    SUM(b.cal_ref_net),
    SUM(b.cal_est_gross),
    SUM(b.cal_uncal_gross)
  FROM v_kpi_daily_bucketed b WHERE b.date BETWEEN ms AND me
  GROUP BY 2, 3, 4, 5, 6;
  GET DIAGNOSTICS n2 = ROW_COUNT;

  RETURN QUERY SELECT ws, we, ms, me, n1 + n2;
END
$fn$;


-- La firma de salida cambia (columnas cal_*): borrar y recrear.
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
RETURNS TABLE (period date, grp text, signups numeric, fts_started numeric, fts_converted numeric, downloads numeric, spend numeric, new_subscriptions numeric, new_subscriptions_sales numeric, renewals numeric, renewals_sales numeric, renewals_yearly_ios numeric, renewals_sales_yearly_ios numeric, other_sales numeric, other_purchases numeric, refunds_total_amount_refund_date numeric, num_of_refunds_refund_date numeric, refunds_total_amount_sale_date numeric, num_of_refunds_sale_date numeric, other_sales_stripe_net numeric, other_sales_shopify_net numeric, stripe_ns_sales numeric, stripe_ren_sales numeric, ios_ren numeric, ios_ns numeric, ios_rsd numeric, ios_ren_s numeric, ios_ns_s numeric, ios_rsd_s numeric, and_ren numeric, and_ns numeric, and_rsd numeric, and_ren_s numeric, and_ns_s numeric, and_rsd_s numeric, web_ren numeric, web_ns numeric, web_rsd numeric, web_ren_s numeric, web_ns_s numeric, web_rsd_s numeric, unk_ren numeric, unk_ns numeric, unk_rsd numeric, unk_ren_s numeric, unk_ns_s numeric, unk_rsd_s numeric, stripe_yr_sales numeric, cal_gross numeric, cal_ns numeric, cal_other numeric, cal_net numeric, cal_ref_gross numeric, cal_ref_net numeric, cal_est_gross numeric, cal_uncal_gross numeric)
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
           r.signups, r.fts_started, r.fts_converted, r.downloads, r.spend, r.new_subscriptions, r.new_subscriptions_sales, r.renewals, r.renewals_sales, r.renewals_yearly_ios, r.renewals_sales_yearly_ios, r.other_sales, r.other_purchases, r.refunds_total_amount_refund_date, r.num_of_refunds_refund_date, r.refunds_total_amount_sale_date, r.num_of_refunds_sale_date, r.other_sales_stripe_net, r.other_sales_shopify_net, r.stripe_ns_sales, r.stripe_ren_sales, r.ios_ren, r.ios_ns, r.ios_rsd, r.ios_ren_s, r.ios_ns_s, r.ios_rsd_s, r.and_ren, r.and_ns, r.and_rsd, r.and_ren_s, r.and_ns_s, r.and_rsd_s, r.web_ren, r.web_ns, r.web_rsd, r.web_ren_s, r.web_ns_s, r.web_rsd_s, r.unk_ren, r.unk_ns, r.unk_rsd, r.unk_ren_s, r.unk_ns_s, r.unk_rsd_s, r.stripe_yr_sales, r.cal_gross, r.cal_ns, r.cal_other, r.cal_net, r.cal_ref_gross, r.cal_ref_net, r.cal_est_gross, r.cal_uncal_gross
    FROM kpi_rollup r
    WHERE c_lo IS NOT NULL
      AND r.grain = CASE WHEN use_week THEN 'week' ELSE 'month' END
      AND r.period >= c_lo AND r.period < c_hi
    UNION ALL
    SELECT b.date, b.kinedu_region, b.country, b.os, b.kinedu_language, b.network, b.payment_processor, b.plan_type,
           b.signups, b.fts_started, b.fts_converted, b.downloads, b.spend, b.new_subscriptions, b.new_subscriptions_sales, b.renewals, b.renewals_sales, b.renewals_yearly_ios, b.renewals_sales_yearly_ios, b.other_sales, b.other_purchases, b.refunds_total_amount_refund_date, b.num_of_refunds_refund_date, b.refunds_total_amount_sale_date, b.num_of_refunds_sale_date, b.other_sales_stripe_net, b.other_sales_shopify_net, b.stripe_ns_sales, b.stripe_ren_sales, b.ios_ren, b.ios_ns, b.ios_rsd, b.ios_ren_s, b.ios_ns_s, b.ios_rsd_s, b.and_ren, b.and_ns, b.and_rsd, b.and_ren_s, b.and_ns_s, b.and_rsd_s, b.web_ren, b.web_ns, b.web_rsd, b.web_ren_s, b.web_ns_s, b.web_rsd_s, b.unk_ren, b.unk_ns, b.unk_rsd, b.unk_ren_s, b.unk_ns_s, b.unk_rsd_s, b.stripe_yr_sales, b.cal_gross, b.cal_ns, b.cal_other, b.cal_net, b.cal_ref_gross, b.cal_ref_net, b.cal_est_gross, b.cal_uncal_gross
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
    SUM(s.stripe_yr_sales),
    SUM(s.cal_gross),
    SUM(s.cal_ns),
    SUM(s.cal_other),
    SUM(s.cal_net),
    SUM(s.cal_ref_gross),
    SUM(s.cal_ref_net),
    SUM(s.cal_est_gross),
    SUM(s.cal_uncal_gross)
  FROM src s
  WHERE (p_region  IS NULL OR s.kinedu_region   = ANY(p_region))
    AND (p_country IS NULL OR s.country         = ANY(p_country))
    AND (p_os      IS NULL OR s.os              = ANY(p_os))
    AND (p_lang    IS NULL OR s.kinedu_language = ANY(p_lang))
  GROUP BY 1, 2
  ORDER BY 1, 2;
END
$fn$;

-- El cambio atómico ahora también recalcula los factores de calibración (dependen del lado BigQuery)
-- y el rollup, en la misma transacción. La ventana de 7 días hace que el rango afecte hasta 6 días después.
CREATE OR REPLACE FUNCTION kpi_daily_swap(p_run_id text, p_start date, p_end date)
RETURNS bigint
LANGUAGE plpgsql AS $fn$
DECLARE n bigint;
BEGIN
  DELETE FROM kpi_daily WHERE date BETWEEN p_start AND p_end;
  INSERT INTO kpi_daily (date, dim_key, os, network, country, kinedu_language, product, plan_type, payment_processor, kinedu_region, signups, fts_started, fts_converted, impressions, clicks, downloads, spend, total_spend_retargeting, signups_retargeting, new_subscriptions, new_subscriptions_sales, renewals, renewals_sales, renewals_yearly_ios, renewals_sales_yearly_ios, other_sales, other_purchases, refunds_total_amount_refund_date, num_of_refunds_refund_date, refunds_total_amount_sale_date, num_of_refunds_sale_date, refunds_total_amount_refund_date_ft_conv, num_of_refunds_refund_date_ft_conv, refunds_total_amount_sale_date_ft_conv, num_of_refunds_sale_date_ft_conv, synced_at)
  SELECT date, dim_key, os, network, country, kinedu_language, product, plan_type, payment_processor, kinedu_region, signups, fts_started, fts_converted, impressions, clicks, downloads, spend, total_spend_retargeting, signups_retargeting, new_subscriptions, new_subscriptions_sales, renewals, renewals_sales, renewals_yearly_ios, renewals_sales_yearly_ios, other_sales, other_purchases, refunds_total_amount_refund_date, num_of_refunds_refund_date, refunds_total_amount_sale_date, num_of_refunds_sale_date, refunds_total_amount_refund_date_ft_conv, num_of_refunds_refund_date_ft_conv, refunds_total_amount_sale_date_ft_conv, num_of_refunds_sale_date_ft_conv, synced_at FROM kpi_daily_stage WHERE run_id = p_run_id AND date BETWEEN p_start AND p_end;
  GET DIAGNOSTICS n = ROW_COUNT;
  DELETE FROM kpi_daily_stage WHERE run_id = p_run_id AND date BETWEEN p_start AND p_end;
  PERFORM refresh_kpi_calibration(p_start, LEAST(p_end + 6, CURRENT_DATE + 1));
  PERFORM refresh_kpi_rollup(p_start, LEAST(p_end + 6, CURRENT_DATE + 1));
  RETURN n;
END
$fn$;

-- Tras actualizar store_daily: recalcula factores y rollup del rango (+6 días por la ventana).
CREATE OR REPLACE FUNCTION refresh_store_calibration(p_start date, p_end date)
RETURNS bigint
LANGUAGE plpgsql AS $fn$
DECLARE n bigint;
BEGIN
  n := refresh_kpi_calibration(p_start, LEAST(p_end + 6, CURRENT_DATE + 1));
  PERFORM refresh_kpi_rollup(p_start, LEAST(p_end + 6, CURRENT_DATE + 1));
  RETURN n;
END
$fn$;

-- Cobertura por tienda y día (para marcar en el dashboard qué días del Corregido son estimados).
-- status por día: 'final' si todos los países del día son final, 'estimado' si alguno es estimado.
CREATE OR REPLACE FUNCTION store_coverage(p_from date)
RETURNS TABLE (store text, date date, status text, net_usd numeric)
LANGUAGE sql STABLE AS $fn$
  SELECT store, date, CASE WHEN bool_or(status = 'estimado') THEN 'estimado' ELSE 'final' END, SUM(net_usd)
  FROM store_daily WHERE date >= p_from GROUP BY store, date ORDER BY store, date;
$fn$;

-- Guardia de KPIs (lib/audit/kpi-guard.ts): cada corrida del auditor automático con el resultado de cada
-- chequeo. Sirve para alarmas (solo avisa cuando algo cambia de estado) y para el panel de Auditoría.
CREATE TABLE IF NOT EXISTS kpi_guard_runs (
  id          BIGSERIAL PRIMARY KEY,
  ran_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status      TEXT NOT NULL CHECK (status IN ('ok', 'warn', 'alarm')),
  checks      JSONB NOT NULL,          -- [{ id, area, status, line, detail }]
  alerted     BOOLEAN NOT NULL DEFAULT FALSE,
  seconds     NUMERIC
);
CREATE INDEX IF NOT EXISTS kpi_guard_runs_ran_at_idx ON kpi_guard_runs (ran_at DESC);
COMMENT ON TABLE kpi_guard_runs IS 'Corridas del auditor automático de KPIs (cron /api/cron/kpi-guard).';
