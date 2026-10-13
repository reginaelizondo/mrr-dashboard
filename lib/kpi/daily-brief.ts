import {
  fetchKPIsByPeriod,
  fetchKPIsByPeriodAndDimension,
  fetchDailySeries,
  fetchTableFreshness,
  emptyValues,
  type KPIValues,
  type NamedPeriod,
  type DailyRow,
} from './brief-queries';
import { KPI_LABELS, type KPIKey } from './formulas';
import {
  todayMx, addDays, isoWeekday, mondayOf,
  dayLabelEs, dayShortEs, rangeShortEs,
} from './period';
import {
  writeBriefNarrative,
  type BriefFacts, type BriefNarrative, type FactComparison, type FactBreakdownRow,
} from './brief-writer';
import type { SlackMessage } from '@/lib/slack/post';

/**
 * Daily KPI brief — "Morning brief KPIs — Kinedu".
 *
 * Structure (mirrors the tech team's daily brief, KPIs only):
 *   Lo más importante → Ayer (vs prom. 7d · vs mismo día sem. pasada) →
 *   Semana en curso (vs mismos días sem. pasada) | lunes: Semana pasada (vs anterior) →
 *   Desglose por plataforma / idioma / país → Qué revisaría hoy → fuente y corte.
 *
 * Every number comes from BigQuery with the validated formulas. The 28-day daily
 * series gives each KPI a noise band (mean ± 1.5 sd); only KPIs outside it get a
 * flag, and the narrative is told to talk only about flagged / money-moving KPIs.
 */

type SlackBlock = NonNullable<SlackMessage['blocks']>[number];

// ---- KPI metadata ---------------------------------------------------------------

/** Additive KPIs: a 7-day window is compared as per-day average. Ratios compare as-is. */
const ADDITIVE: Set<KPIKey> = new Set([
  'spend', 'signups', 'ftsStarted', 'ftsConverted', 'newSubs', 'purchasesNonFt',
  'nsSales', 'totalRenewalSales', 'renewals', 'totalSales', 'netSales',
  'refundsAmount', 'refundsCount', 'mobileCm', 'totalContribution',
  'netSalesLooker', 'mobileCmLooker', 'totalContributionLooker', 'purchasesNonFtLooker',
]);
const LOWER_IS_BETTER: Set<KPIKey> = new Set(['cac', 'cpnu', 'cpft', 'refundsAmount', 'refundsCount']);
const MONEY: Set<KPIKey> = new Set([
  'spend', 'nsSales', 'totalRenewalSales', 'totalSales', 'netSales', 'refundsAmount', 'mobileCm', 'totalContribution',
  'netSalesLooker', 'mobileCmLooker', 'totalContributionLooker',
]);
const MONEY_2DP: Set<KPIKey> = new Set(['cac', 'cpnu', 'cpft', 'arpu']);
const PCT: Set<KPIKey> = new Set(['conversionRate', 'ftStartRate', 'ftConversionRate', 'ftShare', 'contributionMarginPct', 'contributionMarginPctLooker', 'newSubsMargin']);
const RATIO: Set<KPIKey> = new Set(['firstTicketCac']);

/** Who owns each KPI in "Qué revisaría hoy". Anything else → General. */
const ROLE: Partial<Record<KPIKey, string>> = {
  signups: 'Producto/Tech', ftsStarted: 'Producto/Tech', ftStartRate: 'Producto/Tech',
  ftConversionRate: 'Producto/Tech', conversionRate: 'Producto/Tech', newSubs: 'Producto/Tech',
  spend: 'Marketing', cpnu: 'Marketing', cpft: 'Marketing', cac: 'Marketing', firstTicketCac: 'Marketing',
};
const ROLE_HINT: Record<string, string> = {
  'Producto/Tech': 'revisar el funnel in-app (onboarding, trial, paywall) y ver en el desglose qué plataforma o idioma lo explica',
  'Marketing': 'revisar spend y mezcla por canal y plataforma antes de tocar presupuestos',
  'General': 'ver en el desglose qué plataforma, idioma o país explica el movimiento',
};

/** Countries always shown; others only when they move a lot (see pickCountries). */
const CORE_COUNTRIES = ['US', 'BR', 'MX'];
const EXTRA_COUNTRY_MIN_MOVE = 0.25;  // |Δ NS Sales| ≥ 25 % vs base
const EXTRA_COUNTRY_MIN_SHARE = 0.02; // and ≥ 2 % of the period's NS Sales
const EXTRA_COUNTRIES_MAX = 2;

/**
 * KPIs where the brief's (real) definition differs from Looker's. Rendered as a
 * "Discrepancias vs Looker" block so the team can reconcile against the dashboard.
 */
const LOOKER_PAIRS: Array<{ real: KPIKey; looker: KPIKey; why: string }> = [
  { real: 'totalContribution', looker: 'totalContributionLooker', why: 'Looker netea Stripe como Apple/Google dentro de Net Sales y lo vuelve a sumar al 0.965 (doble conteo)' },
  { real: 'netSales', looker: 'netSalesLooker', why: 'Looker netea Stripe con la comisión de Apple/Google (por os) en vez de la de Stripe (0.965)' },
  { real: 'mobileCm', looker: 'mobileCmLooker', why: 'misma causa que Net Sales (Mobile CM = Net Sales − spend)' },
  { real: 'purchasesNonFt', looker: 'purchasesNonFtLooker', why: 'Looker resta sobre new subs netas de refunds; el bot sobre brutas' },
];
const DISCREPANCY_MIN_PCT = 1;

const ACQ_ORDER: KPIKey[] = ['spend', 'signups', 'cpnu', 'ftsStarted', 'ftStartRate', 'cpft', 'ftConversionRate'];
const MON_ORDER: KPIKey[] = [
  'newSubs', 'conversionRate', 'nsSales', 'cac', 'arpu', 'firstTicketCac',
  'totalSales', 'renewals', 'refundsAmount',
];
/** Daily sections. Total Contribution is too lumpy day to day (refund batches) → weekly only. */
const DAY_ORDER: KPIKey[] = [...ACQ_ORDER, ...MON_ORDER];
const WEEK_ORDER: KPIKey[] = [...DAY_ORDER, 'totalContribution'];
/** KPIs with no good/bad direction (spend is a decision, not an outcome). */
const NEUTRAL: Set<KPIKey> = new Set(['spend']);
/** KPIs shown per segment in the breakdown. */
const DIM_KPIS: KPIKey[] = ['newSubs', 'nsSales', 'cac', 'conversionRate'];
/** KPIs whose movement we decompose by segment for the narrative. */
const MOVER_KPIS: KPIKey[] = ['newSubs', 'nsSales', 'spend'];

const OS_SEGMENTS = ['iOS', 'Android'];
const LANG_SEGMENTS = ['en', 'es', 'pt'];

const Z_FLAG = 1.5;        // sd multiples outside the band
const MIN_PCT_FLAG = 0.10; // and at least ±10% vs baseline (±1 pp for rates)

// ---- Formatting -----------------------------------------------------------------

function fmtValue(key: KPIKey, v: number | null): string {
  if (v === null || !Number.isFinite(v)) return 'n/d';
  if (MONEY_2DP.has(key)) return `$${v.toFixed(2)}`;
  if (MONEY.has(key)) return `$${Math.round(v).toLocaleString('en-US')}`;
  if (PCT.has(key)) return `${(v * 100).toFixed(key === 'conversionRate' ? 2 : 1)}%`;
  if (RATIO.has(key)) return `${v.toFixed(2)}x`;
  return Math.round(v).toLocaleString('en-US');
}

function fmtSigned(n: number, digits = 0): string {
  // Round first so −0.4 renders as "0", not "−0".
  const r = Number(n.toFixed(digits));
  const s = Math.abs(r).toFixed(digits);
  return r > 0 ? `+${s}` : r < 0 ? `−${s}` : s;
}

/** Delta between value and baseline, always as % change (rates included — no pp). */
function fmtDelta(key: KPIKey, value: number | null, base: number | null): string | null {
  const rel = relChange(key, value, base);
  return rel === null ? null : `${fmtSigned(rel, 0)}%`;
}

function relChange(_key: KPIKey, value: number | null, base: number | null): number | null {
  if (value === null || base === null || base === 0) return null;
  return ((value - base) / Math.abs(base)) * 100;
}

// ---- Stats ------------------------------------------------------------------------

/**
 * Weekday-seasonal noise band. Daily KPIs swing by weekday (Sunday spend is
 * high, Sunday conversion low), so a plain 28-day mean flags every weekend.
 * Expected value = mean of the same weekday over the window; sd = sd of the
 * residuals (value − weekday mean) across all days.
 */
interface Band { weekdayMean: Array<number | null>; overallMean: number; sd: number; n: number }

function bandFor(series: DailyRow[], key: KPIKey): Band | null {
  const pts = series
    .map((r) => ({ dow: isoWeekday(r.date), v: r[key] }))
    .filter((p): p is { dow: number; v: number } => p.v !== null && Number.isFinite(p.v));
  if (pts.length < 14) return null;
  const overallMean = pts.reduce((a, p) => a + p.v, 0) / pts.length;
  const byDow: number[][] = Array.from({ length: 7 }, () => []);
  for (const p of pts) byDow[p.dow].push(p.v);
  const weekdayMean = byDow.map((xs) => (xs.length >= 2 ? xs.reduce((a, b) => a + b, 0) / xs.length : null));
  const residuals = pts.map((p) => p.v - (weekdayMean[p.dow] ?? overallMean));
  const variance = residuals.reduce((a, r) => a + r * r, 0) / (residuals.length - 1);
  return { weekdayMean, overallMean, sd: Math.sqrt(variance), n: pts.length };
}

function flagFor(key: KPIKey, value: number | null, band: Band | null, dow: number): 'mejor' | 'peor' | null {
  if (value === null || !band || band.sd === 0) return null;
  const expected = band.weekdayMean[dow] ?? band.overallMean;
  const z = (value - expected) / band.sd;
  const rel = relChange(key, value, expected);
  if (rel === null) return null;
  if (Math.abs(z) < Z_FLAG || Math.abs(rel) < MIN_PCT_FLAG * 100) return null;
  const up = value > expected;
  const good = LOWER_IS_BETTER.has(key) ? !up : up;
  return good ? 'mejor' : 'peor';
}

/** Per-day baseline for a multi-day window (additive KPIs) or the window ratio itself. */
function baselineOf(key: KPIKey, window: KPIValues, days: number): number | null {
  const v = window[key];
  if (v === null) return null;
  return ADDITIVE.has(key) ? v / days : v;
}

// ---- Comparison rows -----------------------------------------------------------

interface Comparison {
  key: KPIKey;
  value: number | null;
  base: number | null;
  sameDay: number | null;
  flag: 'mejor' | 'peor' | null;
}

function compareDaily(
  key: KPIKey, y: KPIValues, trailing7: KPIValues, sameDow: KPIValues, band: Band | null, dow: number
): Comparison {
  const base = baselineOf(key, trailing7, 7);
  return { key, value: y[key], base, sameDay: sameDow[key], flag: flagFor(key, y[key], band, dow) };
}

function compareWindows(key: KPIKey, curr: KPIValues, prev: KPIValues): Comparison {
  // Same-length windows → compare totals directly (ratios compare as-is).
  const value = curr[key], base = prev[key];
  const rel = relChange(key, value, base);
  let flag: 'mejor' | 'peor' | null = null;
  if (rel !== null) {
    if (Math.abs(rel) >= 10) {
      const up = (value ?? 0) > (base ?? 0);
      flag = (LOWER_IS_BETTER.has(key) ? !up : up) ? 'mejor' : 'peor';
    }
  }
  return { key, value, base, sameDay: null, flag };
}

function toFact(c: Comparison): FactComparison {
  return {
    kpi: c.key,
    label: KPI_LABELS[c.key],
    value: fmtValue(c.key, c.value),
    vsBaseline: fmtDelta(c.key, c.value, c.base),
    vsSameDay: c.sameDay === null ? null : fmtDelta(c.key, c.value, c.sameDay),
    flag: c.flag,
  };
}

/**
 * Colour dot for a comparison: 🟢 moved in the good direction, 🔴 in the bad one,
 * ⚪ flat (< 1 % / < 0.2 pp) or a KPI with no direction (spend).
 */
function dot(key: KPIKey, value: number | null, base: number | null): string {
  const rel = relChange(key, value, base);
  if (rel === null) return '⚪';
  if (Math.abs(rel) < 1 || NEUTRAL.has(key)) return '⚪';
  const up = rel > 0;
  const good = LOWER_IS_BETTER.has(key) ? !up : up;
  return good ? '🟢' : '🔴';
}

function renderComparisonLine(c: Comparison, baseLabel: string, sameLabel?: string): string {
  const parts = [`*${KPI_LABELS[c.key]}* ${fmtValue(c.key, c.value)}`];
  const d1 = fmtDelta(c.key, c.value, c.base);
  if (d1) parts.push(`${dot(c.key, c.value, c.base)} ${d1} ${baseLabel}`);
  if (sameLabel && c.sameDay !== null) {
    const d2 = fmtDelta(c.key, c.value, c.sameDay);
    if (d2) parts.push(`${dot(c.key, c.value, c.sameDay)} ${d2} ${sameLabel}`);
  }
  const mark = c.flag ? '  ‼️' : '';
  return `• ${parts.join('  ·  ')}${mark}`;
}

// ---- Breakdown -----------------------------------------------------------------

interface SegmentRow {
  segment: string;
  curr: KPIValues;
  base: KPIValues;   // already per-day for additive if daily mode
}

function segmentRows(
  curr: Record<string, KPIValues>,
  base: Record<string, KPIValues>,
  segments: string[],
  baseDays: number
): SegmentRow[] {
  return segments.map((s) => {
    const b = base[s] ?? emptyValues();
    const scaled = { ...b } as KPIValues;
    if (baseDays !== 1) {
      for (const k of Object.keys(scaled) as KPIKey[]) {
        if (ADDITIVE.has(k) && scaled[k] !== null) scaled[k] = (scaled[k] as number) / baseDays;
      }
    }
    return { segment: s, curr: curr[s] ?? emptyValues(), base: scaled };
  });
}

/**
 * US · BR · MX always; any other country only when its NS Sales moved ≥ 25 % vs
 * the base AND it weighs ≥ 2 % of the period's NS Sales (max 2, biggest move first).
 */
function pickCountries(curr: Record<string, KPIValues>, base: Record<string, KPIValues>, baseDays: number, minSubs: number): { list: string[]; extras: Set<string> } {
  const total = Object.values(curr).reduce((a, v) => a + (v.nsSales ?? 0), 0);
  const extras = Object.keys(curr)
    .filter((c) => !CORE_COUNTRIES.includes(c) && c !== '(null)' && c !== 'Unknown')
    .map((c) => {
      const v = curr[c].nsSales ?? 0;
      const b = (base[c]?.nsSales ?? 0) / baseDays;
      const rel = b > 0 ? (v - b) / b : null;
      return { c, v, rel, subs: curr[c].newSubs ?? 0 };
    })
    .filter((x) => x.rel !== null && Math.abs(x.rel) >= EXTRA_COUNTRY_MIN_MOVE && total > 0 && x.v / total >= EXTRA_COUNTRY_MIN_SHARE && x.subs >= minSubs)
    .sort((a, b) => Math.abs(b.rel as number) - Math.abs(a.rel as number))
    .slice(0, EXTRA_COUNTRIES_MAX)
    .map((x) => x.c);
  return { list: [...CORE_COUNTRIES, ...extras], extras: new Set(extras) };
}

function renderSegmentLine(r: SegmentRow, suffix = ''): string {
  const cells = DIM_KPIS.map((k) => {
    const d = fmtDelta(k, r.curr[k], r.base[k]);
    const short = k === 'newSubs' ? 'subs' : k === 'nsSales' ? 'NS' : k === 'cac' ? 'CAC' : 'conv';
    return `${short} ${fmtValue(k, r.curr[k])}${d ? ` (${dot(k, r.curr[k], r.base[k])} ${d})` : ''}`;
  });
  return `• *${r.segment}*: ${cells.join(' · ')}${suffix}`;
}

function toBreakdownFacts(rows: SegmentRow[]): FactBreakdownRow[] {
  return rows.map((r) => ({
    segment: r.segment,
    metrics: Object.fromEntries(
      DIM_KPIS.map((k) => [k, { value: fmtValue(k, r.curr[k]), delta: fmtDelta(k, r.curr[k], r.base[k]) }])
    ),
  }));
}

/** For each mover KPI, which segment (across all dims) contributes the largest absolute delta. */
function findMovers(dims: Array<{ label: string; rows: SegmentRow[] }>, baseLabel: string): string[] {
  const out: string[] = [];
  for (const k of MOVER_KPIS) {
    let best: { seg: string; dim: string; delta: number } | null = null;
    for (const d of dims) {
      for (const r of d.rows) {
        const v = r.curr[k], b = r.base[k];
        if (v === null || b === null) continue;
        const delta = v - b;
        if (!best || Math.abs(delta) > Math.abs(best.delta)) best = { seg: r.segment, dim: d.label, delta };
      }
    }
    if (best && best.delta !== 0) {
      const sign = best.delta > 0 ? '+' : '−';
      const mag = MONEY.has(k) ? `$${Math.round(Math.abs(best.delta)).toLocaleString('en-US')}` : Math.round(Math.abs(best.delta)).toLocaleString('en-US');
      out.push(`${KPI_LABELS[k]}: el mayor movimiento es ${best.seg} (${best.dim}) ${sign}${mag} ${baseLabel}`);
    }
  }
  return out;
}

// ---- Discrepancies vs Looker ------------------------------------------------------

interface Discrepancy { label: string; real: string; looker: string; diff: string; why: string }

function findDiscrepancies(v: KPIValues): Discrepancy[] {
  const out: Discrepancy[] = [];
  for (const p of LOOKER_PAIRS) {
    const r = v[p.real], l = v[p.looker];
    if (r === null || l === null || r === 0) continue;
    const pct = ((l - r) / Math.abs(r)) * 100;
    if (Math.abs(pct) < DISCREPANCY_MIN_PCT) continue;
    out.push({
      label: KPI_LABELS[p.real],
      real: fmtValue(p.real, r),
      looker: fmtValue(p.looker, l),
      diff: `${fmtSigned(pct, 0)}%`,
      why: p.why,
    });
  }
  return out;
}

// ---- Narrative fallback ---------------------------------------------------------

/** Who should look at a KPI that left its band, and where. */
function actionFor(c: Comparison, sameLabel: string): string {
  const k = c.key;
  const d7 = fmtDelta(k, c.value, c.base) ?? '';
  const dd = c.sameDay === null ? '' : ` · ${fmtDelta(k, c.value, c.sameDay)} ${sameLabel}`;
  const v = `${KPI_LABELS[k]} ${fmtValue(k, c.value)} (${d7} vs prom. 7d${dd})`;
  const role = ROLE[k] ?? 'General';
  if (c.flag === 'mejor') {
    return `${role}: ${v} — confirmar que se sostiene 2–3 días antes de leerlo como tendencia.`;
  }
  if (k === 'refundsAmount' || k === 'refundsCount') {
    return `${role}: ${v} — revisar refunds por SKU y tienda en el dashboard de refunds.`;
  }
  if (k === 'renewals' || k === 'totalRenewalSales') {
    return `${role}: ${v} — confirmar si es calendario de renovaciones (cohortes anuales) o churn.`;
  }
  return `${role}: ${v} — ${ROLE_HINT[role]}.`;
}

function buildFallbackNarrative(
  daily: Comparison[], weekly: Comparison[] | null, movers: string[], sameLabel: string
): BriefNarrative {
  const flagged = daily.filter((c) => c.flag);
  const worse = flagged.filter((c) => c.flag === 'peor');
  const better = flagged.filter((c) => c.flag === 'mejor');
  const describe = (c: Comparison) => `${KPI_LABELS[c.key]} *${fmtValue(c.key, c.value)}* (${fmtDelta(c.key, c.value, c.base) ?? ''} vs prom. 7d)`;

  const parts: string[] = [];
  if (flagged.length === 0) {
    parts.push('Ayer dentro de rango: ningún KPI operativo salió de su banda estacional de 28 días. `FACT`');
  } else {
    if (worse.length) parts.push('🔴 Ayer, fuera de banda a la baja: ' + worse.slice(0, 3).map(describe).join('; ') + '. `FACT`');
    if (better.length) parts.push('🟢 A favor: ' + better.slice(0, 2).map(describe).join('; ') + '. `FACT`');
  }
  // Weekly movers go into the headline itself (not a loose comment under the table).
  const weekFlag = weekly?.filter((c) => c.flag) ?? [];
  if (weekFlag.length) {
    parts.push('Semana: ' + weekFlag.slice(0, 3).map((c) => `${dot(c.key, c.value, c.base)} ${KPI_LABELS[c.key]} *${fmtValue(c.key, c.value)}* (${fmtDelta(c.key, c.value, c.base)})`).join(', ') + '. `FACT`');
  }
  const comentarioSemana = undefined;
  const comentarioDesglose = movers.length ? movers.slice(0, 2).join('. ') + '. `FACT`' : undefined;

  // One action per role, worst first, max 4.
  const seenRole = new Set<string>();
  const acciones: string[] = [];
  for (const c of [...worse, ...better]) {
    const a = actionFor(c, sameLabel);
    const role = a.split(':')[0];
    if (seenRole.has(role)) continue;
    seenRole.add(role);
    acciones.push(a);
    if (acciones.length === 4) break;
  }

  return {
    loMasImportante: parts.join(' '),
    comentarioSemana,
    comentarioDesglose,
    queRevisariaHoy: acciones.length ? acciones : ['Nada fuera de banda; sin acciones pendientes.'],
  };
}

// ---- Main builder -----------------------------------------------------------------

export interface DailyBriefOptions {
  /** Override "today" (YYYY-MM-DD, MX). Default: now in Mexico City. */
  today?: string;
  /** Force (or suppress) the weekly section. Default: Mondays only. */
  weekly?: boolean;
  /** Skip the Claude narrative and use the rule-based fallback. */
  skipNarrative?: boolean;
  /** Mark the message as a preview (title suffix) — for test posts. */
  preview?: boolean;
}

export interface DailyBriefResult {
  message: SlackMessage;
  text: string;          // plain-text rendering (for dry runs / logs)
  facts: BriefFacts;
  narrative: BriefNarrative;
  narrativeSource: 'claude' | 'fallback';
}

export async function buildDailyBrief(opts: DailyBriefOptions = {}): Promise<DailyBriefResult> {
  const today = opts.today ?? todayMx();
  const y = addDays(today, -1);
  const weekly = opts.weekly ?? isoWeekday(today) === 0;

  // Periods
  const t7 = { key: 'trailing7', start: addDays(y, -7), end: addDays(y, -1) };
  const wtdStart = mondayOf(y);
  const wtdDays = isoWeekday(y) + 1;
  const showWtd = !weekly && wtdDays >= 2;
  const lwEnd = addDays(mondayOf(today), -1);
  const lwStart = addDays(lwEnd, -6);
  const periods: NamedPeriod[] = [
    { key: 'yesterday', start: y, end: y },
    { key: 'sameDow', start: addDays(y, -7), end: addDays(y, -7) },
    t7,
    { key: 'wtd', start: wtdStart, end: y },
    { key: 'wtdPrior', start: addDays(wtdStart, -7), end: addDays(y, -7) },
    { key: 'lastWeek', start: lwStart, end: lwEnd },
    { key: 'priorWeek', start: addDays(lwStart, -7), end: addDays(lwEnd, -7) },
  ];

  const [totals, byOs, byLang, byCountry, series, freshness] = await Promise.all([
    fetchKPIsByPeriod(periods),
    fetchKPIsByPeriodAndDimension(periods, 'os'),
    fetchKPIsByPeriodAndDimension(periods, 'kinedu_language'),
    fetchKPIsByPeriodAndDimension(periods, 'country'),
    fetchDailySeries(addDays(y, -28), addDays(y, -1)),
    fetchTableFreshness(),
  ]);

  // Weekday-seasonal noise bands from the 28 days before yesterday
  const bands = new Map<KPIKey, Band | null>();
  for (const k of WEEK_ORDER) bands.set(k, bandFor(series, k));

  // Daily comparisons
  const yDow = isoWeekday(y);
  const daily = DAY_ORDER.map((k) => compareDaily(k, totals.yesterday, totals.trailing7, totals.sameDow, bands.get(k) ?? null, yDow));
  const dailyAcq = daily.filter((c) => ACQ_ORDER.includes(c.key));
  const dailyMon = daily.filter((c) => MON_ORDER.includes(c.key));

  // Week comparisons
  const wtd = showWtd ? WEEK_ORDER.map((k) => compareWindows(k, totals.wtd, totals.wtdPrior)) : null;
  const week = weekly ? WEEK_ORDER.map((k) => compareWindows(k, totals.lastWeek, totals.priorWeek)) : null;

  // Breakdown: weekly mode compares last week vs prior week; daily mode yesterday vs trailing-7 avg
  const currKey = weekly ? 'lastWeek' : 'yesterday';
  const baseKey = weekly ? 'priorWeek' : 'trailing7';
  const baseDays = weekly ? 1 : 7;
  const baseLabelShort = weekly ? 'vs sem. anterior' : 'vs prom. 7d';
  const osRows = segmentRows(byOs[currKey], byOs[baseKey], OS_SEGMENTS, baseDays);
  const langRows = segmentRows(byLang[currKey], byLang[baseKey], LANG_SEGMENTS, baseDays);
  // A country only "enters by movement" with real volume: ≥ 30 subs in a week, ≥ 10 in a day.
  const picked = pickCountries(byCountry[currKey], byCountry[baseKey], baseDays, weekly ? 30 : 10);
  const countries = picked.list;
  const countryRows = segmentRows(byCountry[currKey], byCountry[baseKey], countries, baseDays);
  const movers = findMovers(
    [{ label: 'plataforma', rows: osRows }, { label: 'idioma', rows: langRows }, { label: 'país', rows: countryRows }],
    baseLabelShort
  );

  // Data notes
  const notas: string[] = [];
  if (freshness) {
    const mx = new Date(new Date(freshness).getTime() - 6 * 3600 * 1000);
    notas.push(`Corte de datos: ${mx.toISOString().slice(0, 16).replace('T', ' ')} MX (último rebuild de an_operational_dash).`);
  }
  notas.push('Los refunds atribuidos a fecha de venta siguen cayendo ~2 semanas; New Subs y NS Sales de los últimos días pueden bajar ligeramente al madurar.');
  if (wtd) notas.push(`Semana en curso lleva ${wtdDays} día(s); se compara con los mismos ${wtdDays} día(s) de la semana pasada.`);

  // Discrepancies vs Looker (real definition vs the dashboard's), for the headline period
  const discPeriodKey = weekly ? 'lastWeek' : 'yesterday';
  const discPeriodLabel = weekly ? `semana pasada (${rangeShortEs(lwStart, lwEnd)})` : `ayer (${dayShortEs(y)})`;
  const discrepancies = findDiscrepancies(totals[discPeriodKey]);
  for (const d of discrepancies) {
    notas.push(`Discrepancia vs Looker en ${d.label} (${discPeriodLabel}): real ${d.real}, Looker ${d.looker} (${d.diff}) — ${d.why}. El brief usa la definición real.`);
  }

  // Facts for the writer
  const facts: BriefFacts = {
    fecha: dayLabelEs(today),
    ayer: {
      dia: dayShortEs(y),
      comparadoCon: `promedio diario de los 7 días previos (${rangeShortEs(t7.start, t7.end)}) y mismo día de la semana pasada (${dayShortEs(addDays(y, -7))})`,
      kpis: daily.map(toFact),
    },
    semanaEnCurso: wtd ? {
      rango: rangeShortEs(wtdStart, y), dias: wtdDays,
      comparadoCon: `mismos ${wtdDays} días de la semana pasada`,
      kpis: wtd.map(toFact),
    } : undefined,
    semanaPasada: week ? {
      rango: rangeShortEs(lwStart, lwEnd),
      comparadoCon: `semana anterior (${rangeShortEs(addDays(lwStart, -7), addDays(lwEnd, -7))})`,
      kpis: week.map(toFact),
    } : undefined,
    desglose: {
      base: weekly ? 'semana pasada vs semana anterior' : 'ayer vs promedio diario de los 7 días previos',
      plataforma: toBreakdownFacts(osRows),
      idioma: toBreakdownFacts(langRows),
      pais: toBreakdownFacts(countryRows),
    },
    movers,
    notasDeDatos: notas,
  };

  // Narrative. DAILY_BRIEF_NARRATIVE=off skips the Claude call entirely (decided
  // 2026-10-12: brief only, no API credit) — the rule-based narrative is used.
  // Remove the env var (or set it to anything else) to turn Claude back on.
  let narrative: BriefNarrative | null = null;
  const narrativeOff = process.env.DAILY_BRIEF_NARRATIVE === 'off';
  if (!opts.skipNarrative && !narrativeOff) narrative = await writeBriefNarrative(facts);
  const narrativeSource: 'claude' | 'fallback' = narrative ? 'claude' : 'fallback';
  const sameLabel = `vs ${dayShortEs(addDays(y, -7))}`;
  narrative ??= buildFallbackNarrative(daily, week ?? wtd, movers, sameLabel);

  // ---- Render -------------------------------------------------------------------
  const title = `Morning brief KPIs — Kinedu — ${dayLabelEs(today)}${opts.preview ? ' · vista previa' : ''}`;
  const blocks: SlackBlock[] = [];
  const textParts: string[] = [title, ''];

  const section = (md: string) => {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: md.slice(0, 2900) } });
    textParts.push(md, '');
  };

  blocks.push({ type: 'header', text: { type: 'plain_text', text: title.slice(0, 150) } });

  section(`*Lo más importante*\n${narrative.loMasImportante}`);

  section(
    `*Ayer — ${dayShortEs(y)}*  _(vs prom. 7d · ${sameLabel})_\n` +
    (narrative.comentarioAyer ? `${narrative.comentarioAyer}\n` : '') +
    `_Adquisición_\n` + dailyAcq.map((c) => renderComparisonLine(c, 'vs prom. 7d', sameLabel)).join('\n')
  );
  section(`_Monetización_\n` + dailyMon.map((c) => renderComparisonLine(c, 'vs prom. 7d', sameLabel)).join('\n'));

  if (wtd) {
    section(
      `*Semana en curso — ${rangeShortEs(wtdStart, y)} (${wtdDays} días)*  _(vs mismos días de la semana pasada)_\n` +
      (narrative.comentarioSemana ? `${narrative.comentarioSemana}\n` : '') +
      wtd.map((c) => renderComparisonLine(c, 'vs sem. pasada')).join('\n')
    );
  }
  if (week) {
    section(
      `*Semana pasada — ${rangeShortEs(lwStart, lwEnd)}*  _(vs ${rangeShortEs(addDays(lwStart, -7), addDays(lwEnd, -7))})_\n` +
      (narrative.comentarioSemana ? `${narrative.comentarioSemana}\n` : '') +
      week.map((c) => renderComparisonLine(c, 'vs sem. anterior')).join('\n')
    );
  }

  const bdTitle = weekly ? 'semana pasada vs anterior' : 'ayer vs prom. 7d';
  section(
    `*Desglose — ${bdTitle}*  _(subs · NS Sales · CAC · conv)_\n` +
    (narrative.comentarioDesglose ? `${narrative.comentarioDesglose}\n` : '') +
    `_Plataforma_\n${osRows.map((r) => renderSegmentLine(r)).join('\n')}\n` +
    `_Idioma_\n${langRows.map((r) => renderSegmentLine(r)).join('\n')}`
  );
  section(
    `_País (US · BR · MX${picked.extras.size ? ' + movimientos relevantes' : ''})_\n` +
    countryRows.map((r) => renderSegmentLine(r, picked.extras.has(r.segment) ? '  ← entra por movimiento' : '')).join('\n')
  );

  section(`*Qué revisaría hoy*\n` + narrative.queRevisariaHoy.map((a, i) => `${i + 1}. ${a}`).join('\n'));

  section(`*En resumen*\n${narrative.loMasImportante}`);

  // One discreet line while Looker still carries the old definition (removed
  // automatically once the dashboard matches: the pair stops differing ≥ 1 %).
  const tcDisc = discrepancies.find((d) => d.label === KPI_LABELS.totalContribution);
  if (tcDisc && weekly) {
    section(`_Nota: Total Contribution usa la definición corregida (Stripe a su comisión, sin doble conteo). Looker hoy, ${discPeriodLabel}: ${tcDisc.looker}._`);
  }

  const footer = `Fuente: \`an_operational_dash\` (BigQuery) · ${notas[0] ?? ''} · 🟢/🔴 mejor/peor que la base · ⚪ sin cambio · ‼️ fuera de la banda de 28 días · 🤖 KPI Bot${narrativeSource === 'fallback' ? ' · narrativa automática' : ''}`;
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: footer.slice(0, 2900) }] });
  textParts.push(footer);

  return {
    message: { text: `${title} — ${narrative.loMasImportante.slice(0, 180)}`, blocks },
    text: textParts.join('\n'),
    facts,
    narrative,
    narrativeSource,
  };
}
