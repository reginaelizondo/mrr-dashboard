-- ============================================================================
-- Refunds tab: monthly aggregation for Google / Stripe via RPC.
--
-- The previous implementation (lib/refunds.ts → getGenericRefundsByMonth)
-- paginated the `transactions` table client-side, fetching up to 1000 rows
-- per page. For Stripe alone this can be 30k+ rows over 12 months, taking
-- 8-15s in cold cache. Pushing the aggregation into Postgres drops it to
-- <200ms by using the (source, transaction_date) composite predicate.
--
-- Sign convention: `transactions` stores BOTH units and amount_gross as
-- absolute values for charge rows. Refund rows from Apple use negative
-- values; rows from Google/Stripe use positive. Match the original JS code
-- (Math.abs everywhere) so totals are identical.
-- ============================================================================

CREATE OR REPLACE FUNCTION transactions_refunds_monthly_range(
  src         TEXT,
  start_month TEXT,   -- YYYY-MM (inclusive)
  end_month   TEXT    -- YYYY-MM (inclusive)
)
RETURNS TABLE (
  month         TEXT,
  charge_units  BIGINT,
  refund_units  BIGINT,
  charge_gross  NUMERIC,
  refund_gross  NUMERIC
)
LANGUAGE SQL STABLE AS $$
  SELECT
    TO_CHAR(transaction_date, 'YYYY-MM') AS month,
    SUM(CASE WHEN transaction_type = 'charge'
              THEN ABS(COALESCE(units, 0)) ELSE 0 END)::BIGINT AS charge_units,
    SUM(CASE WHEN transaction_type = 'refund'
              THEN ABS(COALESCE(units, 0)) ELSE 0 END)::BIGINT AS refund_units,
    SUM(CASE WHEN transaction_type = 'charge'
              THEN ABS(COALESCE(amount_gross, 0)) ELSE 0 END) AS charge_gross,
    SUM(CASE WHEN transaction_type = 'refund'
              THEN ABS(COALESCE(amount_gross, 0)) ELSE 0 END) AS refund_gross
  FROM transactions
  WHERE source = src
    AND transaction_type IN ('charge', 'refund')
    AND transaction_date >= (start_month || '-01')::DATE
    AND transaction_date <  ((end_month   || '-01')::DATE + INTERVAL '1 month')
  GROUP BY 1
  ORDER BY 1;
$$;

-- Index that backs the predicate above. (Already implicit if (source,
-- transaction_date) composite exists; this is a safety net — IF NOT EXISTS
-- makes it a no-op when the index is already present.)
CREATE INDEX IF NOT EXISTS idx_transactions_source_date_type
  ON transactions (source, transaction_date, transaction_type);
