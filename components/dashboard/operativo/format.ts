import type { KpiValues, Grain } from '@/lib/kpi/replica';

// ─── Formato ─────────────────────────────────────────────────────────────────

export type Fmt = 'usd' | 'usd2' | 'int' | 'pct' | 'x' | 'num1';
export const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
export function fmt(v: number | null | undefined, f: Fmt): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  switch (f) {
    case 'usd': return (v < 0 ? '-$' : '$') + nf0.format(Math.abs(v));
    case 'usd2': return (v < 0 ? '-$' : '$') + nf2.format(Math.abs(v));
    case 'int': return nf0.format(v);
    case 'pct': return nf1.format(v * 100) + '%';
    case 'x': return nf2.format(v) + 'x';
    case 'num1': return nf1.format(v);
  }
}
export const compact = (v: number) => Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : Math.abs(v) >= 1e3 ? `${(v / 1e3).toFixed(0)}K` : `${Math.round(v)}`;
/** Etiquetas cortas para ejes. */
export const tickFmt = (f: Fmt) => (v: number) => f === 'pct' ? `${Math.round(v * 100)}%` : f === 'x' ? `${v.toFixed(1)}x` : f === 'usd' || f === 'usd2' ? `$${compact(v)}` : compact(v);

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - dow);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t.getTime() - y0.getTime()) / 86400000 + 1) / 7);
}
export function periodLabel(p: string, grain: Grain): string {
  const d = new Date(p + 'T00:00:00Z');
  switch (grain) {
    case 'day': return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`;
    case 'week': return `W${isoWeek(d)} · ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
    case 'month': return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    case 'quarter': return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`;
    case 'year': return String(d.getUTCFullYear());
    default: return p;
  }
}

/** Último día del periodo que empieza en `p` (para abrir un periodo de la tabla en detalle). */
export function periodEnd(p: string, grain: Grain): string {
  const d = new Date(p + 'T00:00:00Z');
  if (grain === 'week') d.setUTCDate(d.getUTCDate() + 6);
  else if (grain === 'month') d.setUTCMonth(d.getUTCMonth() + 1, 0);
  else if (grain === 'quarter') d.setUTCMonth(d.getUTCMonth() + 3, 0);
  else if (grain === 'year') d.setUTCMonth(12, 0);
  return d.toISOString().slice(0, 10);
}
/** Granularidad a la que se abre un periodo al darle clic. */
export const FINER: Partial<Record<Grain, Grain>> = { week: 'day', month: 'day', quarter: 'week', year: 'month' };

export const GRAIN_LABELS: Record<Grain, string> = { day: 'Día', week: 'Semana ISO', month: 'Mes', quarter: 'Trimestre', year: 'Año', total: 'Total' };
export const GRAIN_SHORT: Record<Grain, string> = { day: 'día', week: 'semana', month: 'mes', quarter: 'trimestre', year: 'año', total: 'total' };

// ─── Colores (Kinedu) ────────────────────────────────────────────────────────

export const BLUE = '#0086D8', NAVY = '#0E3687', GREEN = '#45C94E', ROSE = '#DA4D7A', GRAY = '#94A3B8', AMBER = '#F59E0B', SLATE = '#CBD5E1';
export const PALETTE = [BLUE, GREEN, NAVY, ROSE, AMBER, '#8B5CF6', '#14B8A6', '#F97316', '#64748B', '#A3E635'];

// ─── Catálogo de KPIs (nombres del Looker) ───────────────────────────────────

export type KpiKey = Exclude<keyof KpiValues, 'calibration'>;
export interface Col { key: KpiKey; label: string; fmt: Fmt; higherIsBetter?: boolean }

/** Todos los KPIs que se pueden explorar, agrupados como en el Looker. */
export const KPI_GROUPS: { group: string; items: Col[] }[] = [
  { group: 'Adquisición', items: [
    { key: 'spend', label: 'Spend', fmt: 'usd', higherIsBetter: false },
    { key: 'signups', label: 'Signups', fmt: 'int', higherIsBetter: true },
    { key: 'cpnu', label: 'CPNU', fmt: 'usd2', higherIsBetter: false },
    { key: 'downloads', label: 'Downloads', fmt: 'int', higherIsBetter: true },
  ] },
  { group: 'Free trials y compras', items: [
    { key: 'ftsStarted', label: 'FTS (fts_started)', fmt: 'int', higherIsBetter: true },
    { key: 'cpft', label: 'CPFT', fmt: 'usd2', higherIsBetter: false },
    { key: 'ftStartRate', label: 'FT start rate', fmt: 'pct', higherIsBetter: true },
    { key: 'ftsConverted', label: 'fts_converted', fmt: 'int', higherIsBetter: true },
    { key: 'newSubs', label: 'New Subs', fmt: 'int', higherIsBetter: true },
    { key: 'purchasesNonFt', label: "Purchases (non FT's)", fmt: 'int', higherIsBetter: true },
    { key: 'renewals', label: 'Renewals', fmt: 'int', higherIsBetter: true },
  ] },
  { group: 'Unit economics', items: [
    { key: 'cac', label: 'CAC', fmt: 'usd2', higherIsBetter: false },
    { key: 'conversionRate', label: 'C.R. (Conversion Rate)', fmt: 'pct', higherIsBetter: true },
    { key: 'convFromFt', label: 'Conv. from FT', fmt: 'pct', higherIsBetter: true },
    { key: 'convFromPurchases', label: 'Conv. from Purchases', fmt: 'pct', higherIsBetter: true },
    { key: 'arpu', label: 'ARPU', fmt: 'usd2', higherIsBetter: true },
    { key: 'arpuMinusCac', label: 'ARPU − CAC', fmt: 'usd2', higherIsBetter: true },
    { key: 'firstTicketCac', label: '1st Ticket / CAC', fmt: 'x', higherIsBetter: true },
    { key: 'usersPerPurchase', label: 'Users per purchase', fmt: 'num1', higherIsBetter: false },
  ] },
  { group: 'Ventas', items: [
    { key: 'nsSales', label: 'NS Sales', fmt: 'usd', higherIsBetter: true },
    { key: 'totalRenewalSales', label: 'Total Renewal Sales', fmt: 'usd', higherIsBetter: true },
    { key: 'totalSales', label: 'Total Sales', fmt: 'usd', higherIsBetter: true },
    { key: 'netSales', label: 'Net Sales', fmt: 'usd', higherIsBetter: true },
  ] },
  { group: 'Margen', items: [
    { key: 'mobileCm', label: 'Mobile CM', fmt: 'usd', higherIsBetter: true },
    { key: 'totalContribution', label: 'Total Contribution', fmt: 'usd', higherIsBetter: true },
    { key: 'contributionMarginPct', label: 'CM / Sales', fmt: 'pct', higherIsBetter: true },
    { key: 'newSubsMargin', label: 'New Subs Margin', fmt: 'pct', higherIsBetter: true },
    { key: 'salesOverSpend', label: 'Sales / Spend', fmt: 'x', higherIsBetter: true },
    { key: 'contributionOverSpend', label: 'Cont / Spend', fmt: 'x', higherIsBetter: true },
  ] },
];
export const KPI_BY_KEY: Record<string, Col> = Object.fromEntries(KPI_GROUPS.flatMap((g) => g.items).map((c) => [c.key, c]));

/** KPIs que dependen de montos de venta: en el Corregido los días recientes son estimados. */
export const MONEY_KEYS = new Set<string>([
  'nsSales', 'renewalsSales', 'renewalsSalesYearlyIos', 'totalRenewalSales', 'otherSales', 'totalSales', 'netSales',
  'mobileCm', 'totalContribution', 'contributionMarginPct', 'newSubsMargin', 'arpu', 'arpuMinusCac', 'firstTicketCac',
  'salesOverSpend', 'newSalesOverSpend', 'newSalesOverSpendNet', 'contributionOverSpend',
]);

export const FUNNEL_COLS: Col[] = [
  { key: 'spend', label: 'spend', fmt: 'usd' }, { key: 'signups', label: 'signups', fmt: 'int', higherIsBetter: true }, { key: 'cpnu', label: 'CPNU', fmt: 'usd2', higherIsBetter: false },
  { key: 'newSubs', label: 'New Subs', fmt: 'int', higherIsBetter: true }, { key: 'cac', label: 'CAC', fmt: 'usd2', higherIsBetter: false }, { key: 'conversionRate', label: 'C.R.', fmt: 'pct', higherIsBetter: true },
  { key: 'ftsStarted', label: 'FTS', fmt: 'int', higherIsBetter: true }, { key: 'cpft', label: 'CPFT', fmt: 'usd2', higherIsBetter: false }, { key: 'nsSales', label: 'NS Sales', fmt: 'usd', higherIsBetter: true },
  { key: 'newSubsMargin', label: 'NS mgn', fmt: 'pct', higherIsBetter: true }, { key: 'arpu', label: 'ARPU', fmt: 'usd2', higherIsBetter: true }, { key: 'firstTicketCac', label: '1stTkt/CAC', fmt: 'x', higherIsBetter: true },
  { key: 'mobileCm', label: 'Cont mbl', fmt: 'usd', higherIsBetter: true }, { key: 'totalContribution', label: 'Cont. Tot', fmt: 'usd', higherIsBetter: true }, { key: 'contributionMarginPct', label: 'CM/Sales', fmt: 'pct', higherIsBetter: true },
];
export const SALES_COLS: Col[] = [
  { key: 'spend', label: 'spend', fmt: 'usd' }, { key: 'signups', label: 'signups', fmt: 'int', higherIsBetter: true }, { key: 'newSubs', label: 'New Subs', fmt: 'int', higherIsBetter: true },
  { key: 'totalSales', label: 'Total Sales', fmt: 'usd', higherIsBetter: true }, { key: 'nsSales', label: 'NS Sales', fmt: 'usd', higherIsBetter: true }, { key: 'totalRenewalSales', label: 'Total Renewal Sales', fmt: 'usd', higherIsBetter: true },
  { key: 'netSales', label: 'Net Sales', fmt: 'usd', higherIsBetter: true }, { key: 'mobileCm', label: 'Mobile CM', fmt: 'usd', higherIsBetter: true }, { key: 'totalContribution', label: 'Total Contribution', fmt: 'usd', higherIsBetter: true },
  { key: 'contributionMarginPct', label: 'CM/Sales', fmt: 'pct', higherIsBetter: true }, { key: 'firstTicketCac', label: '1stTkt/CAC', fmt: 'x', higherIsBetter: true },
];
export const CONVERSION_COLS: Col[] = [
  { key: 'signups', label: 'signups', fmt: 'int', higherIsBetter: true }, { key: 'downloads', label: 'downloads', fmt: 'int', higherIsBetter: true }, { key: 'signupsPerDownload', label: 'signups/downloads', fmt: 'num1' },
  { key: 'ftsStarted', label: 'fts_started', fmt: 'int', higherIsBetter: true }, { key: 'ftStartRate', label: 'FT start rate', fmt: 'pct', higherIsBetter: true }, { key: 'ftsConverted', label: 'fts_converted', fmt: 'int', higherIsBetter: true },
  { key: 'purchasesNonFt', label: "Purchases (non FT's)", fmt: 'int', higherIsBetter: true }, { key: 'convFromFt', label: 'Conv. from FT', fmt: 'pct', higherIsBetter: true }, { key: 'convFromPurchases', label: 'Conv. from Purchases', fmt: 'pct', higherIsBetter: true },
  { key: 'cacFromPurchases', label: 'CAC from Purchases', fmt: 'usd2', higherIsBetter: false }, { key: 'cacFromFt', label: 'CAC from Free Trials', fmt: 'usd2', higherIsBetter: false }, { key: 'cac', label: 'CAC', fmt: 'usd2', higherIsBetter: false },
  { key: 'usersPerPurchase', label: 'Users per purchase', fmt: 'num1', higherIsBetter: false }, { key: 'usersPerFtConverted', label: 'Users per Trial conv.', fmt: 'num1', higherIsBetter: false },
];
export const BREAKDOWN_COLS: Col[] = [
  { key: 'spend', label: 'spend', fmt: 'usd' }, { key: 'signups', label: 'signups', fmt: 'int', higherIsBetter: true }, { key: 'newSubs', label: 'New Subs', fmt: 'int', higherIsBetter: true },
  { key: 'conversionRate', label: 'C.R.', fmt: 'pct', higherIsBetter: true }, { key: 'cac', label: 'CAC', fmt: 'usd2', higherIsBetter: false }, { key: 'arpu', label: 'ARPU', fmt: 'usd2', higherIsBetter: true },
  { key: 'firstTicketCac', label: '1stTkt/CAC', fmt: 'x', higherIsBetter: true }, { key: 'nsSales', label: 'NS Sales', fmt: 'usd', higherIsBetter: true }, { key: 'totalSales', label: 'Total Sales', fmt: 'usd', higherIsBetter: true },
  { key: 'totalContribution', label: 'Total Contribution', fmt: 'usd', higherIsBetter: true }, { key: 'contributionMarginPct', label: 'CM/Sales', fmt: 'pct', higherIsBetter: true },
];
export const SCORECARDS: Col[] = [
  { key: 'spend', label: 'Spend', fmt: 'usd', higherIsBetter: false }, { key: 'signups', label: 'Signups', fmt: 'int', higherIsBetter: true },
  { key: 'newSubs', label: 'New Subs', fmt: 'int', higherIsBetter: true }, { key: 'cac', label: 'CAC', fmt: 'usd2', higherIsBetter: false },
  { key: 'nsSales', label: 'NS Sales', fmt: 'usd', higherIsBetter: true }, { key: 'totalSales', label: 'Total Sales', fmt: 'usd', higherIsBetter: true },
  { key: 'totalContribution', label: 'Total Contribution', fmt: 'usd', higherIsBetter: true }, { key: 'firstTicketCac', label: '1st Ticket / CAC', fmt: 'x', higherIsBetter: true },
];

// ─── CSV ─────────────────────────────────────────────────────────────────────

export function downloadCsv(filename: string, header: string[], rows: (string | number | null | undefined)[][]) {
  const esc = (v: string | number | null | undefined) => {
    if (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [header, ...rows].map((r) => r.map(esc).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
