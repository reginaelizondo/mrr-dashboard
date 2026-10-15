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

const GROSS_TOTAL = `(SUM(renewals_sales) + SUM(renewals_sales_yearly_ios) + SUM(new_subscriptions_sales) + SUM(other_sales))`;

// Stripe subscription sales (new + renewals), net of refunds — the same expression
// Looker's TOTAL CONTRIBUTION uses for its Stripe term.
const STRIPE_SUBS = `(SUM(IF(payment_processor = "stripe", new_subscriptions_sales, 0)) + SUM(IF(payment_processor = "stripe", renewals_sales, 0)))`;

// --- Net Sales (refactor) with yearly ios ----------------------------------------
// Business decisions (kept): sales are ATTRIBUTED by the user's os, and Stripe
// subscriptions are part of Net Sales. The store commission is applied per os bucket:
// iOS 0.7, Android 0.85, Web/Unknown 0.98, yearly iOS renewals 0.85, other_sales
// Stripe 0.97 / Shopify 0.98, minus 6 % tax on the store buckets, minus refund-date
// refunds at the blended net ratio.
//
// History of the Stripe term:
//  - until 2026-10-15 the Looker netted Stripe charges inside the iOS/Android buckets (they carry
//    the buyer's os) AND added them again at 0.965 in TOTAL CONTRIBUTION (double count, ~1.5×).
//  - "Variante 2" (agreed 2026-10-12, applied by tech in the ORIGINAL Looker 2026-10-15, verified
//    wk 5–11 oct TC $21,411): Stripe excluded from the os buckets and added inside Net Sales as
//    `(stripe new subs + renewals) × 0.965`; TOTAL CONTRIBUTION = Net Sales − spend. This is the
//    `…Looker` definition below — what the Looker shows today.
//  - Still wrong in Variante 2 (found 2026-10-15, pending with tech): new_subscriptions_sales and
//    renewals_sales are NET of refunds, so the Stripe term already excludes its refunds — and the
//    refund-date term subtracts them again. The os buckets avoid this by adding back
//    refunds_total_amount_sale_date. FIXED adds the Stripe refunds by sale date to the Stripe term
//    in the first half only (not in the ratio half). Expected wk 5–11 oct: NS ≈ $66,077,
//    TC ≈ $22,122, CM/Sales ≈ 23.28 % (data of 2026-10-15).
type NetSalesMode = 'looker' | 'fixed';
const STRIPE_RSD = `SUM(IF(payment_processor = "stripe", refunds_total_amount_sale_date, 0))`;
function netSalesByOs(mode: NetSalesMode): string {
  const x = ` AND COALESCE(payment_processor, "") != "stripe"`;
  const bucket = (cond: string, col: string) => `SUM(IF(${cond}${x}, ${col}, 0))`;
  const gross = (cond: string, withRefunds: boolean) =>
    `(${bucket(cond, 'renewals_sales')} + ${bucket(cond, 'new_subscriptions_sales')}${withRefunds ? ` + ${bucket(cond, 'refunds_total_amount_sale_date')}` : ''})`;
  const yearly = `SUM(renewals_sales_yearly_ios)`;
  const stripe = (withRefunds: boolean) =>
    mode === 'fixed' && withRefunds ? `(${STRIPE_SUBS} + ${STRIPE_RSD}) * 0.965` : `${STRIPE_SUBS} * 0.965`;
  const body = (withRefunds: boolean) => `(
    SUM(IF(network = "stripe", other_sales, 0)) * 0.97
    + SUM(IF(network = "shopify", other_sales, 0)) * 0.98
    + ${gross('os = "iOS"', withRefunds)} * 0.7
    + ${yearly} * 0.85
    + ${gross('os = "Android"', withRefunds)} * 0.85
    + ${gross('os = "Unknown"', withRefunds)} * 0.98
    + ${gross('os = "Web"', withRefunds)} * 0.98
    + ${stripe(withRefunds)}
    - (${gross('(os = "Android" OR os = "iOS")', withRefunds)} + ${yearly}) * 0.06
  )`;
  return `(${body(true)} - SUM(refunds_total_amount_refund_date) * SAFE_DIVIDE(${body(false)}, ${GROSS_TOTAL}))`;
}

const NET_SALES_LOOKER = netSalesByOs('looker');
const NET_SALES_FIXED = netSalesByOs('fixed');

// Both definitions: contribution = Net Sales − spend (Mobile CM and TOTAL CONTRIBUTION coincide).
const CONTRIBUTION_LOOKER = `(${NET_SALES_LOOKER} - SUM(spend))`;
const CONTRIBUTION_FIXED = `(${NET_SALES_FIXED} - SUM(spend))`;

// Stripe refunds (sale date) × 0.965 = how much the Looker's Variante 2 under-states Net Sales/TC.
export const STRIPE_REFUND_GAP_SQL = `(${STRIPE_RSD} * 0.965)`;

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
  // FT → paid, same-period proxy (conversions land ~7 days after the trial starts).
  ftConversionRate: `SAFE_DIVIDE(SUM(fts_converted), SUM(fts_started))`,
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
  // Net Sales — FIXED definition (Stripe inside at 0.965, its refunds deducted once). See netSalesByOs.
  netSales: NET_SALES_FIXED,
  // Refunds issued in the period (refund-date attribution = point-in-time cash impact)
  refundsAmount: `SUM(refunds_total_amount_refund_date)`,
  refundsCount: `SUM(num_of_refunds_refund_date)`,

  // Margins — FIXED definitions (Mobile CM == Total Contribution == Net Sales − spend)
  mobileCm: CONTRIBUTION_FIXED,
  totalContribution: CONTRIBUTION_FIXED,
  contributionMarginPct: `SAFE_DIVIDE(${CONTRIBUTION_FIXED}, ${TOTAL_SALES})`,
  // Looker "New Subs Margin": uses NET new-sub sales (raw column), not gross NS Sales.
  newSubsMargin: `SAFE_DIVIDE(SUM(new_subscriptions_sales) * 0.7 - SUM(spend), SUM(new_subscriptions_sales))`,

  // Looker's current definitions (Variante 2 since 2026-10-15), reproduced to the cent — shown as
  // discrepancies until tech applies the Stripe refund add-back, then they equal the fixed ones.
  netSalesLooker: NET_SALES_LOOKER,
  mobileCmLooker: CONTRIBUTION_LOOKER,
  totalContributionLooker: CONTRIBUTION_LOOKER,
  contributionMarginPctLooker: `SAFE_DIVIDE(${CONTRIBUTION_LOOKER}, ${TOTAL_SALES})`,
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
  ftConversionRate: 'FT conversion',
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
