-- 038: calibración que cuadra exacto con cada tienda.
--
-- La Guardia (2026-10-16) encontró el Corregido de Google +9.9 % y el de Stripe +3.3 % sobre lo que reportaron
-- las tiendas en 4 semanas. Causa: parte de las ventas de tienda no traen país exacto ('EU' o vacío en Google;
-- reembolsos de Stripe) y los países de BigQuery sin pareja caían al factor PROMEDIO del procesador.
-- Ahora: (1) esos países usan el factor del residuo (tienda − emparejado) / (BigQuery − emparejado) y
-- (2) un ajuste final por día × procesador hace que la ventana de 7 días calibrada sume exacto lo que
-- reportó la tienda. Los reembolsos usan el factor del procesador (casi nunca traen país).
-- Después de correrla: npx tsx scripts/backfill-store-daily.ts --recalibrate --from 2024-01-01 --to <hoy>

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
  -- Celdas emparejadas país a país (≥ $50 de BigQuery y la tienda reporta ese país en la ventana).
  w_pp AS (
    SELECT date, pp,
      SUM(bq_gross) AS bq_gross, SUM(bq_ref) AS bq_ref, SUM(s_paid) AS s_paid, SUM(s_net) AS s_net, SUM(s_rp) AS s_rp, SUM(s_rn) AS s_rn,
      SUM(CASE WHEN bq_gross >= 50 AND s_paid > 0 THEN bq_gross ELSE 0 END) AS bq_m,
      SUM(CASE WHEN bq_gross >= 50 AND s_paid > 0 THEN s_paid ELSE 0 END) AS s_paid_m,
      SUM(CASE WHEN bq_gross >= 50 AND s_paid > 0 THEN s_net ELSE 0 END) AS s_net_m
    FROM w_country GROUP BY 1, 2
  ),
  -- Países sin emparejar (ventas de tienda sin país exacto, p. ej. 'EU' o vacío en Google, reembolsos de
  -- Stripe): usan el factor del RESIDUO (tienda − emparejado) / (BigQuery − emparejado), no el promedio.
  k0 AS (
    SELECT wc.date, wc.pp, wc.country, wc.bq_gross AS bq_w,
      CASE WHEN wc.bq_gross >= 50 AND wc.s_paid > 0 THEN wc.s_paid / wc.bq_gross
           WHEN wp.bq_gross - wp.bq_m > 0 AND wp.s_paid - wp.s_paid_m > 0 THEN (wp.s_paid - wp.s_paid_m) / (wp.bq_gross - wp.bq_m)
           ELSE wp.s_paid / NULLIF(wp.bq_gross, 0) END AS kg,
      CASE WHEN wc.bq_gross >= 50 AND wc.s_paid > 0 THEN wc.s_net / wc.bq_gross
           WHEN wp.bq_gross - wp.bq_m > 0 AND wp.s_net - wp.s_net_m > 0 THEN (wp.s_net - wp.s_net_m) / (wp.bq_gross - wp.bq_m)
           ELSE wp.s_net / NULLIF(wp.bq_gross, 0) END AS kn,
      CASE WHEN wc.bq_gross >= 50 AND wc.s_paid > 0 THEN 'pais' ELSE 'procesador' END AS level
    FROM w_country wc JOIN w_pp wp ON wp.date = wc.date AND wp.pp = wc.pp
    WHERE wp.bq_gross > 0 AND wc.bq_gross > 0
  ),
  -- Ajuste final por (día, procesador): la ventana calibrada suma EXACTO lo que reportó la tienda.
  scale AS (
    SELECT k0.date, k0.pp,
      wp.s_paid / NULLIF(SUM(k0.bq_w * k0.kg), 0) AS sg,
      wp.s_net / NULLIF(SUM(k0.bq_w * k0.kn), 0) AS sn
    FROM k0 JOIN w_pp wp ON wp.date = k0.date AND wp.pp = k0.pp
    GROUP BY k0.date, k0.pp, wp.s_paid, wp.s_net
  ),
  cells AS (SELECT DISTINCT date, pp, country FROM bq WHERE date BETWEEN p_start AND p_end)
  INSERT INTO kpi_calibration (date, payment_processor, country, k_gross, k_net, k_ref_gross, k_ref_net, level, status)
  SELECT c.date, c.pp, c.country,
    COALESCE(k0.kg, wp.s_paid / NULLIF(wp.bq_gross, 0)) * COALESCE(sc.sg, 1),
    COALESCE(k0.kn, wp.s_net / NULLIF(wp.bq_gross, 0)) * COALESCE(sc.sn, 1),
    CASE WHEN wp.bq_ref >= 50 AND wp.s_rp > 0 THEN wp.s_rp / wp.bq_ref ELSE NULL END,
    CASE WHEN wp.bq_ref >= 50 AND wp.s_rp > 0 THEN wp.s_rn / wp.bq_ref ELSE NULL END,
    COALESCE(k0.level, 'procesador'),
    CASE WHEN EXISTS (SELECT 1 FROM st s WHERE s.date = c.date AND s.pp = c.pp AND s.status = 'final') THEN 'real' ELSE 'estimado' END
  FROM cells c
  JOIN w_pp wp ON wp.date = c.date AND wp.pp = c.pp AND wp.bq_gross > 0
  LEFT JOIN k0 ON k0.date = c.date AND k0.pp = c.pp AND k0.country = c.country
  LEFT JOIN scale sc ON sc.date = c.date AND sc.pp = c.pp;
  GET DIAGNOSTICS n = ROW_COUNT;
  -- Reembolsos sin ventana suficiente: misma base que las ventas (k_gross / k_net) para no mezclar tasas.
  UPDATE kpi_calibration SET k_ref_gross = k_gross, k_ref_net = k_net
  WHERE date BETWEEN p_start AND p_end AND k_ref_gross IS NULL;
  RETURN n;
END
$fn$;
