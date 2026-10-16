/**
 * Réplica del Looker "Operational Dashboard" sobre la tabla kpi_daily (Supabase).
 *
 * Flujo: kpi_daily_agg() (SQL, migración 032) devuelve las SUMAS base por periodo y, si se
 * pide, por una dimensión; este módulo calcula los KPIs sobre esas sumas con las mismas
 * fórmulas de lib/kpi/formulas.ts (BigQuery). Es la única implementación de las fórmulas
 * en TypeScript; scripts/test-kpi-replica.ts la verifica contra BigQuery.
 *
 * Dos definiciones conviven (ver formulas.ts para la historia completa):
 *   'looker' — lo que el Looker muestra hoy: Variante 2 (aplicada por tech el 15-oct-2026):
 *              Stripe fuera de los buckets de OS y dentro de Net Sales al 0.965; TC = Net Sales − spend.
 *   'fixed'  — Variante 2 + reembolsos de Stripe restados UNA vez (el Looker los resta dos: las
 *              ventas netas ya los excluyen y el término de refund-date los vuelve a restar).
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
  stripe_yr_sales: number; // migración 036; 0 si aún no existe
  // Corregido calibrado con tienda (migración 037; 0 si aún no existe)
  cal_gross: number; cal_ns: number; cal_other: number; cal_net: number; cal_ref_gross: number; cal_ref_net: number;
  cal_est_gross: number; cal_uncal_gross: number;
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
  'stripe_yr_sales',
  'cal_gross', 'cal_ns', 'cal_other', 'cal_net', 'cal_ref_gross', 'cal_ref_net', 'cal_est_gross', 'cal_uncal_gross',
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

/** Suma de un bucket de OS sin Stripe (ambas definiciones excluyen Stripe de los buckets). */
function bucket(r: AggRow, b: Bucket, col: 'ren' | 'ns' | 'rsd'): number {
  return r[`${b}_${col}` as AggNumericKey];
}
/** Reembolsos de Stripe por fecha de venta (las filas de Stripe siempre traen uno de los 4 OS). */
const stripeRsd = (r: AggRow) => r.ios_rsd_s + r.and_rsd_s + r.web_rsd_s + r.unk_rsd_s;

function netSales(r: AggRow, def: Definition): number {
  const gross = (b: Bucket, withRefunds: boolean) =>
    bucket(r, b, 'ren') + bucket(r, b, 'ns') + (withRefunds ? bucket(r, b, 'rsd') : 0);
  // Corregido: las renovaciones anuales de iOS cobradas por Stripe salen del término "yearly" (0.85 − 6 %)
  // y entran al de Stripe (0.965), igual que en formulas.ts.
  const yearly = def === 'fixed' ? r.renewals_sales_yearly_ios - r.stripe_yr_sales : r.renewals_sales_yearly_ios;
  const stripeTerm = (withRefunds: boolean) =>
    (def === 'fixed' ? stripeSubs(r) + r.stripe_yr_sales + (withRefunds ? stripeRsd(r) : 0) : stripeSubs(r)) * 0.965;
  const body = (withRefunds: boolean) =>
    r.other_sales_stripe_net * 0.97
    + r.other_sales_shopify_net * 0.98
    + gross('ios', withRefunds) * 0.7
    + yearly * 0.85
    + gross('and', withRefunds) * 0.85
    + gross('unk', withRefunds) * 0.98
    + gross('web', withRefunds) * 0.98
    + stripeTerm(withRefunds)
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
  cac: number | null; cacFromPurchases: number | null; cacFromFt: number | null; cacCalculated: number | null;
  cpnu: number | null; cpft: number | null; cpi: number | null; signupsPerDownload: number | null;
  arpu: number | null; firstTicketCac: number | null; arpuMinusCac: number | null;
  usersPerPurchase: number | null; usersPerFtConverted: number | null;
  // Ventas
  nsSales: number; renewalsSales: number; renewalsSalesYearlyIos: number; totalRenewalSales: number; otherSales: number;
  totalSales: number; netSales: number; refundsAmount: number;
  // Márgenes
  mobileCm: number; totalContribution: number; contributionMarginPct: number | null; newSubsMargin: number | null;
  salesOverSpend: number | null; newSalesOverSpend: number | null; newSalesOverSpendNet: number | null; contributionOverSpend: number | null;
  // Calidad del Corregido: qué parte de las ventas brutas usa factores de tienda reales, estimados o ninguno.
  calibration: { calibrated: boolean; estimatedShare: number; uncalibratedShare: number };
}

/** Calcula todos los KPIs de una fila agregada bajo una definición. */
export function computeKpis(r: AggRow, def: Definition): KpiValues {
  const newSubs = r.new_subscriptions + r.num_of_refunds_sale_date;
  const grossSaleDate = r.renewals_sales + r.renewals_sales_yearly_ios + r.new_subscriptions_sales + r.other_sales + r.refunds_total_amount_sale_date;
  // Corregido calibrado (migración 037): ventas en la base de cada tienda (lo que pagó el cliente y lo que
  // depositó la tienda, a su tipo de cambio). Sin la 037 (cal_gross = 0) cae al modelo de tasas fijas.
  const calibrated = def === 'fixed' && r.cal_gross !== 0;
  const nsSales = calibrated ? r.cal_ns : r.new_subscriptions_sales + r.refunds_total_amount_sale_date;
  const otherSales = calibrated ? r.cal_other : r.other_sales;
  const totalSales = calibrated ? r.cal_gross - r.cal_ref_gross : grossSaleDate - r.refunds_total_amount_refund_date;
  const arpu = safeDiv(nsSales + otherSales, newSubs + r.other_purchases);
  const cac = safeDiv(r.spend, newSubs);
  const ns = calibrated ? r.cal_net - r.cal_ref_net : netSales(r, def);
  const mobileCm = ns - r.spend;
  // Ambas definiciones: TOTAL CONTRIBUTION = MOBILE CONTRIBUTION MARGIN = Net Sales − spend.
  const totalContribution = mobileCm;
  // El Looker no es consistente con el conteo de compras: las tablas (CAC, C.R., Conv. from Purchases)
  // usan New Subs BRUTAS (+ reembolsos por fecha de venta), pero las gráficas de "Purchases (non FT's)",
  // "CAC from Purchases" y "CAC calculated" usan la columna NETA (verificado 2026-10-15 contra las
  // etiquetas de la página Daily Purchases and Free Trial). 'looker' copia eso; 'fixed' usa brutas en todo.
  const purchasesNonFtGross = newSubs - r.fts_converted;
  const purchasesNonFtNet = r.new_subscriptions - r.fts_converted;
  const purchasesNonFt = def === 'looker' ? purchasesNonFtNet : purchasesNonFtGross;
  return {
    spend: r.spend, signups: r.signups, downloads: r.downloads, ftsStarted: r.fts_started, ftsConverted: r.fts_converted,
    newSubs, purchasesNonFt, purchasesNonFtLooker: purchasesNonFtNet,
    renewals: r.renewals + r.renewals_yearly_ios, renewalsYearlyIos: r.renewals_yearly_ios,
    refundsCount: r.num_of_refunds_refund_date,
    conversionRate: safeDiv(newSubs, r.signups),
    convFromFt: safeDiv(r.fts_converted, r.signups),
    convFromPurchases: safeDiv(purchasesNonFtGross, r.signups),
    ftStartRate: safeDiv(r.fts_started, r.signups),
    ftConversionRate: safeDiv(r.fts_converted, r.fts_started),
    ftShare: safeDiv(r.fts_converted, newSubs),
    cac, cacFromPurchases: safeDiv(r.spend, purchasesNonFt), cacFromFt: safeDiv(r.spend, r.fts_converted),
    cacCalculated: def === 'looker' ? safeDiv(r.spend, r.new_subscriptions) : cac,
    cpnu: safeDiv(r.spend, r.signups), cpft: safeDiv(r.spend, r.fts_started),
    cpi: safeDiv(r.spend, r.downloads), signupsPerDownload: safeDiv(r.signups, r.downloads),
    arpu, firstTicketCac: arpu !== null && cac !== null ? safeDiv(arpu, cac) : null,
    arpuMinusCac: arpu !== null && cac !== null ? arpu - cac : null,
    usersPerPurchase: safeDiv(r.signups, purchasesNonFt), usersPerFtConverted: safeDiv(r.signups, r.fts_converted),
    nsSales, renewalsSales: r.renewals_sales, renewalsSalesYearlyIos: r.renewals_sales_yearly_ios,
    totalRenewalSales: r.renewals_sales + r.renewals_sales_yearly_ios, otherSales,
    totalSales, netSales: ns, refundsAmount: r.refunds_total_amount_refund_date,
    mobileCm, totalContribution,
    contributionMarginPct: safeDiv(totalContribution, totalSales),
    // Looker "New Subs Margin": usa la columna NETA de ventas de new subs.
    newSubsMargin: safeDiv(r.new_subscriptions_sales * 0.7 - r.spend, r.new_subscriptions_sales),
    salesOverSpend: safeDiv(totalSales, r.spend), newSalesOverSpend: safeDiv(nsSales, r.spend),
    // La gráfica MENSUAL "New Sales / Spend" del Looker (Monthly Sales & Margin) usa ventas netas de
    // reembolsos; la semanal usa NS Sales. Mismo nombre, dos campos (verificado 13/13 meses).
    newSalesOverSpendNet: safeDiv(r.new_subscriptions_sales, r.spend),
    contributionOverSpend: safeDiv(totalContribution, r.spend),
    calibration: {
      calibrated,
      estimatedShare: calibrated && grossSaleDate ? r.cal_est_gross / grossSaleDate : 0,
      uncalibratedShare: calibrated && grossSaleDate ? r.cal_uncal_gross / grossSaleDate : def === 'fixed' ? 1 : 0,
    },
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
  const args = {
    p_start: f.start, p_end: f.end, p_grain: grain, p_group: group,
    p_region: arr(f.region), p_country: arr(f.country), p_os: arr(f.os), p_lang: arr(f.language),
  };
  // PostgREST corta cada respuesta en 1,000 filas: diario × país (o diario de todo el historial) pasa
  // de eso fácilmente. La función ordena por (period, grp), así que paginar con range es estable.
  const out: AggRow[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.rpc('kpi_daily_agg', args).range(from, from + PAGE - 1);
    if (error) throw new Error(`kpi_daily_agg: ${error.message}`);
    const rows = (data ?? []) as Record<string, unknown>[];
    out.push(...rows.map(parseAgg));
    if (rows.length < PAGE) break;
  }
  return out;
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

export interface ReplicaJob {
  status: string; finishedAt: string | null;
  heal: { checkedDays: number; badDays: number; healedDays: number; skipped?: string } | null;
  rotated: { start: string; end: string } | null;
  error?: string;
}
export interface ReplicaStatus { minDate: string | null; maxDate: string | null; rows: number; lastSyncedAt: string | null; lastJob: ReplicaJob | null }

export async function fetchReplicaStatus(): Promise<ReplicaStatus> {
  const supabase = createServerClient();
  // Barato a propósito: MIN/MAX por el índice de fecha y conteo estimado del planner. La función
  // kpi_daily_status() recorre las 661 K filas y en producción rebasaba el timeout de 8 s cuando
  // corría junto con el resto de las consultas de la página (2026-10-15).
  const [first, last, count, logs] = await Promise.all([
    supabase.from('kpi_daily').select('date').order('date', { ascending: true }).limit(1),
    supabase.from('kpi_daily').select('date,synced_at').order('date', { ascending: false }).limit(1),
    supabase.from('kpi_daily').select('date', { count: 'estimated', head: true }),
    supabase.from('sync_log').select('status,completed_at,started_at,details')
      .eq('source', 'kpi_daily').eq('sync_type', 'daily').order('started_at', { ascending: false }).limit(1),
  ]);
  const minRow = (first.data ?? [])[0] as { date: string } | undefined;
  const maxRow = (last.data ?? [])[0] as { date: string; synced_at: string } | undefined;
  const log = ((logs.data ?? []) as Array<{ status: string; completed_at: string | null; started_at: string; details: Record<string, unknown> | null }>)[0];
  const d = log?.details ?? {};
  const lastJob: ReplicaJob | null = log ? {
    status: log.status, finishedAt: log.completed_at ?? log.started_at,
    heal: (d.heal as ReplicaJob['heal']) ?? null, rotated: (d.rotated as ReplicaJob['rotated']) ?? null,
    error: typeof d.error === 'string' ? d.error : undefined,
  } : null;
  return {
    minDate: minRow?.date ?? null, maxDate: maxRow?.date ?? null, rows: count.count ?? 0,
    // El día más reciente se re-sincroniza en cada job, así que su synced_at = hora del último sync.
    lastSyncedAt: log?.completed_at ?? maxRow?.synced_at ?? null, lastJob,
  };
}

// ---------------------------------------------------------------------------
// Cobertura de tienda (qué días del Corregido son reales y cuáles estimados)
// ---------------------------------------------------------------------------

export interface StoreCoverage {
  store: 'apple' | 'google' | 'stripe';
  lastFinal: string | null;          // último día con reporte definitivo
  estimatedDays: string[];           // días con reporte estimado (p. ej. Google del mes en curso)
  missingDays: string[];             // días sin reporte todavía (el Corregido usa el factor de días previos)
}

/** Para [start, end]: por tienda, días reales, estimados y sin reporte. Vacío si no existe la migración 037. */
export async function fetchStoreCoverage(start: string, end: string): Promise<StoreCoverage[]> {
  const supabase = createServerClient();
  const { data, error } = await supabase.rpc('store_coverage', { p_from: start });
  if (error) return [];
  const rows = (data ?? []) as Array<{ store: StoreCoverage['store']; date: string; status: string }>;
  const out: StoreCoverage[] = [];
  for (const store of ['apple', 'google', 'stripe'] as const) {
    const mine = rows.filter((r) => r.store === store && r.date <= end);
    const byDate = new Map(mine.map((r) => [String(r.date), r.status]));
    const finals = mine.filter((r) => r.status === 'final').map((r) => String(r.date)).sort();
    const estimatedDays: string[] = []; const missingDays: string[] = [];
    for (let d = start; d <= end; d = new Date(Date.parse(d + 'T00:00:00Z') + 86_400_000).toISOString().slice(0, 10)) {
      const st = byDate.get(d);
      if (st === 'estimado') estimatedDays.push(d); else if (!st) missingDays.push(d);
    }
    out.push({ store, lastFinal: finals.length ? finals[finals.length - 1] : null, estimatedDays, missingDays });
  }
  return out;
}

export interface GuardSnapshot { ranAt: string; status: 'ok' | 'warn' | 'alarm'; checks: Array<{ id: string; area: string; status: 'ok' | 'warn' | 'alarm'; line: string }> }

/** Última corrida de la Guardia de KPIs (null si la tabla aún no existe). */
export async function fetchLastGuard(): Promise<GuardSnapshot | null> {
  const { data, error } = await createServerClient().from('kpi_guard_runs').select('ran_at,status,checks').order('ran_at', { ascending: false }).limit(1);
  if (error || !data?.length) return null;
  return { ranAt: String(data[0].ran_at), status: data[0].status, checks: data[0].checks };
}

