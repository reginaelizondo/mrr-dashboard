-- ============================================================================
-- Performance views for the Refunds dashboard.
-- The Apple events table has ~300k rows; reading them all client-side from
-- the JS SDK + paginating takes 60-120s per page render. These views push
-- the aggregation into Postgres so the dashboard fetches a few dozen rows.
-- ============================================================================

-- Helper expression: classify a SUBSCRIPTION_EVENT report row as
--   refund | paid | other (so the dashboard's denominator/numerator are stable)
CREATE OR REPLACE FUNCTION apple_event_class(event TEXT) RETURNS TEXT AS $$
  SELECT CASE
    WHEN event LIKE 'Refund%' THEN 'refund'
    WHEN event = 'Cancel' THEN 'other'
    WHEN event = 'Canceled from Billing Retry' THEN 'other'
    WHEN event = 'Start Introductory Offer' THEN 'other'
    WHEN event LIKE 'Billing Retry%' THEN 'other'
    ELSE 'paid'
  END;
$$ LANGUAGE SQL IMMUTABLE;


-- 1) Monthly aggregate for the refund-rate chart (Apple)
CREATE OR REPLACE VIEW v_apple_refund_monthly AS
SELECT
  TO_CHAR(event_date, 'YYYY-MM') AS month,
  SUM(CASE WHEN apple_event_class(event) = 'paid'   THEN quantity ELSE 0 END) AS charge_units,
  SUM(CASE WHEN apple_event_class(event) = 'refund' THEN quantity ELSE 0 END) AS refund_units
FROM apple_subscription_events
GROUP BY 1
ORDER BY 1;


-- 2) Charge $ per month (Apple), pulled from the Finance Report transactions
CREATE OR REPLACE VIEW v_apple_charge_gross_monthly AS
SELECT
  TO_CHAR(transaction_date, 'YYYY-MM') AS month,
  SUM(CASE WHEN transaction_type = 'charge' THEN amount_gross ELSE 0 END) AS charge_gross,
  SUM(CASE WHEN transaction_type = 'refund' THEN amount_gross ELSE 0 END) AS refund_gross
FROM transactions
WHERE source = 'apple'
GROUP BY 1
ORDER BY 1;


-- 3) Refund breakdowns (Apple, last 90 days, computed on demand)
-- These are functions instead of views so the 90-day window is parameterised.

CREATE OR REPLACE FUNCTION apple_refunds_by_cpp(days INT DEFAULT 90)
RETURNS TABLE(bucket TEXT, refunds BIGINT, paid_events BIGINT) AS $$
  SELECT
    CASE
      WHEN consecutive_paid_periods IS NULL THEN 'Unknown'
      WHEN consecutive_paid_periods <= 0 THEN '0 (initial)'
      WHEN consecutive_paid_periods = 1 THEN '1 (initial paid)'
      WHEN consecutive_paid_periods = 2 THEN '2 (1st renewal)'
      WHEN consecutive_paid_periods = 3 THEN '3 (2nd renewal)'
      WHEN consecutive_paid_periods = 4 THEN '4 (3rd renewal)'
      WHEN consecutive_paid_periods <= 6 THEN '5–6 renewals'
      WHEN consecutive_paid_periods <= 12 THEN '7–12 renewals'
      ELSE '13+ renewals'
    END AS bucket,
    SUM(CASE WHEN apple_event_class(event) = 'refund' THEN quantity ELSE 0 END)::BIGINT AS refunds,
    SUM(CASE WHEN apple_event_class(event) = 'paid'   THEN quantity ELSE 0 END)::BIGINT AS paid_events
  FROM apple_subscription_events
  WHERE event_date >= CURRENT_DATE - days
    AND apple_event_class(event) IN ('refund', 'paid')
  GROUP BY 1
  ORDER BY MIN(consecutive_paid_periods) NULLS LAST;
$$ LANGUAGE SQL STABLE;


CREATE OR REPLACE FUNCTION apple_refunds_by_days_to_refund(days INT DEFAULT 90)
RETURNS TABLE(bucket TEXT, refunds BIGINT) AS $$
  WITH r AS (
    SELECT
      CASE
        WHEN original_start_date IS NULL THEN NULL
        ELSE (event_date - original_start_date)
      END AS d,
      quantity
    FROM apple_subscription_events
    WHERE event LIKE 'Refund%'
      AND event_date >= CURRENT_DATE - days
  )
  SELECT
    CASE
      WHEN d IS NULL THEN 'Unknown'
      WHEN d <= 1 THEN '0–1 days'
      WHEN d <= 7 THEN '2–7 days'
      WHEN d <= 30 THEN '8–30 days'
      WHEN d <= 90 THEN '31–90 days'
      ELSE '90+ days'
    END AS bucket,
    SUM(quantity)::BIGINT AS refunds
  FROM r
  GROUP BY 1
  ORDER BY MIN(d) NULLS LAST;
$$ LANGUAGE SQL STABLE;


CREATE OR REPLACE FUNCTION apple_refunds_by_dimension(dim TEXT, days INT DEFAULT 90, top_n INT DEFAULT 15)
RETURNS TABLE(bucket TEXT, refunds BIGINT, paid_events BIGINT) AS $$
  SELECT
    COALESCE(NULLIF(TRIM(
      CASE dim
        WHEN 'sku'      THEN subscription_name
        WHEN 'country'  THEN country
        WHEN 'duration' THEN standard_subscription_duration
        WHEN 'offer'    THEN subscription_offer_type
        ELSE NULL
      END
    ), ''), '(unknown)') AS bucket,
    SUM(CASE WHEN apple_event_class(event) = 'refund' THEN quantity ELSE 0 END)::BIGINT AS refunds,
    SUM(CASE WHEN apple_event_class(event) = 'paid'   THEN quantity ELSE 0 END)::BIGINT AS paid_events
  FROM apple_subscription_events
  WHERE event_date >= CURRENT_DATE - days
    AND apple_event_class(event) IN ('refund', 'paid')
  GROUP BY 1
  ORDER BY refunds DESC
  LIMIT top_n;
$$ LANGUAGE SQL STABLE;
