import {
  fetchKPIsByPeriod,
  fetchKPIsByPeriodAndDimension,
  fetchDailySeries,
  fetchTableFreshness,
  fetchCohortConversion,
  emptyValues,
  type CohortWeek,
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
import type { SlackMessage, SlackFile } from '@/lib/slack/post';
import { tableBlock, tableToMrkdwn } from '@/lib/slack/table';
import { buildBriefCharts } from './brief-charts';

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

/** How each ratio KPI decomposes, for the "por qué se movió" lines. */
const RATIO_PARTS: Partial<Record<KPIKey, { num: KPIKey; den: KPIKey }>> = {
  cac: { num: 'spend', den: 'newSubs' },
  cpnu: { num: 'spend', den: 'signups' },
  cpft: { num: 'spend', den: 'ftsStarted' },
  conversionRate: { num: 'newSubs', den: 'signups' },
  ftStartRate: { num: 'ftsStarted', den: 'signups' },
  ftConversionRate: { num: 'ftsConverted', den: 'ftsStarted' },
  arpu: { num: 'nsSales', den: 'newSubs' },
  firstTicketCac: { num: 'arpu', den: 'cac' },
};
/** KPIs shown in the 4-week trend block. */
const TREND_KPIS: KPIKey[] = ['signups', 'ftsStarted', 'ftConversionRate', 'newSubs', 'conversionRate', 'cac', 'nsSales'];

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
  { real: 'totalContribution', looker: 'totalContributionLooker', why: 'Looker resta dos veces los reembolsos de Stripe (las ventas netas ya los excluyen y el término de reembolsos los vuelve a restar)' },
  { real: 'netSales', looker: 'netSalesLooker', why: 'Looker resta dos veces los reembolsos de Stripe (las ventas netas ya los excluyen y el término de reembolsos los vuelve a restar)' },
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
/** The six KPIs in the executive traffic light (main message). */
const SEMAFORO_KPIS: KPIKey[] = ['spend', 'newSubs', 'conversionRate', 'cac', 'nsSales', 'ftConversionRate'];
/** KPIs whose movement we decompose by segment for the narrative. */
const MOVER_KPIS: KPIKey[] = ['newSubs', 'nsSales', 'spend'];

const OS_SEGMENTS = ['iOS', 'Android'];
const LANG_SEGMENTS = ['en', 'es', 'pt'];

/** Alerta semanal por OS: última semana completa vs las 4 previas (ratios = cociente de las sumas). */
const OS_WEEKLY_KPIS: KPIKey[] = ['conversionRate', 'cac', 'newSubs'];
const OS_WEEKLY_PRIOR = ['priorWeek', 'week3', 'week4', 'week5'];
const OS_WEEKLY_MIN_PCT = 10;   // ±10 % vs la base
const OS_WEEKLY_MIN_SUBS = 50;  // la base necesita ≥ 50 New Subs por semana; si no, es ruido
/** Cohorte de signup: la última semana cuyos signups ya cumplieron 8 días + las 4 previas. */
const COHORT_WEEKS = 5;
/** Semanas de cohorte que se leen (12 para la gráfica; la alerta usa las últimas COHORT_WEEKS). */
const COHORT_FETCH_WEEKS = 12;
const COHORT_MIN_SIGNUPS = 1000;

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

// ---- Why did it move? (deterministic decomposition of flagged KPIs) ---------------

interface Dim { label: string; rows: SegmentRow[] }

function pctShare(part: number, whole: number): string {
  return whole === 0 ? '—' : `${Math.round((part / whole) * 100)}%`;
}

/** Human name for a segment in prose ("en" alone reads badly in a sentence). */
const LANG_NAMES: Record<string, string> = { en: 'inglés', es: 'español', pt: 'portugués' };
function segName(seg: string, dimLabel: string): string {
  return dimLabel === 'idioma' ? (LANG_NAMES[seg] ?? seg) : seg;
}

/**
 * One or two sentences explaining a flagged KPI from the data we already have:
 *  - ratio KPIs: which component moved (numerator vs denominator) + the segment
 *    with the biggest weighted own-move;
 *  - additive KPIs: the segment that contributes most of the total delta.
 * `base` must already be a per-day baseline in daily mode.
 */
function explainMove(c: Comparison, curr: KPIValues, baseScaled: KPIValues, dims: Dim[]): string | null {
  const k = c.key;
  if (c.value === null || c.base === null) return null;
  const parts: string[] = [];

  const rp = RATIO_PARTS[k];
  if (rp) {
    const dNum = relChange(rp.num, curr[rp.num], baseScaled[rp.num]);
    const dDen = relChange(rp.den, curr[rp.den], baseScaled[rp.den]);
    if (dNum !== null && dDen !== null) {
      const dominant = Math.abs(dNum) >= Math.abs(dDen) ? rp.num : rp.den;
      parts.push(`${KPI_LABELS[rp.num]} ${fmtSigned(dNum, 0)}%, ${KPI_LABELS[rp.den]} ${fmtSigned(dDen, 0)}% → el movimiento viene de ${KPI_LABELS[dominant]}`);
    }
    // Segment with the largest own move, weighted by its share of the denominator.
    let best: { seg: string; dim: string; w: number; r: number; v: number | null } | null = null;
    const denTotal = curr[rp.den] ?? 0;
    for (const d of dims.slice(0, 2)) {
      for (const row of d.rows) {
        const r = relChange(k, row.curr[k], row.base[k]);
        const w = denTotal > 0 ? (row.curr[rp.den] ?? 0) / denTotal : 0;
        if (r === null || w < 0.1) continue;
        const score = w * Math.abs(r);
        if (!best || score > best.w * Math.abs(best.r)) best = { seg: row.segment, dim: d.label, w, r, v: row.curr[k] };
      }
    }
    if (best && Math.abs(best.r) >= 3) {
      parts.push(`${segName(best.seg, best.dim)} (${best.dim}, ${pctShare(best.w, 1)} de ${KPI_LABELS[rp.den]}): ${fmtValue(k, best.v)} (${dot(k, best.v, (best.v as number) / (1 + best.r / 100))} ${fmtSigned(best.r, 0)}%)`);
    }
    return parts.length ? parts.join('. ') : null;
  }

  // Additive: who contributes most of the delta, per dimension (only if ≥ 30 %).
  const dTotal = c.value - c.base;
  if (dTotal === 0) return null;
  const bits: string[] = [];
  for (const d of dims) {
    let best: { seg: string; delta: number } | null = null;
    for (const row of d.rows) {
      const v = row.curr[k], b = row.base[k];
      if (v === null || b === null) continue;
      const delta = v - b;
      if (Math.sign(delta) !== Math.sign(dTotal)) continue;
      if (!best || Math.abs(delta) > Math.abs(best.delta)) best = { seg: row.segment, delta };
    }
    if (best && Math.abs(best.delta / dTotal) >= 0.3) {
      const amt = MONEY.has(k) ? `$${Math.round(Math.abs(best.delta)).toLocaleString('en-US')}` : Math.round(Math.abs(best.delta)).toLocaleString('en-US');
      const share = best.delta / dTotal;
      const how = share >= 0.97 ? 'lo explica por completo' : `explica ${pctShare(best.delta, dTotal)} del movimiento`;
      bits.push(`${segName(best.seg, d.label)} (${d.label}) ${how} (${best.delta < 0 ? '−' : '+'}${amt})`);
    }
    if (bits.length === 2) break;
  }
  return bits.length ? bits.join('; ') : null;
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
  daily: Comparison[], weekly: Comparison[] | null, movers: string[], sameLabel: string, osAlerts: OsWeekly[] = []
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
  if (osAlerts.length) parts.push('Por OS, semana vs las 4 previas: ' + osAlerts.map(osWeeklyHeadline).join('; ') + '. `FACT`');
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
  for (const o of osAlerts) {
    if (acciones.length >= 4) break;
    acciones.push(`Marketing/Producto: revisar ${o.os} — ${o.lines.filter((l) => l.flag === 'peor').map((l) => `${SHORT_LABEL[l.key]} ${fmtValue(l.key, l.value)}`).join(', ') || 'conversión de la cohorte'}; ver qué campañas trajeron los signups de la semana y si convierten menos (calidad del tráfico) o si cambió algo en el paywall.`);
  }

  return {
    loMasImportante: parts.join(' '),
    comentarioSemana,
    comentarioDesglose,
    queRevisariaHoy: acciones.length ? acciones : ['Nada fuera de banda; sin acciones pendientes.'],
  };
}

// ---- Alerta semanal por OS ---------------------------------------------------------

type Flag = 'mejor' | 'peor' | null;
interface OsWeeklyLine { key: KPIKey; value: number | null; base: number | null; flag: Flag }
interface OsWeekly {
  os: string;
  lines: OsWeeklyLine[];
  cohort: { week: string; rate: number; base: number; flag: Flag } | null;
  status: Flag; // 'peor' si algo empeoró, 'mejor' si solo mejoró, null si todo en rango
}

function sumOf(vals: Array<number | null>): number {
  return vals.reduce<number>((a, v) => a + (v ?? 0), 0);
}

/** Base de las 4 semanas previas: promedio semanal para conteos; cociente de las sumas para ratios. */
function priorBase(key: KPIKey, prior: KPIValues[]): number | null {
  if (!prior.length) return null;
  const parts = RATIO_PARTS[key];
  if (parts && ADDITIVE.has(parts.num) && ADDITIVE.has(parts.den)) {
    const den = sumOf(prior.map((p) => p[parts.den]));
    return den ? sumOf(prior.map((p) => p[parts.num])) / den : null;
  }
  const vals = prior.map((p) => p[key]).filter((v): v is number => v !== null);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

function flagOf(key: KPIKey, value: number | null, base: number | null): Flag {
  const rel = relChange(key, value, base);
  // Se compara ya redondeado, igual que se muestra: un "−10%" siempre sale marcado.
  if (rel === null || Math.round(Math.abs(rel)) < OS_WEEKLY_MIN_PCT) return null;
  return (LOWER_IS_BETTER.has(key) ? rel < 0 : rel > 0) ? 'mejor' : 'peor';
}

function osWeeklyCheck(byOs: Record<string, Record<string, KPIValues>>, cohorts: Record<string, CohortWeek[]> | null): OsWeekly[] {
  return OS_SEGMENTS.map((os) => {
    const cur = byOs.lastWeek?.[os];
    const prior = OS_WEEKLY_PRIOR.map((k) => byOs[k]?.[os]).filter((v): v is KPIValues => !!v);
    const enough = (priorBase('newSubs', prior) ?? 0) >= OS_WEEKLY_MIN_SUBS;
    const lines = OS_WEEKLY_KPIS.map((key) => {
      const value = cur?.[key] ?? null; const base = priorBase(key, prior);
      return { key, value, base, flag: enough ? flagOf(key, value, base) : null };
    });
    let cohort: OsWeekly['cohort'] = null;
    const cw = (cohorts?.[os] ?? []).slice(-COHORT_WEEKS);
    const last = cw[cw.length - 1]; const prev = cw.slice(0, -1);
    const prevSignups = sumOf(prev.map((c) => c.signups));
    if (last?.rate != null && prev.length && prevSignups && last.signups >= COHORT_MIN_SIGNUPS) {
      const base = sumOf(prev.map((c) => c.converted)) / prevSignups;
      cohort = { week: last.week, rate: last.rate, base, flag: flagOf('conversionRate', last.rate, base) };
    }
    const flags = [...lines.map((l) => l.flag), cohort?.flag ?? null];
    return { os, lines, cohort, status: flags.includes('peor') ? 'peor' : flags.includes('mejor') ? 'mejor' : null };
  });
}

const flagDot = (f: Flag) => (f === 'peor' ? '🔴' : f === 'mejor' ? '🟢' : '⚪');
const SHORT_LABEL: Partial<Record<KPIKey, string>> = { conversionRate: 'C.R.', cac: 'CAC', newSubs: 'New Subs' };

function renderOsWeekly(o: OsWeekly): string {
  const metric = (l: OsWeeklyLine) => `${flagDot(l.flag)} ${SHORT_LABEL[l.key] ?? KPI_LABELS[l.key]} *${fmtValue(l.key, l.value)}* (${fmtDelta(l.key, l.value, l.base) ?? 'n/d'} vs ${fmtValue(l.key, l.base)})`;
  const lines = [`• *${o.os}* ${flagDot(o.status)}  ` + o.lines.map(metric).join(' · ')];
  if (o.cohort) {
    lines.push(`      ↳ ${flagDot(o.cohort.flag)} Cohorte de signups del ${dayShortEs(o.cohort.week)}: compró a los 8 días *${(o.cohort.rate * 100).toFixed(2)}%* (${fmtDelta('conversionRate', o.cohort.rate, o.cohort.base) ?? 'n/d'} vs ${(o.cohort.base * 100).toFixed(2)}% de las 4 cohortes previas)`);
  }
  return lines.join('\n');
}

/** Resumen corto para "Lo más importante" (solo lo que empeoró). */
function osWeeklyHeadline(o: OsWeekly): string {
  const bad = o.lines.filter((l) => l.flag === 'peor').map((l) => `${SHORT_LABEL[l.key]} ${fmtValue(l.key, l.value)} (${fmtDelta(l.key, l.value, l.base)})`);
  if (o.cohort?.flag === 'peor') bad.push(`cohorte del ${dayShortEs(o.cohort.week)} a 8 días ${(o.cohort.rate * 100).toFixed(2)}% (${fmtDelta('conversionRate', o.cohort.rate, o.cohort.base)})`);
  return `${o.os} 🔴 ${bad.join(', ')}`;
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
  message: SlackMessage;      // main (executive) message
  thread: SlackMessage[];     // detail replies, posted in a thread under `message`
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
    { key: 'week3', start: addDays(lwStart, -14), end: addDays(lwEnd, -14) },
    { key: 'week4', start: addDays(lwStart, -21), end: addDays(lwEnd, -21) },
    { key: 'week5', start: addDays(lwStart, -28), end: addDays(lwEnd, -28) },
  ];
  // Última cohorte de signup cuyos signups ya cumplieron 8 días (el domingo de esa semana + 7 ≤ ayer).
  const lastCohortWeek = mondayOf(addDays(y, -13));
  const trendKeys = ['week4', 'week3', 'priorWeek', 'lastWeek']; // oldest → newest

  const [totals, byOs, byLang, byCountry, series, freshness, cohorts] = await Promise.all([
    fetchKPIsByPeriod(periods),
    fetchKPIsByPeriodAndDimension(periods, 'os'),
    fetchKPIsByPeriodAndDimension(periods, 'kinedu_language'),
    fetchKPIsByPeriodAndDimension(periods, 'country'),
    fetchDailySeries(addDays(y, -28), addDays(y, -1)),
    fetchTableFreshness(),
    fetchCohortConversion(lastCohortWeek, COHORT_FETCH_WEEKS).catch((e) => { console.error('[brief] cohortes no disponibles:', e instanceof Error ? e.message : e); return null; }),
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
  const dims: Dim[] = [{ label: 'plataforma', rows: osRows }, { label: 'idioma', rows: langRows }, { label: 'país', rows: countryRows }];
  const movers = findMovers(dims, baseLabelShort);

  // Why did each flagged KPI move? Daily flags explain against the trailing-7 per-day
  // baseline with daily segment rows; weekly flags against the prior week.
  const dailyDims: Dim[] = weekly
    ? [
        { label: 'plataforma', rows: segmentRows(byOs.yesterday, byOs.trailing7, OS_SEGMENTS, 7) },
        { label: 'idioma', rows: segmentRows(byLang.yesterday, byLang.trailing7, LANG_SEGMENTS, 7) },
      ]
    : dims;
  const t7PerDay = { ...totals.trailing7 } as KPIValues;
  for (const k of Object.keys(t7PerDay) as KPIKey[]) if (ADDITIVE.has(k) && t7PerDay[k] !== null) t7PerDay[k] = (t7PerDay[k] as number) / 7;
  const causas: Array<{ key: KPIKey; scope: string; text: string }> = [];
  for (const c of daily.filter((x) => x.flag)) {
    const text = explainMove(c, totals.yesterday, t7PerDay, dailyDims);
    if (text) causas.push({ key: c.key, scope: 'ayer', text });
  }
  for (const c of (week ?? []).filter((x) => x.flag)) {
    const text = explainMove(c, totals.lastWeek, totals.priorWeek, dims);
    if (text) causas.push({ key: c.key, scope: 'semana', text });
  }

  // 4-week trend for the key KPIs (complete weeks, oldest → newest)
  const trend = TREND_KPIS.map((k) => {
    const vals = trendKeys.map((p) => totals[p]?.[k] ?? null);
    const prev = vals.slice(0, 3).filter((v): v is number => v !== null);
    const avgPrev = prev.length ? prev.reduce((a, b) => a + b, 0) / prev.length : null;
    const last = vals[3];
    return { key: k, vals, avgPrev, line: vals.map((v) => fmtValue(k, v)).join(' → '), mark: dot(k, last, avgPrev) };
  });

  // Alerta semanal por OS (semana cerrada vs 4 previas + cohorte de signup a 8 días)
  const osWeekly = osWeeklyCheck(byOs, cohorts);
  const osAlerts = osWeekly.filter((o) => o.status === 'peor');

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
    causas: causas.map((c) => `${KPI_LABELS[c.key]} (${c.scope}): ${c.text}`),
    tendencia4Semanas: trend.map((t) => `${KPI_LABELS[t.key]}: ${t.line}`),
    alertaSemanalOs: osWeekly.map((o) => renderOsWeekly(o).replace(/\*/g, '')),
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
  narrative ??= buildFallbackNarrative(daily, week ?? wtd, movers, sameLabel, weekly ? osAlerts : []);

  // ---- Render -------------------------------------------------------------------
  // Main message = the executive view: headline, a six-KPI traffic light, top-3
  // causes, actions. Everything else (full tables, breakdown, trend, notes) goes
  // into a Slack thread under it, so the channel stays readable.
  // Enlaces a la sección Operativo del dashboard (réplica del Looker): cada uno abre el periodo,
  // la granularidad y la pestaña exactos. def=fixed porque el brief usa la definición corregida.
  const dashBase = (process.env.DASHBOARD_URL ?? 'https://mrr-dashboard-phi.vercel.app').replace(/\/$/, '') + '/dashboard/operativo';
  const dash = (start: string, end: string, grain: string, tab: string) =>
    `${dashBase}?preset=custom&start=${start}&end=${end}&grain=${grain}&tab=${tab}&def=fixed`;
  const linkAyer = dash(addDays(y, -29), y, 'day', 'funnel');
  const linkSemana = week ? dash(lwStart, lwEnd, 'day', 'funnel') : dash(wtdStart, y, 'day', 'funnel');
  const linkTendencia = dash(addDays(lwStart, -77), lwEnd, 'week', 'graphs');
  const linkDesglose = weekly ? dash(lwStart, lwEnd, 'day', 'breakdown') : dash(y, y, 'day', 'breakdown');
  const linkOs = (os: string) => `${linkTendencia}&os=${encodeURIComponent(os)}&kpi=conversionRate&vs=cac`;
  const title = `Morning brief KPIs — Kinedu — ${dayLabelEs(today)}${opts.preview ? ' · vista previa' : ''}`;
  const textParts: string[] = [title, ''];
  const sec = (md: string): SlackBlock => { textParts.push(md, ''); return { type: 'section', text: { type: 'mrkdwn', text: md.slice(0, 2900) } }; };
  const ctx = (md: string): SlackBlock => { textParts.push(`_${md}_`, ''); return { type: 'context', elements: [{ type: 'mrkdwn', text: md.slice(0, 2900) }] }; };
  // Tablas nativas de Slack (una por mensaje); si Slack no las acepta, lib/slack/post las manda en texto monoespaciado.
  const table = (header: string[], rows: string[][]): SlackBlock => {
    const t = tableBlock(header, rows); textParts.push(tableToMrkdwn(t), '');
    return t as unknown as SlackBlock;
  };
  const deltaCell = (k: KPIKey, v: number | null, b: number | null) => { const d = fmtDelta(k, v, b); return d ? `${dot(k, v, b)} ${d}` : '—'; };
  const valDelta = (k: KPIKey, v: number | null, b: number | null) => { const d = fmtDelta(k, v, b); return `${fmtValue(k, v)}${d ? `  ${dot(k, v, b)} ${d}` : ''}`; };
  const compRows = (cs: Comparison[], withSame: boolean) => cs.map((c) => [
    KPI_LABELS[c.key], fmtValue(c.key, c.value), deltaCell(c.key, c.value, c.base),
    ...(withSame ? [c.sameDay === null ? '—' : deltaCell(c.key, c.value, c.sameDay)] : []), c.flag ? '‼️' : '',
  ]);
  const weekHdr = (start: string) => dayShortEs(start).split(' ').slice(-1)[0];
  const osTable = () => {
    const cohortWeek = osWeekly.find((o) => o.cohort)?.cohort?.week;
    const fl = (l: OsWeeklyLine | undefined) => (l ? `${fmtValue(l.key, l.value)}  ${flagDot(l.flag)} ${fmtDelta(l.key, l.value, l.base) ?? 'n/d'}` : '—');
    return table(['OS', 'C.R.', 'CAC', 'New Subs', cohortWeek ? `Cohorte ${weekHdr(cohortWeek)} · 8 días` : 'Cohorte 8 días'],
      osWeekly.map((o) => [`${o.os} ${flagDot(o.status)}`, ...OS_WEEKLY_KPIS.map((k) => fl(o.lines.find((l) => l.key === k))),
        o.cohort ? `${(o.cohort.rate * 100).toFixed(2)}%  ${flagDot(o.cohort.flag)} ${fmtDelta('conversionRate', o.cohort.rate, o.cohort.base) ?? 'n/d'}` : '—']));
  };
  const osLinks = `📊 ${OS_SEGMENTS.map((os) => `<${linkOs(os)}|${os} por semana>`).join(' · ')}`;
  const semaforo = (heading: string, comps: Comparison[], baseLabel: string): SlackBlock => {
    const fields = SEMAFORO_KPIS.flatMap((k) => {
      const c = comps.find((x) => x.key === k);
      if (!c) return [];
      const d = fmtDelta(k, c.value, c.base);
      return [{ type: 'mrkdwn', text: `*${KPI_LABELS[k]}*\n${fmtValue(k, c.value)}  ${dot(k, c.value, c.base)} ${d ?? 'n/d'} ${baseLabel}${c.flag ? ' ‼️' : ''}` }];
    });
    textParts.push(`*${heading}*`, ...fields.map((f) => '  ' + f.text.replace('\n', ' ')), '');
    return { type: 'section', text: { type: 'mrkdwn', text: `*${heading}*` }, fields };
  };

  // --- main
  const mainBlocks: SlackBlock[] = [{ type: 'header', text: { type: 'plain_text', text: title.slice(0, 150) } }];
  mainBlocks.push(sec(`*Lo más importante*\n${narrative.loMasImportante}`));
  mainBlocks.push(semaforo(`Ayer — ${dayShortEs(y)}  (vs prom. 7 días)`, daily, 'vs 7d'));
  if (week) mainBlocks.push(semaforo(`Semana ${rangeShortEs(lwStart, lwEnd)}  (vs semana anterior)`, week, 'vs sem. ant.'));
  else if (wtd) mainBlocks.push(semaforo(`Semana en curso — ${rangeShortEs(wtdStart, y)}  (vs mismos días de la semana pasada)`, wtd, 'vs sem. pas.'));
  const osWeeklyBlocks = (): SlackBlock[] => [
    sec(`*Alerta semanal por OS* — semana ${rangeShortEs(lwStart, lwEnd)} vs promedio de las 4 previas  _(🔴/🟢 = ±10 % o más)_`),
    osTable(),
    ctx(`Cohorte = de quienes se registraron esa semana, cuántos compraron en sus primeros 8 días (incluye el trial); misma fuente que el Tableau de cohortes · ${osLinks}`),
  ];
  if (weekly) mainBlocks.push(...osWeeklyBlocks());
  if (causas.length) {
    mainBlocks.push(sec(`*Por qué se movió*\n` + causas.slice(0, 3).map((c) => `• *${KPI_LABELS[c.key]}*${c.scope === 'semana' ? ' (semana)' : ''}: ${c.text}.`).join('\n')));
  }
  mainBlocks.push(sec(`*Qué revisaría hoy*\n` + narrative.queRevisariaHoy.map((a, i) => `${i + 1}. ${a}`).join('\n')));
  mainBlocks.push(ctx(`📊 Abrir en el dashboard: <${linkAyer}|últimos 30 días> · <${linkSemana}|${week ? 'semana pasada' : 'semana en curso'}> · <${linkTendencia}|tendencia 12 semanas> · <${linkDesglose}|desglose>`));
  mainBlocks.push(ctx(`🧵 Detalle en el hilo (tablas y gráficas): ayer completo · semana · tendencia 4 semanas · alerta por OS · gráficas de 12 semanas · desglose por plataforma, idioma y país · 🟢/🔴 mejor/peor que la base · ⚪ sin cambio · ‼️ fuera de la banda de 28 días · 🤖 KPI Bot${narrativeSource === 'fallback' ? ' · narrativa automática' : ''}`));

  // --- thread
  textParts.push('——— 🧵 HILO ———', '');
  const thread: SlackMessage[] = [];
  thread.push({
    text: 'Ayer — detalle',
    blocks: [
      sec(`*Ayer — ${dayShortEs(y)}*  _(vs prom. 7d · ${sameLabel})_` + (narrative.comentarioAyer ? `\n${narrative.comentarioAyer}` : '')),
      table(['KPI', 'Ayer', 'vs prom. 7d', sameLabel, ''], [['§Adquisición'], ...compRows(dailyAcq, true), ['§Monetización'], ...compRows(dailyMon, true)]),
      ctx(`🟢/🔴 mejor/peor que la base · ‼️ fuera de la banda de 28 días · 📊 <${linkAyer}|últimos 30 días en el dashboard>`),
    ],
  });
  if (wtd) thread.push({ text: 'Semana en curso', blocks: [
    sec(`*Semana en curso — ${rangeShortEs(wtdStart, y)} (${wtdDays} días)*  _(vs mismos días de la semana pasada)_`),
    table(['KPI', `${wtdDays} días`, 'vs sem. pasada', ''], compRows(wtd, false)),
  ] });
  if (week) thread.push({ text: 'Semana pasada', blocks: [
    sec(`*Semana pasada — ${rangeShortEs(lwStart, lwEnd)}*  _(vs ${rangeShortEs(addDays(lwStart, -7), addDays(lwEnd, -7))})_`),
    table(['KPI', 'Semana', 'vs anterior', ''], compRows(week, false)),
  ] });
  const trendStarts = [-21, -14, -7, 0].map((d) => addDays(lwStart, d));
  thread.push({ text: 'Tendencia 4 semanas', blocks: [
    sec(`*Tendencia — últimas 4 semanas completas*  _(semanas lun–dom; color = última vs promedio de las 3 previas)_`),
    table(['KPI', ...trendStarts.map((d) => `sem. ${weekHdr(d)}`), 'vs 3 previas'],
      trend.map((t) => [KPI_LABELS[t.key], ...t.vals.map((v) => fmtValue(t.key, v)), deltaCell(t.key, t.vals[3], t.avgPrev)])),
  ] });
  // Los lunes la alerta por OS va en el mensaje principal; el resto de la semana, en el hilo.
  if (!weekly) thread.push({ text: 'Alerta semanal por OS', blocks: osWeeklyBlocks() });
  // Gráficas como imagen (mismos datos que el Operativo). Si fallan, el brief sale igual con los enlaces.
  let charts: { files: SlackFile[]; comment: string } | null = null;
  try {
    charts = await buildBriefCharts({ lwStart, lwEnd, cohorts, links: { total: linkTendencia, ios: linkOs('iOS'), android: linkOs('Android') } });
  } catch (e) { console.error('[brief] gráficas no disponibles:', e instanceof Error ? e.message : e); }
  thread.push({ text: 'Gráficas', blocks: [], files: charts?.files, filesComment: charts?.comment ?? `📊 <${linkTendencia}|Ver tendencia de 12 semanas en el dashboard>` });
  if (charts) textParts.push(`[${charts.files.length} gráficas: ${charts.files.map((f) => f.title).join(' · ')}]`, charts.comment, '');
  const bdTitle = weekly ? 'semana pasada vs anterior' : 'ayer vs prom. 7d';
  const segRow = (r: SegmentRow, suffix = '') => [r.segment + suffix, ...DIM_KPIS.map((k) => valDelta(k, r.curr[k], r.base[k]))];
  thread.push({
    text: 'Desglose',
    blocks: [
      sec(`*Desglose — ${bdTitle}*` + (narrative.comentarioDesglose ? `\n${narrative.comentarioDesglose}` : '')),
      table(['Segmento', 'New Subs', 'NS Sales', 'CAC', 'Conv. Rate'], [
        ['§Plataforma'], ...osRows.map((r) => segRow(r)),
        ['§Idioma'], ...langRows.map((r) => segRow(r)),
        [`§País (US · BR · MX${picked.extras.size ? ' + movimientos' : ''})`], ...countryRows.map((r) => segRow(r, picked.extras.has(r.segment) ? ' ←' : '')),
      ]),
      ctx(`📊 <${linkDesglose}|Ver el desglose completo en el dashboard> (todas las regiones, idiomas y países)`),
    ],
  });
  const notasBlocks: SlackBlock[] = [];
  if (causas.length > 3) notasBlocks.push(sec(`*Por qué se movió — completo*\n` + causas.map((c) => `• *${KPI_LABELS[c.key]}*${c.scope === 'semana' ? ' (semana)' : ''}: ${c.text}.`).join('\n')));
  const tcDisc = discrepancies.find((d) => d.label === KPI_LABELS.totalContribution);
  if (tcDisc && weekly) notasBlocks.push(sec(`_Nota: Total Contribution usa la definición corregida (Stripe a su comisión y sus reembolsos restados una vez). Looker hoy, ${discPeriodLabel}: ${tcDisc.looker}._`));
  notasBlocks.push(ctx(`Fuente: \`an_operational_dash\` (BigQuery) · ${notas[0] ?? ''}`));
  notasBlocks.push(ctx(`📊 Mismos números con filtros por país, idioma, OS y región: <${dashBase}|dashboard Operativo> (réplica del Looker, verificada contra BigQuery cada mañana)`));
  thread.push({ text: 'Notas y fuente', blocks: notasBlocks });

  return {
    message: { text: `${title} — ${narrative.loMasImportante.slice(0, 180)}`, blocks: mainBlocks },
    thread,
    text: textParts.join('\n'),
    facts,
    narrative,
    narrativeSource,
  };
}
