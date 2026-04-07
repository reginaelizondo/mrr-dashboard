-- ============================================================================
-- Apple SALES Report (DAILY) — calendar-aligned sales data with $ amounts.
-- This is what App Store Connect → Trends → Ventas displays. We need it
-- for the Refunds tab so the dollar-based refund rate matches App Store
-- Connect exactly (the existing Finance Reports use Apple's fiscal calendar
-- which is offset from calendar months).
-- Refunds appear as rows with negative `units` and negative `customer_price`.
-- ============================================================================

CREATE TABLE IF NOT EXISTS apple_sales_daily (
  id                       BIGSERIAL PRIMARY KEY,
  begin_date               DATE NOT NULL,
  end_date                 DATE NOT NULL,

  sku                      TEXT,
  title                    TEXT,
  product_type_identifier  TEXT,
  apple_identifier         TEXT,
  parent_identifier        TEXT,
  subscription             TEXT,
  period                   TEXT,

  units                    INTEGER NOT NULL DEFAULT 0,         -- negative = refund
  developer_proceeds       NUMERIC(14,4) NOT NULL DEFAULT 0,   -- per-unit, in proceeds currency
  customer_price           NUMERIC(14,4),                       -- per-unit, in customer currency

  customer_currency        CHAR(3),
  currency_of_proceeds     CHAR(3),
  country_code             CHAR(2),

  promo_code               TEXT,
  category                 TEXT,
  device                   TEXT,
  client                   TEXT,
  order_type               TEXT,
  proceeds_reason          TEXT,

  raw_data                 JSONB,
  synced_at                TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_apple_sales_daily_date    ON apple_sales_daily(begin_date);
CREATE INDEX IF NOT EXISTS idx_apple_sales_daily_sku     ON apple_sales_daily(sku);
CREATE INDEX IF NOT EXISTS idx_apple_sales_daily_country ON apple_sales_daily(country_code);
CREATE INDEX IF NOT EXISTS idx_apple_sales_daily_units   ON apple_sales_daily(units);


-- ----------------------------------------------------------------------------
-- USD conversion helper. Apple sales data is in customer currency. We use
-- the SAME monthly FX-rate map that lib/sync/apple.ts uses for the
-- transactions table so the two are consistent.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS apple_fx_rates (
  year_month CHAR(7) NOT NULL,    -- YYYY-MM
  currency   CHAR(3) NOT NULL,    -- ISO code, e.g. MXN
  rate       NUMERIC(14,6) NOT NULL,  -- units of currency per 1 USD
  PRIMARY KEY (year_month, currency)
);

-- Seed common fallback rates (applies when no per-month override exists)
INSERT INTO apple_fx_rates (year_month, currency, rate) VALUES
  ('default','USD',1),     ('default','EUR',0.92),  ('default','GBP',0.79),
  ('default','CAD',1.36),  ('default','AUD',1.55),  ('default','JPY',150.0),
  ('default','CHF',0.88),  ('default','MXN',20.0),  ('default','BRL',5.0),
  ('default','CLP',930.0), ('default','COP',4200.0),('default','PEN',3.75),
  ('default','CNY',7.25),  ('default','HKD',7.82),  ('default','KRW',1330.0),
  ('default','INR',83.5),  ('default','IDR',15700.0),('default','MYR',4.7),
  ('default','PHP',56.0),  ('default','SGD',1.34),  ('default','THB',35.5),
  ('default','TWD',31.5),  ('default','VND',25000.0),('default','KZT',460.0),
  ('default','PKR',280.0), ('default','AED',3.67),  ('default','SAR',3.75),
  ('default','QAR',3.64),  ('default','ILS',3.65),  ('default','NGN',1500.0),
  ('default','TZS',2500.0),('default','ZAR',18.5),  ('default','EGP',50.0),
  ('default','SEK',10.5),  ('default','NOK',10.7),  ('default','DKK',6.88),
  ('default','PLN',4.05),  ('default','CZK',23.5),  ('default','HUF',370.0),
  ('default','RON',4.6),   ('default','TRY',32.0),  ('default','RUB',92.0),
  ('default','NZD',1.67),  ('default','BGN',1.8)
ON CONFLICT (year_month, currency) DO NOTHING;


-- Helper that returns USD-converted gross/refund amounts per row
CREATE OR REPLACE FUNCTION apple_sales_to_usd(amount NUMERIC, currency CHAR(3), ym CHAR(7))
RETURNS NUMERIC AS $$
DECLARE
  r NUMERIC;
BEGIN
  IF amount IS NULL OR amount = 0 THEN RETURN 0; END IF;
  IF currency = 'USD' THEN RETURN amount; END IF;

  SELECT rate INTO r FROM apple_fx_rates WHERE year_month = ym AND apple_fx_rates.currency = apple_sales_to_usd.currency;
  IF r IS NULL THEN
    SELECT rate INTO r FROM apple_fx_rates WHERE year_month = 'default' AND apple_fx_rates.currency = apple_sales_to_usd.currency;
  END IF;
  IF r IS NULL OR r = 0 THEN RETURN amount; END IF;
  RETURN amount / r;
END;
$$ LANGUAGE plpgsql IMMUTABLE;


-- ----------------------------------------------------------------------------
-- Calendar-month aggregate for the Refunds chart. Mirrors what App Store
-- Connect → Trends → Ventas shows.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_apple_sales_monthly AS
SELECT
  TO_CHAR(begin_date, 'YYYY-MM') AS month,
  SUM(CASE WHEN units > 0 THEN units ELSE 0 END)::BIGINT AS charge_units,
  SUM(CASE WHEN units < 0 THEN -units ELSE 0 END)::BIGINT AS refund_units,
  SUM(CASE WHEN units > 0
            THEN apple_sales_to_usd(customer_price * units, customer_currency, TO_CHAR(begin_date, 'YYYY-MM'))
            ELSE 0 END) AS charge_gross_usd,
  SUM(CASE WHEN units < 0
            THEN apple_sales_to_usd(-customer_price * units, customer_currency, TO_CHAR(begin_date, 'YYYY-MM'))
            ELSE 0 END) AS refund_gross_usd
FROM apple_sales_daily
WHERE product_type_identifier IN ('IAY','IAC','IAS','IA1','IA9')  -- subscriptions only
GROUP BY 1
ORDER BY 1;
