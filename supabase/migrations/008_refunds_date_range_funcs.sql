-- ============================================================================
-- Refunds breakdowns: switch from `days` lookback to explicit start/end dates
-- so the dashboard's date range filter works for arbitrary windows.
-- ============================================================================

CREATE OR REPLACE FUNCTION apple_refunds_by_cpp_range(start_date DATE, end_date DATE)
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
  WHERE event_date >= start_date
    AND event_date <= end_date
    AND apple_event_class(event) IN ('refund', 'paid')
  GROUP BY 1
  ORDER BY MIN(consecutive_paid_periods) NULLS LAST;
$$ LANGUAGE SQL STABLE;


CREATE OR REPLACE FUNCTION apple_refunds_by_days_to_refund_range(start_date DATE, end_date DATE)
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
      AND event_date >= start_date
      AND event_date <= end_date
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


CREATE OR REPLACE FUNCTION apple_refunds_by_dimension_range(
  dim TEXT,
  start_date DATE,
  end_date DATE,
  top_n INT DEFAULT 15
)
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
  WHERE event_date >= start_date
    AND event_date <= end_date
    AND apple_event_class(event) IN ('refund', 'paid')
  GROUP BY 1
  ORDER BY refunds DESC
  LIMIT top_n;
$$ LANGUAGE SQL STABLE;
