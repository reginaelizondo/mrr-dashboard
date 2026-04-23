/**
 * KPI formulas — translated from Looker Studio's `an_operational_dash` calculated fields
 * to BigQuery SQL aggregate expressions.
 *
 * Source of truth: validated with user 2026-04-22.
 * Looker Studio field `OS (payment processor)` maps to BigQuery column `payment_processor`.
 *
 * Each export is a SQL fragment that aggregates over whatever rows are filtered upstream
 * (date range, breakdowns, etc.). Compose them inside `SELECT ... FROM an_operational_dash WHERE ...`.
 */

export const KPI_SQL = {
  // Gross new subscriptions (adds back refunded sales attributed to original sale month)
  newSubs: `(SUM(new_subscriptions) + SUM(num_of_refunds_sale_date))`,

  // Gross new subscription revenue (adds back refunds attributed to sale month)
  nsSales: `(SUM(new_subscriptions_sales) + SUM(refunds_total_amount_sale_date))`,

  cac: `SAFE_DIVIDE(SUM(spend), SUM(new_subscriptions) + SUM(num_of_refunds_sale_date))`,

  conversionRate: `SAFE_DIVIDE(SUM(new_subscriptions) + SUM(num_of_refunds_sale_date), SUM(signups))`,

  totalRenewalSales: `(SUM(renewals_sales_yearly_ios) + SUM(renewals_sales))`,

  totalSales: `(
    SUM(renewals_sales)
    + SUM(renewals_sales_yearly_ios)
    + SUM(new_subscriptions_sales)
    + SUM(other_sales)
    + SUM(refunds_total_amount_sale_date)
    - SUM(refunds_total_amount_refund_date)
  )`,

  arpu: `SAFE_DIVIDE(
    SUM(new_subscriptions_sales) + SUM(refunds_total_amount_sale_date) + SUM(other_sales),
    SUM(new_subscriptions) + SUM(num_of_refunds_sale_date) + SUM(other_purchases)
  )`,

  // Net Sales (refactor) with yearly ios — long formula handling per-platform commission rates,
  // 6% tax for mobile, and refund-weighted adjustment.
  netSales: `(
    SUM(IF(network = "stripe", other_sales, 0)) * 0.97
    + SUM(IF(network = "shopify", other_sales, 0)) * 0.98
    + ((SUM(IF(os = "iOS", renewals_sales, 0))
        + SUM(IF(os = "iOS", new_subscriptions_sales, 0))
        + SUM(IF(os = "iOS", refunds_total_amount_sale_date, 0))) * 0.7)
    + (SUM(renewals_sales_yearly_ios) * 0.85)
    + ((SUM(IF(os = "Android", renewals_sales, 0))
        + SUM(IF(os = "Android", new_subscriptions_sales, 0))
        + SUM(IF(os = "Android", refunds_total_amount_sale_date, 0))) * 0.85)
    + ((SUM(IF(os = "Unknown", renewals_sales, 0))
        + SUM(IF(os = "Unknown", new_subscriptions_sales, 0))
        + SUM(IF(os = "Unknown", refunds_total_amount_sale_date, 0))) * 0.98)
    + ((SUM(IF(os = "Web", renewals_sales, 0))
        + SUM(IF(os = "Web", new_subscriptions_sales, 0))
        + SUM(IF(os = "Web", refunds_total_amount_sale_date, 0))) * 0.98)
    - ((SUM(IF(os = "Android" OR os = "iOS", renewals_sales, 0))
        + SUM(renewals_sales_yearly_ios)
        + SUM(IF(os = "Android" OR os = "iOS", new_subscriptions_sales, 0))
        + SUM(IF(os = "Android" OR os = "iOS", refunds_total_amount_sale_date, 0))) * 0.06)
    - SUM(refunds_total_amount_refund_date) * SAFE_DIVIDE(
        SUM(IF(network = "stripe", other_sales, 0)) * 0.97
        + SUM(IF(network = "shopify", other_sales, 0)) * 0.98
        + ((SUM(IF(os = "iOS", renewals_sales, 0)) + SUM(IF(os = "iOS", new_subscriptions_sales, 0))) * 0.7)
        + (SUM(renewals_sales_yearly_ios) * 0.85)
        + ((SUM(IF(os = "Android", renewals_sales, 0)) + SUM(IF(os = "Android", new_subscriptions_sales, 0))) * 0.85)
        + ((SUM(IF(os = "Unknown", renewals_sales, 0)) + SUM(IF(os = "Unknown", new_subscriptions_sales, 0))) * 0.98)
        + ((SUM(IF(os = "Web", renewals_sales, 0)) + SUM(IF(os = "Web", new_subscriptions_sales, 0))) * 0.98)
        - ((SUM(IF(os = "Android" OR os = "iOS", renewals_sales, 0))
            + SUM(renewals_sales_yearly_ios)
            + SUM(IF(os = "Android" OR os = "iOS", new_subscriptions_sales, 0))) * 0.06),
        SUM(renewals_sales) + SUM(renewals_sales_yearly_ios) + SUM(new_subscriptions_sales) + SUM(other_sales)
      )
  )`,

  // Spend straight from raw column (used in CAC, etc.)
  spend: `SUM(spend)`,
  signups: `SUM(signups)`,

  // 1st Ticket / CAC = ARPU / CAC. Values ≥ 1.0x = first-purchase payback;
  // < 1.0x = losing money at first ticket, relies on renewals/other_sales.
  firstTicketCac: `SAFE_DIVIDE(
    SAFE_DIVIDE(
      SUM(new_subscriptions_sales) + SUM(refunds_total_amount_sale_date) + SUM(other_sales),
      SUM(new_subscriptions) + SUM(num_of_refunds_sale_date) + SUM(other_purchases)
    ),
    SAFE_DIVIDE(SUM(spend), SUM(new_subscriptions) + SUM(num_of_refunds_sale_date))
  )`,
} as const;

export type KPIKey = keyof typeof KPI_SQL;

export const KPI_LABELS: Record<KPIKey, string> = {
  newSubs: 'New Subscriptions',
  nsSales: 'New Subs Sales',
  cac: 'CAC',
  conversionRate: 'Conversion Rate',
  totalRenewalSales: 'Total Renewal Sales',
  totalSales: 'Total Sales',
  arpu: 'ARPU',
  netSales: 'Net Sales',
  spend: 'Spend',
  signups: 'Signups',
  firstTicketCac: '1st Ticket / CAC',
};
