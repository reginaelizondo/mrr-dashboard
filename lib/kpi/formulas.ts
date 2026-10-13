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
// BUG in Looker (found 2026-10-12, confirmed against the Stripe API): Stripe charges
// carry the buyer's os, so they fall into the iOS/Android buckets and get Apple's
// 0.7 (−6 %) instead of Stripe's ~3.8 % fee — and TOTAL CONTRIBUTION then adds them
// AGAIN at 0.965. Fix agreed with Pepis (2026-10-12, "Variante 2"): keep Stripe inside
// Net Sales but at its own rate — exclude it from the os buckets and add
// `+ STRIPE_SUBS × 0.965` inside Net Sales (both halves of the refund ratio) — and drop
// the Stripe term from TOTAL CONTRIBUTION, which becomes Net Sales − spend.
// Looker's current (buggy) version is kept as `…Looker` for the discrepancy block.
function netSalesByOs(fixed: boolean): string {
  const x = fixed ? ` AND COALESCE(payment_processor, "") != "stripe"` : '';
  const bucket = (cond: string, col: string) => `SUM(IF(${cond}${x}, ${col}, 0))`;
  const gross = (cond: string, withRefunds: boolean) =>
    `(${bucket(cond, 'renewals_sales')} + ${bucket(cond, 'new_subscriptions_sales')}${withRefunds ? ` + ${bucket(cond, 'refunds_total_amount_sale_date')}` : ''})`;
  const yearly = `SUM(renewals_sales_yearly_ios)`;
  const stripeTerm = fixed ? `\n    + ${STRIPE_SUBS} * 0.965` : '';
  const body = (withRefunds: boolean) => `(
    SUM(IF(network = "stripe", other_sales, 0)) * 0.97
    + SUM(IF(network = "shopify", other_sales, 0)) * 0.98
    + ${gross('os = "iOS"', withRefunds)} * 0.7
    + ${yearly} * 0.85
    + ${gross('os = "Android"', withRefunds)} * 0.85
    + ${gross('os = "Unknown"', withRefunds)} * 0.98
    + ${gross('os = "Web"', withRefunds)} * 0.98${stripeTerm}
    - (${gross('(os = "Android" OR os = "iOS")', withRefunds)} + ${yearly}) * 0.06
  )`;
  return `(${body(true)} - SUM(refunds_total_amount_refund_date) * SAFE_DIVIDE(${body(false)}, ${GROSS_TOTAL}))`;
}

const NET_SALES_LOOKER = netSalesByOs(false);
const NET_SALES_FIXED = netSalesByOs(true);

// Looker today: Mobile CM = Net Sales − spend; TOTAL CONTRIBUTION = Mobile CM + Stripe
// (+ an `other_sales` processor term that is always 0 — that bucket keeps its revenue
// in the other_sales COLUMN; kept verbatim to match Looker).
const STRIPE_TERM_LOOKER = `(
    ${STRIPE_SUBS}
    + SUM(IF(payment_processor = "other_sales", new_subscriptions_sales, 0))
    + SUM(IF(payment_processor = "other_sales", renewals_sales, 0))
  ) * 0.965`;
const MOBILE_CM_LOOKER = `(${NET_SALES_LOOKER} - SUM(spend))`;
const TOTAL_CONTRIBUTION_LOOKER = `(${MOBILE_CM_LOOKER} + ${STRIPE_TERM_LOOKER})`;

// Fixed: Stripe already sits inside Net Sales at 0.965, so contribution is simply
// Net Sales − spend. Mobile CM and TOTAL CONTRIBUTION coincide under this definition.
const CONTRIBUTION_FIXED = `(${NET_SALES_FIXED} - SUM(spend))`;

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
  // Net Sales — FIXED definition (Stripe inside, at 0.965). See netSalesByOs.
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

  // Looker's current definitions, reproduced to the cent — shown as discrepancies until
  // the dashboard is fixed, then they will equal the fixed ones and the block disappears.
  netSalesLooker: NET_SALES_LOOKER,
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
