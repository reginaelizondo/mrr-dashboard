-- Add new plan type columns to mrr_daily_snapshots
ALTER TABLE mrr_daily_snapshots
  ADD COLUMN IF NOT EXISTS mrr_semesterly DECIMAL(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS mrr_quarterly  DECIMAL(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS mrr_weekly     DECIMAL(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS mrr_lifetime   DECIMAL(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS mrr_other      DECIMAL(12,2) DEFAULT 0;

-- Update sku_mappings check constraint for plan_type to include new values
ALTER TABLE sku_mappings DROP CONSTRAINT IF EXISTS sku_mappings_plan_type_check;
ALTER TABLE sku_mappings ADD CONSTRAINT sku_mappings_plan_type_check
  CHECK (plan_type IN ('monthly', 'yearly', 'semesterly', 'quarterly', 'weekly', 'lifetime', 'other'));
