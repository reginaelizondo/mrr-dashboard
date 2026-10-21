/**
 * Brief de cohortes — "Cohortes — Kinedu". Va a su propio canal (SLACK_COHORT_CHANNEL); el brief diario
 * (daily-brief.ts) es solo calendar basis.
 *
 * Qué trae (todo por cohorte, nada por fecha de calendario):
 *   - Cohortes de signup (an_conversion_analysis, la fuente del Tableau "Conversion (Weekly) by Signup Cohort"):
 *     % de los que se registraron que compró a 8 días (día 0 a 7, incluye el trial) y a 30 días (día 0 a 29).
 *       · semanal: última semana ISO con los 8 días cumplidos vs las 4 previas (cociente de sumas);
 *       · a 30 días: última semana con los 30 días cumplidos vs las 4 previas;
 *       · diaria: el día de signup que acaba de cumplir 8 días vs el mismo día de la semana en las 4 previas.
 *   - Cohortes de refunds (Supabase, refund_cohorts_weekly): de los cobros de cada semana, % que se devolvió.
 *     Solo se compara una semana "madura" (terminó hace ≥ 14 días); las recientes siguen subiendo.
 *
 * 🔴/🟢 = ±10 % o más vs la base (redondeado, como se muestra) y solo con volumen suficiente.
 * Narrativa por reglas (sin llamada a Claude), igual que el brief diario con DAILY_BRIEF_NARRATIVE=off.
 */
import { fetchSignupCohortsDaily, type CohortDay } from './brief-queries';
import { todayMx, addDays, mondayOf, dayLabelEs, dayShortEs, rangeShortEs } from './period';
import { getRefundCohortsWeekly, type RefundCohortRow } from '@/lib/refunds';
import type { SlackMessage, SlackFile } from '@/lib/slack/post';
import { tableBlock, tableToMrkdwn } from '@/lib/slack/table';
import { buildCohortCharts, type CohortChartWeek, type CohortChartRefundWeek } from './cohort-charts';

type SlackBlock = NonNullable<SlackMessage['blocks']>[number];
type Flag = 'mejor' | 'peor' | null;
type Seg = 'iOS' | 'Android' | 'Total';
type Win = 'd0' | 'd8' | 'd30';

const SEGS: Seg[] = ['iOS', 'Android', 'Total'];
/** Semanas de signup que se leen (gráfica y tabla). */
const WEEKS = 12;
const TABLE_WEEKS = 8;
const DAILY_ROWS = 14;
const PRIOR = 4;
const MIN_PCT = 10;
/** Volumen mínimo de la cohorte (y del promedio de las previas) para marcar 🔴/🟢. */
const MIN_WEEK_SIGNUPS = 1000;
const MIN_DAY_SIGNUPS = 200;
const MIN_REFUND_CHARGES = 1000;
/** Una semana de cobro es "madura" cuando terminó hace al menos estos días. */
const REFUND_MATURE_DAYS = 14;
const REFUND_SOURCES = ['apple', 'google', 'stripe'] as const;

interface Agg { signups: number; d0: number; d8: number; d30: number }
const zero = (): Agg => ({ signups: 0, d0: 0, d8: 0, d30: 0 });
const addInto = (a: Agg, b: Agg) => { a.signups += b.signups; a.d0 += b.d0; a.d8 += b.d8; a.d30 += b.d30; };
const rate = (a: Agg | undefined, k: Win): number | null => (a && a.signups ? a[k] / a.signups : null);

const pct = (v: number | null, digits = 2) => (v === null || !Number.isFinite(v) ? 'n/d' : `${(v * 100).toFixed(digits)}%`);
const int = (v: number) => Math.round(v).toLocaleString('en-US');
function signed(n: number): string {
  const r = Math.round(n);
  return r > 0 ? `+${r}%` : r < 0 ? `−${Math.abs(r)}%` : '0%';
}
const flagDot = (f: Flag) => (f === 'peor' ? '🔴' : f === 'mejor' ? '🟢' : '⚪');

/** Comparación de una cohorte contra su base (cociente de las sumas de las previas). */
interface Check { seg: string; value: number | null; base: number | null; rel: number | null; flag: Flag; volume: number }

function check(seg: string, cur: { n: number; d: number } | null, prior: Array<{ n: number; d: number }>, minVol: number, higherIsBetter = true): Check {
  const pd = prior.reduce((a, p) => a + p.d, 0);
  const value = cur && cur.d ? cur.n / cur.d : null;
  const base = prior.length && pd ? prior.reduce((a, p) => a + p.n, 0) / pd : null;
  const rel = value !== null && base ? ((value - base) / base) * 100 : null;
  const enough = !!cur && cur.d >= minVol && prior.length === PRIOR && pd / prior.length >= minVol;
  let flag: Flag = null;
  if (enough && rel !== null && Math.round(Math.abs(rel)) >= MIN_PCT) flag = (higherIsBetter ? rel > 0 : rel < 0) ? 'mejor' : 'peor';
  return { seg, value, base, rel, flag, volume: cur?.d ?? 0 };
}
const cell = (c: Check, digits = 2) => `${pct(c.value, digits)}${c.rel !== null ? `  ${flagDot(c.flag)} ${signed(c.rel)}` : ''}`;
const inline = (c: Check, digits = 2) => `${c.seg} *${pct(c.value, digits)}* ${flagDot(c.flag)} ${c.rel !== null ? signed(c.rel) : 'n/d'}`;

// ---- Builder ------------------------------------------------------------------------

export interface CohortBriefOptions {
  /** Override "today" (YYYY-MM-DD, MX). Default: hoy en Ciudad de México. */
  today?: string;
  /** Marca el mensaje como vista previa (sufijo en el título). */
  preview?: boolean;
}

export interface CohortBriefResult {
  message: SlackMessage;
  thread: SlackMessage[];
  text: string;
  facts: Record<string, unknown>;
}

export async function buildCohortBrief(opts: CohortBriefOptions = {}): Promise<CohortBriefResult> {
  const today = opts.today ?? todayMx();
  const y = addDays(today, -1);

  // Cohortes maduras: la semana w está completa a N días si su domingo + (N − 1) ≤ ayer.
  const w8 = mondayOf(addDays(y, -13));   // última semana de signup con los 8 días cumplidos
  const w30 = mondayOf(addDays(y, -35));  // última con los 30 días cumplidos
  const weeks = Array.from({ length: WEEKS }, (_, i) => addDays(w8, -7 * (WEEKS - 1 - i)));
  const dc = addDays(y, -7);               // último día de signup con los 8 días cumplidos
  const refundStart = addDays(mondayOf(y), -7 * (WEEKS - 1));

  const [days, refundAll, ...refundBySrc] = await Promise.all([
    fetchSignupCohortsDaily(weeks[0], y),
    getRefundCohortsWeekly('all', refundStart, y),
    ...REFUND_SOURCES.map((s) => getRefundCohortsWeekly(s, refundStart, y)),
  ]);

  // day → seg → Agg (con Total)
  const byDay = new Map<string, Record<Seg, Agg>>();
  for (const r of days as CohortDay[]) {
    if (r.os !== 'iOS' && r.os !== 'Android') continue;
    const m = byDay.get(r.day) ?? { iOS: zero(), Android: zero(), Total: zero() };
    const a: Agg = { signups: r.signups, d0: r.d0, d8: r.d8, d30: r.d30 };
    addInto(m[r.os], a); addInto(m.Total, a);
    byDay.set(r.day, m);
  }
  const dayAgg = (d: string, s: Seg) => byDay.get(d)?.[s];
  const weekAgg = (w: string, s: Seg): Agg => {
    const a = zero();
    for (let i = 0; i < 7; i++) { const v = dayAgg(addDays(w, i), s); if (v) addInto(a, v); }
    return a;
  };
  const nd = (a: Agg | undefined, k: Win) => (a && a.signups ? { n: a[k], d: a.signups } : null);

  // ---- Comparaciones
  const priorWeeks = (w: string) => Array.from({ length: PRIOR }, (_, i) => addDays(w, -7 * (PRIOR - i)));
  const weekly8 = SEGS.map((s) => check(s, nd(weekAgg(w8, s), 'd8'), priorWeeks(w8).map((w) => nd(weekAgg(w, s), 'd8')).filter((x): x is { n: number; d: number } => !!x), MIN_WEEK_SIGNUPS));
  const weekly30 = SEGS.map((s) => check(s, nd(weekAgg(w30, s), 'd30'), priorWeeks(w30).map((w) => nd(weekAgg(w, s), 'd30')).filter((x): x is { n: number; d: number } => !!x), MIN_WEEK_SIGNUPS));
  const daily8 = SEGS.map((s) => check(s, nd(dayAgg(dc, s), 'd8'), priorWeeks(dc).map((d) => nd(dayAgg(d, s), 'd8')).filter((x): x is { n: number; d: number } => !!x), MIN_DAY_SIGNUPS));

  // ---- Refunds por semana de cobro
  const srcMap = REFUND_SOURCES.map((s, i) => new Map((refundBySrc[i] as RefundCohortRow[]).map((r) => [r.cohort_month, r])));
  const refundWeeks = (refundAll as RefundCohortRow[])
    .filter((r) => addDays(r.cohort_month, 6) <= y) // solo semanas de cobro completas
    .sort((a, b) => a.cohort_month.localeCompare(b.cohort_month))
    .map((r) => ({ ...r, mature: addDays(r.cohort_month, 6 + REFUND_MATURE_DAYS) <= y }));
  const matureRefunds = refundWeeks.filter((r) => r.mature);
  const lastMature = matureRefunds[matureRefunds.length - 1];
  const refundCheck = lastMature
    ? check('Refunds', { n: lastMature.refunded_units, d: lastMature.charge_units }, matureRefunds.slice(-PRIOR - 1, -1).map((r) => ({ n: r.refunded_units, d: r.charge_units })), MIN_REFUND_CHARGES, false)
    : null;

  // ---- Texto
  const w8Range = rangeShortEs(w8, addDays(w8, 6));
  const w30Range = rangeShortEs(w30, addDays(w30, 6));
  const allChecks = [...weekly8, ...weekly30, ...daily8, ...(refundCheck ? [refundCheck] : [])];
  const worse = [
    ...weekly8.filter((c) => c.flag === 'peor').map((c) => ({ c, what: `cohorte ${w8Range} a 8 días` })),
    ...daily8.filter((c) => c.flag === 'peor').map((c) => ({ c, what: `signups del ${dayShortEs(dc)} a 8 días` })),
    ...weekly30.filter((c) => c.flag === 'peor').map((c) => ({ c, what: `cohorte ${w30Range} a 30 días` })),
    ...(refundCheck?.flag === 'peor' ? [{ c: refundCheck, what: `cobros de la semana ${rangeShortEs(lastMature!.cohort_month, addDays(lastMature!.cohort_month, 6))}` }] : []),
  ];
  const better = allChecks.filter((c) => c.flag === 'mejor').length;
  const headline = worse.length
    ? `🔴 Empeoró: ${worse.slice(0, 4).map(({ c, what }) => `${c.seg} ${pct(c.value)} (${signed(c.rel ?? 0)}, ${what})`).join('; ')}.`
    : `Todas las cohortes dentro de ±${MIN_PCT} % de su base${better ? ` (${better} 🟢 a favor)` : ''}.`;

  const lines = [
    `• *Semana de signup ${w8Range} · compra a 8 días* (vs las 4 previas): ${weekly8.map((c) => inline(c)).join(' · ')}`,
    `• *Signups del ${dayShortEs(dc)} · compra a 8 días* (vs el mismo día de las 4 semanas previas): ${daily8.map((c) => inline(c)).join(' · ')}`,
    `• *Semana de signup ${w30Range} · compra a 30 días* (vs las 4 previas): ${weekly30.map((c) => inline(c)).join(' · ')}`,
  ];
  if (refundCheck && lastMature) {
    lines.push(`• *Refunds de los cobros del ${rangeShortEs(lastMature.cohort_month, addDays(lastMature.cohort_month, 6))}* (semana madura, vs las 4 previas): *${pct(refundCheck.value, 1)}* de ${int(lastMature.charge_units)} cobros ${flagDot(refundCheck.flag)} ${refundCheck.rel !== null ? signed(refundCheck.rel) : 'n/d'}`);
  }

  const acciones: string[] = [];
  for (const { c, what } of worse) {
    if (acciones.length >= 4) break;
    if (c.seg === 'Refunds') {
      acciones.push(`Finanzas/Producto: refunds de los ${what} en ${pct(c.value, 1)} (${signed(c.rel ?? 0)}) — revisar por SKU y tienda en el dashboard de refunds.`);
    } else if (c.seg !== 'Total' || !worse.some((x) => x.what === what && x.c.seg !== 'Total')) {
      acciones.push(`Marketing/Producto: ${c.seg}, ${what} en ${pct(c.value)} (${signed(c.rel ?? 0)} vs base ${pct(c.base)}) — ver qué campañas trajeron esos signups (calidad del tráfico) y si cambió algo en onboarding, trial o paywall.`);
    }
  }
  if (!acciones.length) acciones.push('Nada fuera de rango; sin acciones pendientes.');

  // ---- Gráfica
  const chartWeeks: CohortChartWeek[] = weeks.map((w) => ({
    week: w,
    segs: Object.fromEntries(SEGS.map((s) => { const a = weekAgg(w, s); return [s, { signups: a.signups, d8: a.d8, d30: w <= w30 ? a.d30 : null }]; })),
  }));
  const chartRefunds: CohortChartRefundWeek[] = refundWeeks.map((r) => ({ week: r.cohort_month, charges: r.charge_units, refunded: r.refunded_units, mature: r.mature }));
  let files: SlackFile[] | undefined;
  try { files = await buildCohortCharts(chartWeeks, chartRefunds, y); } catch (e) { console.error('[cohort-brief] gráfica no disponible:', e instanceof Error ? e.message : e); }

  // ---- Render
  const dashBase = (process.env.DASHBOARD_URL ?? 'https://mrr-dashboard-phi.vercel.app').replace(/\/$/, '') + '/dashboard';
  const title = `Cohortes — Kinedu — ${dayLabelEs(today)}${opts.preview ? ' · vista previa' : ''}`;
  const textParts: string[] = [title, ''];
  const sec = (md: string): SlackBlock => { textParts.push(md, ''); return { type: 'section', text: { type: 'mrkdwn', text: md.slice(0, 2900) } }; };
  const ctx = (md: string): SlackBlock => { textParts.push(`_${md}_`, ''); return { type: 'context', elements: [{ type: 'mrkdwn', text: md.slice(0, 2900) }] }; };
  const table = (header: string[], rows: string[][]): SlackBlock => { const t = tableBlock(header, rows); textParts.push(tableToMrkdwn(t), ''); return t as unknown as SlackBlock; };

  const main: SlackBlock[] = [{ type: 'header', text: { type: 'plain_text', text: title.slice(0, 150) } }];
  main.push(sec(`*Lo más importante*\n${headline}\n${lines.join('\n')}`));
  if (files?.length) {
    files.forEach((f, i) => main.push({ type: 'image', _file: i, alt_text: f.title, title: { type: 'plain_text', text: f.title } } as SlackBlock));
    textParts.push(`[gráfica: ${files.map((f) => f.title).join(' · ')}]`, '');
  }

  // Tabla semanal: la cohorte comparada lleva su color y delta; el resto, el valor.
  const tableWeeks = weeks.slice(-TABLE_WEEKS);
  const rowFor = (w: string) => {
    const c8 = (s: Seg) => (w === w8 ? cell(weekly8.find((c) => c.seg === s)!) : pct(rate(weekAgg(w, s), 'd8')));
    const c30 = (s: Seg) => (w > w30 ? '⏳' : w === w30 ? cell(weekly30.find((c) => c.seg === s)!) : pct(rate(weekAgg(w, s), 'd30')));
    return [rangeShortEs(w, addDays(w, 6)), int(weekAgg(w, 'Total').signups), c8('iOS'), c8('Android'), c8('Total'), c30('iOS'), c30('Android'), c30('Total')];
  };
  main.push(sec(`*Cohortes semanales de signup* — % que compró a 8 y a 30 días  _(🔴/🟢 = ±${MIN_PCT} % o más vs las 4 previas · ⏳ aún no cumple 30 días)_`));
  main.push(table(['Semana de signup', 'Signups', '8d iOS', '8d Android', '8d Total', '30d iOS', '30d Android', '30d Total'], tableWeeks.map(rowFor)));
  main.push(sec(`*Qué revisaría hoy*\n` + acciones.map((a, i) => `${i + 1}. ${a}`).join('\n')));
  main.push(ctx(`Cohorte = los que se registraron ese día o semana; "compra a 8 días" = % que compró entre el día 0 y el 7 (incluye el cobro del trial: día 3 en Android, día 7 en iOS). Fuente: \`an_conversion_analysis\`, la misma del Tableau de cohortes. El brief de KPIs por fecha de calendario va en su propio canal.`));
  main.push(ctx(`🧵 Detalle en el hilo: cohortes diarias · refunds por semana de cobro y tienda · notas · 🤖 KPI Bot`));

  // ---- Hilo
  const thread: SlackMessage[] = [];
  const dailyDays = Array.from({ length: DAILY_ROWS }, (_, i) => addDays(dc, -(DAILY_ROWS - 1 - i)));
  thread.push({
    text: 'Cohortes diarias',
    blocks: [
      sec(`*Cohortes diarias de signup* — últimos ${DAILY_ROWS} días con los 8 días cumplidos  _(el último día se compara con el mismo día de la semana en las 4 previas)_`),
      table(['Día de signup', 'Signups', 'Mismo día', '8d iOS', '8d Android', '8d Total'], dailyDays.map((d) => {
        const c8 = (s: Seg) => (d === dc ? cell(daily8.find((c) => c.seg === s)!) : pct(rate(dayAgg(d, s), 'd8')));
        const t = dayAgg(d, 'Total');
        return [dayShortEs(d), int(t?.signups ?? 0), pct(rate(t, 'd0')), c8('iOS'), c8('Android'), c8('Total')];
      })),
      ctx('"Mismo día" = % que compró el día del signup (casi todo es compra directa, sin trial).'),
    ],
  });
  const refundRows = refundWeeks.slice(-TABLE_WEEKS).map((r) => {
    const bySrc = srcMap.map((m) => { const x = m.get(r.cohort_month); return x && x.charge_units ? pct(x.cohort_rate_units, 1) : '—'; });
    const isLast = lastMature && r.cohort_month === lastMature.cohort_month;
    const total = isLast && refundCheck ? cell(refundCheck, 1) : pct(r.cohort_rate_units, 1);
    return [`${rangeShortEs(r.cohort_month, addDays(r.cohort_month, 6))}${r.mature ? '' : ' ⏳'}`, int(r.charge_units), total, pct(r.cohort_rate_amount, 1), ...bySrc, r.avg_days_to_refund === null ? '—' : r.avg_days_to_refund.toFixed(1)];
  });
  thread.push({
    text: 'Refunds por semana de cobro',
    blocks: [
      sec(`*Refunds por semana de cobro* — de los cobros de esa semana, cuántos se devolvieron  _(⏳ = terminó hace menos de ${REFUND_MATURE_DAYS} días, todavía sube)_`),
      table(['Semana de cobro', 'Cobros', 'Refund % (unid.)', 'Refund % ($)', 'Apple', 'Google', 'Stripe', 'Días a refund'], refundRows),
      ctx(`Apple / Google / Stripe en % de unidades. Fuente: \`kinedu_refunds\` (Supabase, \`refund_cohorts_weekly\`), base bruta: no es la tasa de refunds del calendar. 📊 <${dashBase}/refunds|dashboard de refunds>`),
    ],
  });
  thread.push({
    text: 'Notas',
    blocks: [
      ctx(`Comparaciones: cociente de las sumas de las 4 cohortes previas; 🔴/🟢 con ±${MIN_PCT} % o más y volumen mínimo (${int(MIN_WEEK_SIGNUPS)} signups por semana, ${MIN_DAY_SIGNUPS} por día, ${int(MIN_REFUND_CHARGES)} cobros por semana). El Tableau acumula semanas a conversión, así que sus % de cohortes maduras salen algo más altos; a la misma edad la tendencia es la misma.`),
      ctx('Este canal no trae ingresos por cohorte: `usd_amount` de `an_conversion_analysis` no cuadra con NS Sales del calendar (≈ 25 % abajo), así que no se usa hasta validarlo.'),
    ],
  });

  const facts = {
    hoy: today, ayer: y,
    semana8d: { semana: w8, checks: weekly8 },
    semana30d: { semana: w30, checks: weekly30 },
    dia8d: { dia: dc, checks: daily8 },
    refunds: lastMature ? { semana: lastMature.cohort_month, check: refundCheck } : null,
  };
  return {
    message: { text: `${title} — ${headline.slice(0, 180)}`, blocks: main, files },
    thread,
    text: textParts.join('\n'),
    facts,
  };
}
