-- Add cash basis MRR fields to mrr_daily_snapshots
-- Cash basis = only charges in THIS month, normalized to monthly rate
-- (no spreading across subscription period)

ALTER TABLE mrr_daily_snapshots
  ADD COLUMN IF NOT EXISTS mrr_cash_gross NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS mrr_cash_net NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS mrr_cash_apple_gross NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS mrr_cash_google_gross NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS mrr_cash_stripe_gross NUMERIC DEFAULT 0;
