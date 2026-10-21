-- 039: kpi_intraday_snapshot — fotos del cumulado del día EN CURSO a distintas horas de corte.
--
-- Para qué: el estimado de cierre del Operativo ("Hoy") proyecta el día, pero a grano diario no
-- sabemos qué fracción de un día típico ya aterrizó a cada hora (el tráfico de Kinedu es global, no
-- uniforme: temprano en MX ya pasó la mañana de Asia/Europa). Guardando una foto del cumulado cada
-- vez que la réplica se sincroniza, en ~2–3 semanas tendremos, por día de semana y hora, la curva
-- "share del día típico realizado a la hora H". Con eso el estimado deja de asumir reparto uniforme.
--
-- La escribe el cron /api/cron/kpi-daily tras cada sync (lib/sync/intraday-snapshot.ts). Solo se
-- acumula; nunca se edita a mano. El estimado la empezará a usar cuando haya suficientes muestras.

CREATE TABLE IF NOT EXISTS kpi_intraday_snapshot (
  id                        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  day                       DATE        NOT NULL,          -- día MX en curso al momento de la foto
  weekday                   SMALLINT    NOT NULL,          -- 0=lunes … 6=domingo (ISO)
  cutoff_at                 TIMESTAMPTZ NOT NULL,          -- frescura del dato (hora de corte del sync)
  mx_hour                   NUMERIC     NOT NULL,          -- horas del día MX transcurridas al corte (0–24)
  fraction                  NUMERIC     NOT NULL,          -- mx_hour / 24
  -- Cumulado del día al corte (lo que la foto captura). Escalares de acceso rápido + agg completo
  -- (AggRow en JSONB) para poder derivar después Net Sales, Total Contribution y márgenes por hora.
  signups                   BIGINT      NOT NULL DEFAULT 0,
  new_subscriptions         BIGINT      NOT NULL DEFAULT 0,
  new_subscriptions_sales   NUMERIC     NOT NULL DEFAULT 0,
  spend                     NUMERIC     NOT NULL DEFAULT 0,
  agg                       JSONB       NOT NULL,
  captured_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (day, cutoff_at)                                  -- una foto por frescura de dato (dedup de reintentos)
);

CREATE INDEX IF NOT EXISTS kpi_intraday_snapshot_wd_hour_idx ON kpi_intraday_snapshot (weekday, mx_hour);
CREATE INDEX IF NOT EXISTS kpi_intraday_snapshot_day_idx      ON kpi_intraday_snapshot (day);

COMMENT ON TABLE kpi_intraday_snapshot IS 'Fotos del cumulado del día en curso a distintas horas de corte, para aprender la curva intradía y calibrar el estimado de cierre del Operativo. La escribe el cron kpi-daily tras cada sync.';
