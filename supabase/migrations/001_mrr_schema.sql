-- ============================================
-- MRR DASHBOARD SCHEMA
-- ============================================

-- 1. RAW TRANSACTIONS (normalized from all 3 sources)
CREATE TABLE IF NOT EXISTS transactions (
  id              BIGSERIAL PRIMARY KEY,
  source          TEXT NOT NULL CHECK (source IN ('apple', 'google', 'stripe')),
  transaction_date DATE NOT NULL,

  order_id        TEXT,
  external_id     TEXT,

  sku             TEXT,
  plan_type       TEXT,
  plan_name       TEXT,

  transaction_type TEXT NOT NULL CHECK (transaction_type IN (
    'charge', 'refund', 'commission', 'tax', 'dispute'
  )),

  is_new_subscription  BOOLEAN DEFAULT false,
  is_renewal           BOOLEAN DEFAULT false,
  is_trial_conversion  BOOLEAN DEFAULT false,
  subscription_period  TEXT,

  amount_gross    DECIMAL(12,2) NOT NULL DEFAULT 0,
  amount_net      DECIMAL(12,2) NOT NULL DEFAULT 0,
  commission_amount DECIMAL(12,2) DEFAULT 0,
  tax_amount      DECIMAL(12,2) DEFAULT 0,

  original_amount     DECIMAL(12,2),
  original_currency   CHAR(3),

  country_code    CHAR(2),
  region          TEXT,

  units           INTEGER DEFAULT 1,
  raw_data        JSONB,

  synced_at       TIMESTAMPTZ DEFAULT NOW(),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_dedup
  ON transactions(source, external_id)
  WHERE external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(transaction_date);
CREATE INDEX IF NOT EXISTS idx_transactions_source_date ON transactions(source, transaction_date);
CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(transaction_type);
CREATE INDEX IF NOT EXISTS idx_transactions_sku ON transactions(sku);
CREATE INDEX IF NOT EXISTS idx_transactions_region ON transactions(region);
CREATE INDEX IF NOT EXISTS idx_transactions_plan ON transactions(plan_type);


-- 2. DAILY MRR SNAPSHOTS (pre-computed)
CREATE TABLE IF NOT EXISTS mrr_daily_snapshots (
  id              BIGSERIAL PRIMARY KEY,
  snapshot_date   DATE NOT NULL,

  mrr_gross       DECIMAL(12,2) NOT NULL DEFAULT 0,
  mrr_net         DECIMAL(12,2) NOT NULL DEFAULT 0,
  total_commissions DECIMAL(12,2) DEFAULT 0,
  total_taxes     DECIMAL(12,2) DEFAULT 0,
  total_refunds   DECIMAL(12,2) DEFAULT 0,
  total_disputes  DECIMAL(12,2) DEFAULT 0,

  mrr_apple_gross   DECIMAL(12,2) DEFAULT 0,
  mrr_apple_net     DECIMAL(12,2) DEFAULT 0,
  mrr_google_gross  DECIMAL(12,2) DEFAULT 0,
  mrr_google_net    DECIMAL(12,2) DEFAULT 0,
  mrr_stripe_gross  DECIMAL(12,2) DEFAULT 0,
  mrr_stripe_net    DECIMAL(12,2) DEFAULT 0,

  mrr_us_canada     DECIMAL(12,2) DEFAULT 0,
  mrr_mexico        DECIMAL(12,2) DEFAULT 0,
  mrr_brazil        DECIMAL(12,2) DEFAULT 0,
  mrr_rest_of_world DECIMAL(12,2) DEFAULT 0,

  mrr_monthly       DECIMAL(12,2) DEFAULT 0,
  mrr_yearly        DECIMAL(12,2) DEFAULT 0,

  new_subscriptions     INTEGER DEFAULT 0,
  renewals              INTEGER DEFAULT 0,
  trial_conversions     INTEGER DEFAULT 0,
  refund_count          INTEGER DEFAULT 0,

  computed_at     TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_snapshots_date ON mrr_daily_snapshots(snapshot_date);


-- 3. SKU MAPPINGS
CREATE TABLE IF NOT EXISTS sku_mappings (
  id              SERIAL PRIMARY KEY,
  source          TEXT NOT NULL CHECK (source IN ('apple', 'google', 'stripe')),
  raw_sku         TEXT NOT NULL,
  plan_name       TEXT NOT NULL,
  plan_type       TEXT NOT NULL CHECK (plan_type IN ('monthly', 'yearly', 'weekly', 'other')),
  monthly_value   DECIMAL(12,2),
  is_active       BOOLEAN DEFAULT true,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(source, raw_sku)
);


-- 4. SYNC LOG
CREATE TABLE IF NOT EXISTS sync_log (
  id              BIGSERIAL PRIMARY KEY,
  source          TEXT NOT NULL CHECK (source IN ('apple', 'google', 'stripe', 'all')),
  sync_type       TEXT NOT NULL CHECK (sync_type IN ('daily', 'backfill', 'manual')),
  status          TEXT NOT NULL CHECK (status IN ('running', 'success', 'error')),
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,
  records_synced  INTEGER DEFAULT 0,
  date_range_start DATE,
  date_range_end   DATE,
  error_message   TEXT,
  details         JSONB
);

CREATE INDEX IF NOT EXISTS idx_sync_log_source ON sync_log(source, started_at DESC);


-- 5. REGION HELPER FUNCTION
CREATE OR REPLACE FUNCTION get_region(country CHAR(2))
RETURNS TEXT AS $$
BEGIN
  RETURN CASE
    WHEN country IN ('US', 'CA') THEN 'us_canada'
    WHEN country = 'MX' THEN 'mexico'
    WHEN country = 'BR' THEN 'brazil'
    ELSE 'rest_of_world'
  END;
END;
$$ LANGUAGE plpgsql IMMUTABLE;
