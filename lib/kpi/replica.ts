/**
 * Réplica del Looker "Operational Dashboard" sobre la tabla kpi_daily (Supabase).
 *
 * Flujo: kpi_daily_agg() (SQL, migración 032) devuelve las SUMAS base por periodo y, si se
 * pide, por una dimensión; este módulo calcula los KPIs sobre esas sumas con las mismas
 * fórmulas de lib/kpi/formulas.ts (BigQuery). Es la única implementación de las fórmulas
 * en TypeScript; scripts/test-kpi-replica.ts la verifica contra BigQuery.
 *
 * Dos definiciones conviven (ver formulas.ts para la historia completa):
 *   'looker' — lo que el Looker muestra hoy (Stripe neteado como Apple/Google dentro de
 *              Net Sales y sumado otra vez al 0.965 en TOTAL CONTRIBUTION).
 *   'fixed'  — Variante 2 acordada: Stripe al 0.965 dentro de Net Sales, TC = Net Sales − spend.
 */
import { createServerClient } from '@/lib/supabase/server';

export type Grain = 'day' | 'week' | 'month' | 'quarter' | 'year' | 'total';
export type GroupDim = 'none' | 'os' | 'country' | 'kinedu_language' | 'kinedu_region' | 'network' | 'payment_processor' | 'plan_type';
export type Definition = 'looker' | 'fixed';

export interface ReplicaFilters {
  start: string;              // YYYY-MM-DD inclusive
  end: string;                // YYYY-MM-DD inclusive
  region?: string[];
  country?: string[];
  os?: string[];
  language?: string[];
}

/** Sumas base que devuelve kpi_daily_agg (todas numéricas; Supabase las manda como string). */
export interface AggRow {
  period: string; grp: string;
  signups: number; fts_started: number; fts_converted: number; downloads: number; spend: number;
  new_subscriptions: number; new_subscriptions_sales: number;
  renewals: number; renewals_sales: number; renewals_yearly_ios: number; renewals_sales_yearly_ios: number;
  other_sales: number; other_purchases: number;
  refunds_total_amount_refund_date: number; num_of_refunds_refund_date: number;
  refunds_total_amount_sale_date: number; num_of_refunds_sale_date: number;
  other_sales_stripe_net: number; other_sales_shopify_net: number;
  stripe_ns_sales: number; stripe_ren_sales: number;
  ios_ren: number; ios_ns: number; ios_rsd: number; ios_ren_s: number; ios_ns_s: number; ios_rsd_s: number;
  and_ren: number; and_ns: number; and_rsd: number; and_ren_s: number; and_ns_s: number; and_rsd_s: number;
  web_ren: number; web_ns: number; web_rsd: number; web_ren_s: number; web_ns_s: number; web_rsd_s: number;
  unk_ren: number; unk_ns: number; unk_rsd: number; unk_ren_s: number; unk_ns_s: number; unk_rsd_s: number;
}

const AGG_NUMERIC_KEYS = [
  'signups', 'fts_started', 'fts_converted', 'downloads', 'spend', 'new_subscriptions', 'new_subscriptions_sales',
  'renewals', 'renewals_sales', 'renewals_yearly_ios', 'renewals_sales_yearly_ios', 'other_sales', 'other_purchases',
  'refunds_total_amount_refund_date', 'num_of_refunds_refund_date', 'refunds_total_amount_sale_date', 'num_of_refunds_sale_date',
  'other_sales_stripe_net', 'other_sales_shopify_net', 'stripe_ns_sales', 'stripe_ren_sales',
  'ios_ren', 'ios_ns', 'ios_rsd', 'ios_ren_s', 'ios_ns_s', 'ios_rsd_s',
  'and_ren', 'and_ns', 'and_rsd', 'and_ren_s', 'and_ns_s', 'and_rsd_s',
  'web_ren', 'web_ns', 'web_rsd', 'web_ren_s', 'web_ns_s', 'web_rsd_s',
  'unk_ren', 'unk_ns', 'unk_rsd', 'unk_ren_s', 'unk_ns_s', 'unk_rsd_s',
] as const;
type AggNumericKey = (typeof AGG_NUMERIC_KEYS)[number];

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
export const safeDiv = (a: number, b: number): number | null => (b === 0 ? null : a / b);

export function emptyAgg(period = '', grp = ''): AggRow {
  const r = { period, grp } as AggRow;
  for (const k of AGG_NUMERIC_KEYS) r[k] = 0;
  return r;
}

/** Suma de varias filas (p. ej. para totales o para colapsar grupos). */
export function sumAgg(rows: AggRow[], period = 'total', grp = ''): AggRow {
  const out = emptyAgg(period, grp);
  for (const r of rows) for (const k of AGG_NUMERIC_KEYS) out[k] += r[k];
  return out;
}

// ---------------------------------------------------------------------------
// Fórmulas (espejo exacto de lib/kpi/formulas.ts)
// ---------------------------------------------------------------------------

type Bucket = 'ios' | 'and' | 'web' | 'unk';

/** Suma de un bucket de OS: no-Stripe siempre; + Stripe si definition === 'looker'. */
function bucket(r: AggRow, b: Bucket, col: 'ren' | 'ns' | 'rsd', def: Definition): number {
  const base = r[`${b}_${col}` as AggNumericKey];
  return def === 'looker' ? base + r[`${b}_${col}_s` as AggNumericKey] : base;
}

function netSales(r: AggRow, def: Definition): number {
  const gross = (b: Bucket, withRefunds: boolean) =>
    bucket(r, b, 'ren', def) + bucket(r, b, 'ns', def) + (withRefunds ? bucket(r, b, 'rsd', def) : 0);
  const yearly = r.renewals_sales_yearly_ios;
  const stripeTerm = def === 'fixed' ? stripeSubs(r) * 0.965 : 0;
  const body = (withRefunds: boolean) =>
    r.other_sales_stripe_net * 0.97
    + r.other_sales_shopify_net * 0.98
    + gross('ios', withRefunds) * 0.7
    + yearly * 0.85
    + gross('and', withRefunds) * 0.85
    + gross('unk', withRefunds) * 0.98
    + gross('web', withRefunds) * 0.98
    + stripeTerm
    - (gross('and', withRefunds) + gross('ios', withRefunds) + yearly) * 0.06;
  const grossTotal = r.renewals_sales + r.renewals_sales_yearly_ios + r.new_subscriptions_sales + r.other_sales;
  const ratio = safeDiv(body(false), grossTotal) ?? 0;
  return body(true) - r.refunds_total_amount_refund_date * ratio;
}

const stripeSubs = (r: AggRow) => r.stripe_ns_sales + r.stripe_ren_sales;

export interface KpiValues {
  // Volumen
  spend: number; signups: number; downloads: number; ftsStarted: number; ftsConverted: number;
  newSubs: number; purchasesNonFt: number; purchasesNonFtLooker: number; renewals: number; renewalsYearlyIos: number;
  refundsCount: number;
  // Tasas y unit economics (null cuando el denominador es 0)
  conversionRate: number | null; convFromFt: number | null; convFromPurchases: number | null;
  ftStartRate: number | null; ftConversionRate: number | null; ftShare: number | null;
  cac: number | null; cacFromPurchases: number | null; cacFromFt: number | null;
  cpnu: number | null; cpft: number | null; cpi: number | null; signupsPerDownload: number | null;
  arpu: number | null; firstTicketCac: number | null; arpuMinusCac: number | null;
  usersPerPurchase: number | null; usersPerFtConverted: number | null;
  // Ventas
  nsSales: number; renewalsSales: number; renewalsSalesYearlyIos: number; totalRenewalSales: number; otherSales: number;
  totalSales: number; netSales: number; refundsAmount: number;
  // Márgenes
  mobileCm: number; totalContribution: number; contributionMarginPct: number | null; newSubsMargin: number | null;
  salesOverSpend: number | null; newSalesOverSpend: number | null; contributionOverSpend: number | null;
}

/** Calcula todos los KPIs de una fila agregada bajo una definición. */
export function computeKpis(r: AggRow, def: Definition): KpiValues {
  const newSubs = r.new_subscriptions + r.num_of_refunds_sale_date;
  const nsSales = r.new_subscriptions_sales + r.refunds_total_amount_sale_date;
  const totalSales = r.renewals_sales + r.renewals_sales_yearly_ios + r.new_subscriptions_sales + r.other_sales
    + r.refunds_total_amount_sale_date - r.refunds_total_amount_refund_date;
  const arpu = safeDiv(nsSales + r.other_sales, newSubs + r.other_purchases);
  const cac = safeDiv(r.spend, newSubs);
  const ns = netSales(r, def);
  const mobileCm = ns - r.spend;
  // Looker: TC = Mobile CM + Stripe (el término payment_processor = "other_sales" es siempre 0).
  const totalContribution = def === 'looker' ? mobileCm + stripeSubs(r) * 0.965 : mobileCm;
  const purchasesNonFt = newSubs - r.fts_converted;
  return {
    spend: r.spend, signups: r.signups, downloads: r.downloads, ftsStarted: r.fts_started, ftsConverted: r.fts_converted,
    newSubs, purchasesNonFt, purchasesNonFtLooker: r.new_subscriptions - r.fts_converted,
    renewals: r.renewals + r.renewals_yearly_ios, renewalsYearlyIos: r.renewals_yearly_ios,
    refundsCount: r.num_of_refunds_refund_date,
    conversionRate: safeDiv(newSubs, r.signups),
    convFromFt: safeDiv(r.fts_converted, r.signups),
    convFromPurchases: safeDiv(purchasesNonFt, r.signups),
    ftStartRate: safeDiv(r.fts_started, r.signups),
    ftConversionRate: safeDiv(r.fts_converted, r.fts_started),
    ftShare: safeDiv(r.fts_converted, newSubs),
    cac, cacFromPurchases: safeDiv(r.spend, purchasesNonFt), cacFromFt: safeDiv(r.spend, r.fts_converted),
    cpnu: safeDiv(r.spend, r.signups), cpft: safeDiv(r.spend, r.fts_started),
    cpi: safeDiv(r.spend, r.downloads), signupsPerDownload: safeDiv(r.signups, r.downloads),
    arpu, firstTicketCac: arpu !== null && cac !== null ? safeDiv(arpu, cac) : null,
    arpuMinusCac: arpu !== null && cac !== null ? arpu - cac : null,
    usersPerPurchase: safeDiv(r.signups, purchasesNonFt), usersPerFtConverted: safeDiv(r.signups, r.fts_converted),
    nsSales, renewalsSales: r.renewals_sales, renewalsSalesYearlyIos: r.renewals_sales_yearly_ios,
    totalRenewalSales: r.renewals_sales + r.renewals_sales_yearly_ios, otherSales: r.other_sales,
    totalSales, netSales: ns, refundsAmount: r.refunds_total_amount_refund_date,
    mobileCm, totalContribution,
    contributionMarginPct: safeDiv(totalContribution, totalSales),
    // Looker "New Subs Margin": usa la columna NETA de ventas de new subs.
    newSubsMargin: safeDiv(r.new_subscriptions_sales * 0.7 - r.spend, r.new_subscriptions_sales),
    salesOverSpend: safeDiv(totalSales, r.spend), newSalesOverSpend: safeDiv(nsSales, r.spend),
    contributionOverSpend: safeDiv(totalContribution, r.spend),
  };
}

// ---------------------------------------------------------------------------
// Acceso a datos
// ---------------------------------------------------------------------------

function parseAgg(raw: Record<string, unknown>): AggRow {
  const r = emptyAgg(String(raw.period), String(raw.grp ?? ''));
  for (const k of AGG_NUMERIC_KEYS) r[k] = num(raw[k]);
  return r;
}

const arr = (v?: string[]) => (v && v.length ? v : null);

/** Sumas base por periodo (y por grupo si se pide), ya filtradas. */
export async function fetchAgg(f: ReplicaFilters, grain: Grain, group: GroupDim = 'none'): Promise<AggRow[]> {
  const supabase = createServerClient();
  const { data, error } = await supabase.rpc('kpi_daily_agg', {
    p_start: f.start, p_end: f.end, p_grain: grain, p_group: group,
    p_region: arr(f.region), p_country: arr(f.country), p_os: arr(f.os), p_lang: arr(f.language),
  });
  if (error) throw new Error(`kpi_daily_agg: ${error.message}`);
  return ((data ?? []) as Record<string, unknown>[]).map(parseAgg);
}

export interface PeriodKpis { period: string; grp: string; agg: AggRow; looker: KpiValues; fixed: KpiValues }

/** KPIs por periodo bajo ambas definiciones. */
export async function fetchKpiSeries(f: ReplicaFilters, grain: Grain, group: GroupDim = 'none'): Promise<PeriodKpis[]> {
  const rows = await fetchAgg(f, grain, group);
  return rows.map((agg) => ({ period: agg.period, grp: agg.grp, agg, looker: computeKpis(agg, 'looker'), fixed: computeKpis(agg, 'fixed') }));
}

export interface DimValue { dim: string; value: string; signups: number; spend: number }

export async function fetchDimValues(fromDate?: string): Promise<DimValue[]> {
  const supabase = createServerClient();
  const { data, error } = await supabase.rpc('kpi_daily_dim_values', fromDate ? { p_from: fromDate } : {});
  if (error) throw new Error(`kpi_daily_dim_values: ${error.message}`);
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({ dim: String(r.dim), value: String(r.value), signups: num(r.signups), spend: num(r.spend) }));
}

export interface ReplicaStatus { minDate: string | null; maxDate: string | null; rows: number; lastSyncedAt: string | null }

export async function fetchReplicaStatus(): Promise<ReplicaStatus> {
  const supabase = createServerClient();
  const { data, error } = await supabase.rpc('kpi_daily_status');
  if (error) throw new Error(`kpi_daily_status: ${error.message}`);
  const r = ((data ?? []) as Record<string, unknown>[])[0] ?? {};
  return { minDate: r.min_date ? String(r.min_date) : null, maxDate: r.max_date ? String(r.max_date) : null, rows: num(r.rows_n), lastSyncedAt: r.last_synced_at ? String(r.last_synced_at) : null };
}
