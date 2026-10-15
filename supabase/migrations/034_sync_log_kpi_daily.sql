-- 034: sync_log acepta la fuente 'kpi_daily' (job diario de la réplica del Looker).
-- Sin esto el cron /api/cron/kpi-daily no podía registrar sus corridas (violaba sync_log_source_check)
-- y la auditoría diaria no veía el resultado de la verificación contra BigQuery.
ALTER TABLE sync_log DROP CONSTRAINT IF EXISTS sync_log_source_check;
ALTER TABLE sync_log ADD CONSTRAINT sync_log_source_check CHECK (source IN ('apple', 'google', 'stripe', 'all', 'kpi_daily'));
