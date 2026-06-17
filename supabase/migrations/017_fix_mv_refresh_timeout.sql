-- ============================================================================
-- 017_fix_mv_refresh_timeout.sql
--
-- Fix: refresh_apple_refund_mvs() was timing out when called via PostgREST
-- (default statement_timeout is ~8s). REFRESH MATERIALIZED VIEW CONCURRENTLY
-- on ~310k rows needs ~30–60s.
--
-- Fix: set LOCAL statement_timeout = '5 minutes' inside the function so it
-- overrides the connection-level default for this transaction only.
-- ============================================================================

CREATE OR REPLACE FUNCTION refresh_apple_refund_mvs()
RETURNS VOID AS $$
BEGIN
  SET LOCAL statement_timeout = '5min';
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_apple_refunds_by_cpp_daily;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_apple_refunds_by_sku_daily;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_apple_refunds_by_country_daily;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_apple_refunds_by_duration_daily;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_apple_refunds_by_offer_daily;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION refresh_apple_refund_mvs() TO service_role;
