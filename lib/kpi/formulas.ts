/**
 * KPI formulas — translated from Looker Studio's `an_operational_dash` calculated fields
 * to BigQuery SQL aggregate expressions.
 *
 * Source of truth: validated with user 2026-04-22; re-validated 2026-10-12 against the
 * Looker Studio weekly table + daily charts (every field reproduced to the cent for
 * 21-sep → 12-oct 2026). See docs/KPI-SOURCES.md for the field-by-field audit.
 * Looker Studio field `OS (payment processor)` maps to BigQuery column `payment_processor`.
 *
 * Each export is a SQL fragment that aggregates over whatever rows are filtered upstream
 * (date range, breakdowns, etc.). Compose them inside `SELECT ... FROM an_operational_dash WHERE ...`.
 *
 * Gotchas (bitten once each):
 * - new_subscriptions / new_subscriptions_sales are stored NET of refunds. Gross = add back
 *   num_of_refunds_sale_date / refunds_total_amount_sale_date.
 * - Never write `SUM(a + b)`: if either column is NULL on a row the whole row drops out.
 *   Always `SUM(a) + SUM(b)` (SUM ignores NULLs per column).
 * - NUMERIC columns (refunds_*) come back from the node client as strings — Number() them.
 */

// --- Shared fragments --------------------------------------------------------

const NEW_SUBS = `(SUM(new_subscriptions) + SUM(num_of_refunds_sale_date))`;
const NS_SALES = `(SUM(new_subscriptions_sales) + SUM(refunds_total_amount_sale_date))`;

const TOTAL_SALES = `(
    SUM(renewals_sales)
    + SUM(renewals_sales_yearly_ios)
    + SUM(new_subscriptions_sales)
    + SUM(other_sales)
    + SUM(refunds_total_amount_sale_date)
    - SUM(refunds_total_amount_refund_date)
  )`;

const ARPU = `SAFE_DIVIDE(
    SUM(new_subscriptions_sales) + SUM(refunds_total_amount_sale_date) + SUM(other_sales),
    SUM(new_subscriptions) + SUM(num_of_refunds_sale_date) + SUM(other_purchases)
  )`;

const CAC = `SAFE_DIVIDE(SUM(spend), SUM(new_subscriptions) + SUM(num_of_refunds_sale_date))`;

// Net Sales (refactor) with yearly ios — per-platform commission rates (0.7 iOS, 0.85
// Android/yearly-iOS, 0.98 Web/Unknown, 0.97 Stripe other sales), 6% tax on mobile,
// and refund-date refunds netted at the blended net ratio.
// NOTE: Stripe subscriptions carry the user's os (iOS/Android), so they are netted at
// the Apple/Google rate here — and TOTAL_CONTRIBUTION adds them again at 0.965. That
// double count is in the Looker definition too (flagged 2026-10-12, not changed here).
const NET_SALES = `(
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
  )`;

// --- Looker's margin fields (kept verbatim so the brief can show the discrepancy) ----

// MOBILE CONTRIBUTION MARGIN (Looker) = Net Sales (by os) − spend
const MOBILE_CM_LOOKER = `(${NET_SALES} - SUM(spend))`;

// TOTAL CONTRIBUTION (Looker) = Mobile CM + Stripe/other-processor subscription sales × 0.965.
// The `other_sales` processor bucket keeps its revenue in the `other_sales` COLUMN, so
// its two terms below are always 0 (harmless; kept verbatim to match Looker).
const TOTAL_CONTRIBUTION_LOOKER = `(${MOBILE_CM_LOOKER}
    + (
        SUM(IF(payment_processor = "stripe", new_subscriptions_sales, 0))
        + SUM(IF(payment_processor = "stripe", renewals_sales, 0))
        + SUM(IF(payment_processor = "other_sales", new_subscriptions_sales, 0))
        + SUM(IF(payment_processor = "other_sales", renewals_sales, 0))
      ) * 0.965
  )`;

// --- "Real" net: attribute by PAYMENT PROCESSOR, not by the user's os ------------
// Same constants as Looker (0.7 Apple · 0.85 Google and yearly iOS · 0.965 Stripe ·
// 0.98 other web processors · 6 % tax on store sales · refund-date refunds at the
// blended net ratio), but each sale is netted at ITS processor's rate. Looker nets
// by `os`, so a Stripe subscription bought on an iPhone is netted at Apple's 0.7
// (−6 % tax) and then TOTAL CONTRIBUTION adds it again at 0.965. Measured
// 2026-10-12 (4 weeks): Looker's TOTAL CONTRIBUTION runs 23–25 % above this.
// Decision (Pepis, 2026-10-12): the brief reports the real definition and shows
// Looker's figure as a discrepancy.
const pp = (p: string, col: string) => `SUM(IF(payment_processor = "${p}", ${col}, 0))`;
const ppOther = (col: string) =>
  `SUM(IF(payment_processor IS NULL OR payment_processor NOT IN ("apple", "google", "stripe"), ${col}, 0))`;
const grossBy = (sel: (col: string) => string, withRefunds: boolean) =>
  `(${sel('renewals_sales')} + ${sel('new_subscriptions_sales')}${withRefunds ? ` + ${sel('refunds_total_amount_sale_date')}` : ''})`;

/** Net store (mobile) revenue: Apple + Google + yearly iOS, minus the 6 % tax. */
function mobileNetByProcessor(withRefunds: boolean): string {
  const apple = grossBy((c) => pp('apple', c), withRefunds);
  const google = grossBy((c) => pp('google', c), withRefunds);
  return `(
    ${apple} * 0.7
    + SUM(renewals_sales_yearly_ios) * 0.85
    + ${google} * 0.85
    - (${apple} + ${google} + SUM(renewals_sales_yearly_ios)) * 0.06
  )`;
}

/** Net of everything: mobile + Stripe + other web processors + other_sales. */
function netByProcessor(withRefunds: boolean): string {
  const stripe = grossBy((c) => pp('stripe', c), withRefunds);
  const other = grossBy(ppOther, withRefunds);
  return `(
    ${mobileNetByProcessor(withRefunds)}
    + ${stripe} * 0.965
    + ${other} * 0.98
    + SUM(IF(network = "stripe", other_sales, 0)) * 0.97
    + SUM(IF(network = "shopify", other_sales, 0)) * 0.98
  )`;
}

const GROSS_TOTAL = `(SUM(renewals_sales) + SUM(renewals_sales_yearly_ios) + SUM(new_subscriptions_sales) + SUM(other_sales))`;

const NET_SALES_REAL = `(
    ${netByProcessor(true)}
    - SUM(refunds_total_amount_refund_date) * SAFE_DIVIDE(${netByProcessor(false)}, ${GROSS_TOTAL})
  )`;

const MOBILE_CM_REAL = `(
    ${mobileNetByProcessor(true)}
    - SUM(refunds_total_amount_refund_date) * SAFE_DIVIDE(${mobileNetByProcessor(false)}, ${GROSS_TOTAL})
    - SUM(spend)
  )`;

const TOTAL_CONTRIBUTION_REAL = `(${NET_SALES_REAL} - SUM(spend))`;

// --- Public registry ----------------------------------------------------------

export const KPI_SQL = {
  // Acquisition funnel
  spend: `SUM(spend)`,
  signups: `SUM(signups)`,
  ftsStarted: `SUM(fts_started)`,
  ftsConverted: `SUM(fts_converted)`,
  // Gross new subscriptions (adds back refunded sales attributed to original sale month)
  newSubs: NEW_SUBS,
  // New Subs − FT conversions. GROSS basis (consistent with newSubs). The Looker daily
  // chart "Purchases (non FT's)" subtracts from the NET column instead and so reads
  // ~10% lower — flagged 2026-10-12.
  purchasesNonFt: `(SUM(new_subscriptions) + SUM(num_of_refunds_sale_date) - SUM(fts_converted))`,

  // Unit economics
  conversionRate: `SAFE_DIVIDE(SUM(new_subscriptions) + SUM(num_of_refunds_sale_date), SUM(signups))`,
  ftStartRate: `SAFE_DIVIDE(SUM(fts_started), SUM(signups))`,
  ftShare: `SAFE_DIVIDE(SUM(fts_converted), SUM(new_subscriptions) + SUM(num_of_refunds_sale_date))`,
  cac: CAC,
  cpnu: `SAFE_DIVIDE(SUM(spend), SUM(signups))`,
  cpft: `SAFE_DIVIDE(SUM(spend), SUM(fts_started))`,
  arpu: ARPU,
  // 1st Ticket / CAC = ARPU / CAC. ≥ 1.0x = first-purchase payback.
  firstTicketCac: `SAFE_DIVIDE(${ARPU}, ${CAC})`,

  // Revenue
  // Gross new subscription revenue (adds back refunds attributed to sale month)
  nsSales: NS_SALES,
  totalRenewalSales: `(SUM(renewals_sales_yearly_ios) + SUM(renewals_sales))`,
  renewals: `(SUM(renewals) + SUM(renewals_yearly_ios))`,
  totalSales: TOTAL_SALES,
  // Net Sales — REAL definition (netted by payment processor). See NET_SALES_REAL.
  netSales: NET_SALES_REAL,
  // Refunds issued in the period (refund-date attribution = point-in-time cash impact)
  refundsAmount: `SUM(refunds_total_amount_refund_date)`,
  refundsCount: `SUM(num_of_refunds_refund_date)`,

  // Margins — REAL definitions
  mobileCm: MOBILE_CM_REAL,
  totalContribution: TOTAL_CONTRIBUTION_REAL,
  contributionMarginPct: `SAFE_DIVIDE(${TOTAL_CONTRIBUTION_REAL}, ${TOTAL_SALES})`,
  // Looker "New Subs Margin": uses NET new-sub sales (raw column), not gross NS Sales.
  newSubsMargin: `SAFE_DIVIDE(SUM(new_subscriptions_sales) * 0.7 - SUM(spend), SUM(new_subscriptions_sales))`,

  // Looker's own definitions, reproduced to the cent — shown as discrepancies, not used as KPIs.
  netSalesLooker: NET_SALES,
  mobileCmLooker: MOBILE_CM_LOOKER,
  totalContributionLooker: TOTAL_CONTRIBUTION_LOOKER,
  contributionMarginPctLooker: `SAFE_DIVIDE(${TOTAL_CONTRIBUTION_LOOKER}, ${TOTAL_SALES})`,
  // Looker daily chart "Purchases (non FT's)": subtracts from the NET new-subs count.
  purchasesNonFtLooker: `(SUM(new_subscriptions) - SUM(fts_converted))`,
} as const;

export type KPIKey = keyof typeof KPI_SQL;

export const KPI_LABELS: Record<KPIKey, string> = {
  spend: 'Spend',
  signups: 'Signups',
  ftsStarted: 'FT starts',
  ftsConverted: 'FT converted',
  newSubs: 'New Subscriptions',
  purchasesNonFt: 'Purchases (non FT)',
  conversionRate: 'Conversion Rate',
  ftStartRate: 'FT Start Rate',
  ftShare: 'FT Share',
  cac: 'CAC',
  cpnu: 'CPNU',
  cpft: 'CPFT',
  arpu: 'ARPU',
  firstTicketCac: '1st Ticket / CAC',
  nsSales: 'New Subs Sales',
  totalRenewalSales: 'Total Renewal Sales',
  renewals: 'Renewals',
  totalSales: 'Total Sales',
  netSales: 'Net Sales',
  refundsAmount: 'Refunds',
  refundsCount: 'Refunds (count)',
  mobileCm: 'Mobile Contribution Margin',
  totalContribution: 'Total Contribution',
  contributionMarginPct: 'Contribution Margin %',
  newSubsMargin: 'New Subs Margin',
  netSalesLooker: 'Net Sales (Looker)',
  mobileCmLooker: 'Mobile Contribution Margin (Looker)',
  totalContributionLooker: 'Total Contribution (Looker)',
  contributionMarginPctLooker: 'Contribution Margin % (Looker)',
  purchasesNonFtLooker: 'Purchases (non FT) (Looker)',
};
