-- ============================================
-- APPLE SUBSCRIPTION EVENT REPORTS
-- ============================================
-- Stores granular subscription event data from Apple's
-- SUBSCRIPTION_EVENT daily report. Used for refund segmentation by
-- consecutive paid periods, days-before-canceling, plan, country, etc.
-- Required for App Review Guideline 5.6.4 monitoring.

CREATE TABLE IF NOT EXISTS apple_subscription_events (
  id BIGSERIAL PRIMARY KEY,

  event_date DATE NOT NULL,
  event TEXT NOT NULL, -- 'Subscribe' | 'Renew' | 'Refund' | 'Cancel' | 'Reactivate' | ...

  app_apple_id TEXT,
  subscription_name TEXT,         -- our SKU equivalent
  subscription_apple_id TEXT,
  subscription_group_id TEXT,
  standard_subscription_duration TEXT, -- '1 Month', '1 Year', etc.

  promotional_offer_name TEXT,
  promotional_offer_id TEXT,
  subscription_offer_type TEXT,   -- 'Free Trial' | 'Pay As You Go' | ...
  subscription_offer_duration TEXT,

  marketing_opt_in TEXT,
  preserved_pricing TEXT,
  proceeds_reason TEXT,

  consecutive_paid_periods INTEGER, -- 1 = initial paid, 2 = first renewal, ...
  original_start_date DATE,

  client TEXT,
  device TEXT,
  state TEXT,
  country CHAR(2),

  previous_subscription_name TEXT,
  previous_subscription_apple_id TEXT,

  days_before_canceling INTEGER, -- days from Original Start Date to event
  cancellation_reason TEXT,
  days_canceled INTEGER,

  quantity INTEGER NOT NULL DEFAULT 0,

  raw_data JSONB,
  synced_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ase_event_date ON apple_subscription_events(event_date);
CREATE INDEX IF NOT EXISTS idx_ase_event ON apple_subscription_events(event);
CREATE INDEX IF NOT EXISTS idx_ase_event_date_event ON apple_subscription_events(event_date, event);
CREATE INDEX IF NOT EXISTS idx_ase_subscription ON apple_subscription_events(subscription_apple_id);
CREATE INDEX IF NOT EXISTS idx_ase_country ON apple_subscription_events(country);
CREATE INDEX IF NOT EXISTS idx_ase_cpp ON apple_subscription_events(consecutive_paid_periods);
