-- Add active_subscriptions column to track total active subs per month
-- This is the count of all charges whose subscription period covers the snapshot month
ALTER TABLE mrr_daily_snapshots
  ADD COLUMN IF NOT EXISTS active_subscriptions INTEGER DEFAULT 0;
