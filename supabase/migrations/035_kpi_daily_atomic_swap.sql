-- 035: sync atómico de la réplica (sin ventanas de datos incompletos).
--
-- Antes el sync borraba un mes de kpi_daily y lo volvía a insertar en lotes: durante ~1 min quien
-- abría el dashboard veía el mes incompleto (visto 2026-10-15 con el sync de cada 30 min). Ahora:
--   1. el sync inserta las filas nuevas en kpi_daily_stage con un run_id (los lectores no las ven);
--   2. kpi_daily_swap(run_id, start, end) borra el rango, copia las filas del stage y recalcula
--      kpi_rollup para ese rango, TODO en una sola transacción.
-- Un lector ve siempre el mes viejo completo o el nuevo completo, nunca una mezcla.

CREATE TABLE IF NOT EXISTS kpi_daily_stage (LIKE kpi_daily INCLUDING DEFAULTS);
ALTER TABLE kpi_daily_stage ADD COLUMN IF NOT EXISTS run_id TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS kpi_daily_stage_run_idx ON kpi_daily_stage (run_id, date);
COMMENT ON TABLE kpi_daily_stage IS 'Área de paso del sync de kpi_daily (ver kpi_daily_swap). Se vacía sola.';

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
  PERFORM refresh_kpi_rollup(p_start, p_end);
  RETURN n;
END
$fn$;

-- Limpieza de corridas fallidas (filas de stage de más de un día).
CREATE OR REPLACE FUNCTION kpi_daily_stage_cleanup()
RETURNS bigint
LANGUAGE plpgsql AS $fn$
DECLARE n bigint;
BEGIN
  DELETE FROM kpi_daily_stage WHERE synced_at < NOW() - interval '1 day';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$fn$;
