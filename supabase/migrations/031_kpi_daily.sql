-- 031: kpi_daily — réplica diaria de celtic-music-240111.dbt_prod_analytics.an_operational_dash
-- (la tabla que alimenta Looker). Un renglón por date × dimensiones, con los campos base;
-- los KPIs (CAC, ARPU, Net Sales, Total Contribution…) se calculan sobre las sumas filtradas
-- con las mismas fórmulas de lib/kpi/formulas.ts. Se refresca cada mañana después de dbt
-- (cron /api/cron/kpi-daily, ventana móvil de 21 días) y se backfillea con
-- scripts/backfill-kpi-daily.ts. Solo lectura para el dashboard; nunca se edita a mano.

CREATE TABLE IF NOT EXISTS kpi_daily (
  date                                        DATE NOT NULL,
  dim_key                                     TEXT NOT NULL,            -- md5 de las dimensiones (NULL → '')
  os                                          TEXT,
  network                                     TEXT,
  country                                     TEXT,
  kinedu_language                             TEXT,
  product                                     TEXT,
  plan_type                                   TEXT,
  payment_processor                           TEXT,
  kinedu_region                               TEXT,
  signups                                     BIGINT  NOT NULL DEFAULT 0,
  fts_started                                 BIGINT  NOT NULL DEFAULT 0,
  fts_converted                               BIGINT  NOT NULL DEFAULT 0,
  impressions                                 NUMERIC NOT NULL DEFAULT 0,
  clicks                                      NUMERIC NOT NULL DEFAULT 0,
  downloads                                   BIGINT  NOT NULL DEFAULT 0,
  spend                                       NUMERIC NOT NULL DEFAULT 0,
  total_spend_retargeting                     NUMERIC NOT NULL DEFAULT 0,
  signups_retargeting                         BIGINT  NOT NULL DEFAULT 0,
  new_subscriptions                           BIGINT  NOT NULL DEFAULT 0,
  new_subscriptions_sales                     NUMERIC NOT NULL DEFAULT 0,
  renewals                                    BIGINT  NOT NULL DEFAULT 0,
  renewals_sales                              NUMERIC NOT NULL DEFAULT 0,
  renewals_yearly_ios                         BIGINT  NOT NULL DEFAULT 0,
  renewals_sales_yearly_ios                   NUMERIC NOT NULL DEFAULT 0,
  other_sales                                 NUMERIC NOT NULL DEFAULT 0,
  other_purchases                             BIGINT  NOT NULL DEFAULT 0,
  refunds_total_amount_refund_date            NUMERIC NOT NULL DEFAULT 0,
  num_of_refunds_refund_date                  BIGINT  NOT NULL DEFAULT 0,
  refunds_total_amount_sale_date              NUMERIC NOT NULL DEFAULT 0,
  num_of_refunds_sale_date                    BIGINT  NOT NULL DEFAULT 0,
  refunds_total_amount_refund_date_ft_conv    NUMERIC NOT NULL DEFAULT 0,
  num_of_refunds_refund_date_ft_conv          BIGINT  NOT NULL DEFAULT 0,
  refunds_total_amount_sale_date_ft_conv      NUMERIC NOT NULL DEFAULT 0,
  num_of_refunds_sale_date_ft_conv            BIGINT  NOT NULL DEFAULT 0,
  synced_at                                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (date, dim_key)
);

CREATE INDEX IF NOT EXISTS kpi_daily_date_idx        ON kpi_daily (date);
CREATE INDEX IF NOT EXISTS kpi_daily_date_os_idx     ON kpi_daily (date, os);
CREATE INDEX IF NOT EXISTS kpi_daily_date_country_idx ON kpi_daily (date, country);
CREATE INDEX IF NOT EXISTS kpi_daily_date_lang_idx   ON kpi_daily (date, kinedu_language);

COMMENT ON TABLE kpi_daily IS 'Réplica diaria de an_operational_dash (BigQuery). Fuente de la sección Operativo del dashboard. Fórmulas en lib/kpi/formulas.ts.';

-- Resumen por día para la auditoría réplica vs BigQuery (totales que deben coincidir al centavo).
CREATE OR REPLACE VIEW v_kpi_daily_totals AS
SELECT date,
  SUM(signups) AS signups, SUM(spend) AS spend, SUM(fts_started) AS fts_started, SUM(fts_converted) AS fts_converted,
  SUM(new_subscriptions) AS new_subscriptions, SUM(new_subscriptions_sales) AS new_subscriptions_sales,
  SUM(renewals_sales) AS renewals_sales, SUM(renewals_sales_yearly_ios) AS renewals_sales_yearly_ios,
  SUM(other_sales) AS other_sales, SUM(refunds_total_amount_refund_date) AS refunds_total_amount_refund_date,
  SUM(refunds_total_amount_sale_date) AS refunds_total_amount_sale_date, COUNT(*) AS rows_n, MAX(synced_at) AS synced_at
FROM kpi_daily GROUP BY date;
