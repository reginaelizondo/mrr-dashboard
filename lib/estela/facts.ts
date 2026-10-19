/**
 * Estela · hoja de hechos semanal.
 *
 * Reúne, sin inventar nada, lo que Estela necesita para proponer: KPIs de las últimas
 * 4 semanas completas (BigQuery, mismas fórmulas del brief), MRR (Supabase), el P&L
 * consolidado mensual y el budget cash (CSVs versionados en data/estela/) y, si está
 * configurado, la hoja de Cash analysis (Google Sheets, cuenta de servicio de BizOps).
 *
 * Todo número que llega al redactor sale de aquí. El redactor no calcula.
 */
import fs from 'fs';
import path from 'path';
import { fetchKPIsByPeriod, type KPIValues, type NamedPeriod } from '@/lib/kpi/brief-queries';
import type { KPIKey } from '@/lib/kpi/formulas';
import { todayMx, addDays, mondayOf, rangeShortEs } from '@/lib/kpi/period';
import { createServerClient } from '@/lib/supabase/server';

// ---- Tipos -----------------------------------------------------------------------

export interface WeekFact {
  rango: string;              // '12–18 oct'
  start: string;
  end: string;
  kpis: Record<string, string>; // etiqueta → valor formateado
}

export interface PnlLine {
  linea: string;
  ultimoMes: string;        // '$418,206' · '−$14,321' · 'n/a'
  mesAnterior: string;
  promedio3m: string;
  budgetMes: string;        // 'n/a' si la línea no tiene equivalente en el budget
  vsBudget: string;         // '−$62,054 (−13%)' · 'n/a'
}

export interface EstelaFacts {
  semana: string;                 // 'lunes 20 de octubre de 2026'
  fuentes: string[];
  kpisSemanales: { ultima: WeekFact; anterior: WeekFact; tendencia4s: Record<string, string> };
  mrr: { fecha: string; mrrNeto: string; hace30d: string; hace90d: string; porTienda: Record<string, string> } | null;
  pnl: { mes: string; mesAnterior: string; lineas: PnlLine[]; notas: string[] } | null;
  caja: { hoja: string; mes: string; lineas: string[] } | null;
  seguimiento: Array<{ id: number; semana: string; titulo: string; estado: string; impacto: string }>;
  notas: string[];
}

// ---- Helpers ---------------------------------------------------------------------

const MONEY: Set<KPIKey> = new Set(['spend', 'nsSales', 'totalRenewalSales', 'totalSales', 'netSales', 'refundsAmount', 'totalContribution']);
const MONEY_2DP: Set<KPIKey> = new Set(['cac', 'cpnu', 'arpu']);
const PCT: Set<KPIKey> = new Set(['conversionRate', 'ftStartRate', 'contributionMarginPct']);
const RATIO: Set<KPIKey> = new Set(['firstTicketCac']);

/** KPIs que Estela mira (los que mueven caja). */
export const ESTELA_KPIS: KPIKey[] = [
  'spend', 'signups', 'newSubs', 'conversionRate', 'cac', 'arpu', 'firstTicketCac',
  'nsSales', 'totalRenewalSales', 'totalSales', 'netSales', 'refundsAmount', 'totalContribution', 'contributionMarginPct',
];

const LABEL: Record<string, string> = {
  spend: 'Spend', signups: 'Signups', newSubs: 'New Subs', conversionRate: 'Conversion Rate', cac: 'CAC', arpu: 'ARPU',
  firstTicketCac: '1st Ticket / CAC', nsSales: 'New Subs Sales', totalRenewalSales: 'Renewal Sales', totalSales: 'Total Sales',
  netSales: 'Net Sales', refundsAmount: 'Refunds', totalContribution: 'Total Contribution', contributionMarginPct: 'Contribution Margin %',
};

export function fmtKpi(key: KPIKey, v: number | null): string {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return 'n/a';
  const n = Number(v);
  if (MONEY_2DP.has(key)) return `$${n.toFixed(2)}`;
  if (MONEY.has(key)) return `$${Math.round(n).toLocaleString('en-US')}`;
  if (PCT.has(key)) return `${(n * 100).toFixed(2)}%`;
  if (RATIO.has(key)) return `${n.toFixed(2)}x`;
  return Math.round(n).toLocaleString('en-US');
}

function usd(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return 'n/a';
  const sign = n < 0 ? '−' : '';
  return `${sign}$${Math.round(Math.abs(n)).toLocaleString('en-US')}`;
}

function toWeekFact(start: string, end: string, v: KPIValues): WeekFact {
  const kpis: Record<string, string> = {};
  for (const k of ESTELA_KPIS) kpis[LABEL[k] ?? k] = fmtKpi(k, v[k]);
  return { rango: rangeShortEs(start, end), start, end, kpis };
}

// ---- KPIs semanales (BigQuery) ---------------------------------------------------

async function weeklyKpis(today: string) {
  const lwEnd = addDays(mondayOf(today), -1);
  const lwStart = addDays(lwEnd, -6);
  const periods: NamedPeriod[] = [0, 1, 2, 3].map((i) => ({
    key: `w${i}`, start: addDays(lwStart, -7 * i), end: addDays(lwEnd, -7 * i),
  }));
  const totals = await fetchKPIsByPeriod(periods);
  const ultima = toWeekFact(periods[0].start, periods[0].end, totals.w0);
  const anterior = toWeekFact(periods[1].start, periods[1].end, totals.w1);
  const tendencia4s: Record<string, string> = {};
  for (const k of ESTELA_KPIS) {
    tendencia4s[LABEL[k] ?? k] = ['w3', 'w2', 'w1', 'w0'].map((p) => fmtKpi(k, totals[p]?.[k] ?? null)).join(' → ');
  }
  return { ultima, anterior, tendencia4s };
}

// ---- MRR (Supabase) ---------------------------------------------------------------

async function mrrFacts(): Promise<EstelaFacts['mrr']> {
  try {
    const sb = createServerClient();
    const { data, error } = await sb
      .from('mrr_daily_snapshots')
      .select('snapshot_date, mrr_net, mrr_gross, mrr_apple_net, mrr_google_net, mrr_stripe_net')
      .order('snapshot_date', { ascending: false })
      .limit(100);
    if (error || !data || data.length === 0) return null;
    type Row = { snapshot_date: string; mrr_net: number; mrr_gross: number; mrr_apple_net: number; mrr_google_net: number; mrr_stripe_net: number };
    const rows = data as unknown as Row[];
    const latest = rows[0];
    const at = (daysAgo: number) => {
      const target = addDays(latest.snapshot_date, -daysAgo);
      return rows.find((r) => r.snapshot_date <= target) ?? null;
    };
    const d30 = at(30), d90 = at(90);
    return {
      fecha: latest.snapshot_date,
      mrrNeto: usd(Number(latest.mrr_net)),
      hace30d: d30 ? `${usd(Number(d30.mrr_net))} (${d30.snapshot_date})` : 'n/a',
      hace90d: d90 ? `${usd(Number(d90.mrr_net))} (${d90.snapshot_date})` : 'n/a',
      porTienda: {
        Apple: usd(Number(latest.mrr_apple_net)),
        Google: usd(Number(latest.mrr_google_net)),
        Stripe: usd(Number(latest.mrr_stripe_net)),
      },
    };
  } catch (e) {
    console.error('[estela] mrr facts failed:', e instanceof Error ? e.message : e);
    return null;
  }
}

// ---- P&L y budget (CSV versionados) --------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MES_ES: Record<string, string> = { Jan: 'enero', Feb: 'febrero', Mar: 'marzo', Apr: 'abril', May: 'mayo', Jun: 'junio', Jul: 'julio', Aug: 'agosto', Sep: 'septiembre', Oct: 'octubre', Nov: 'noviembre', Dec: 'diciembre' };

/** Líneas del P&L consolidado que Estela vigila y su equivalente en el budget cash (conservador). */
const PNL_LINES: Array<{ pnl: string; budget: string | null; signo?: -1 | 1 }> = [
  { pnl: 'Recurring Revenue', budget: null },
  { pnl: 'Partnerships', budget: 'Other Revenue Partnerships' },
  { pnl: 'Gross Revenue', budget: 'Gross Revenue' },
  { pnl: 'Net Revenue', budget: 'Net Revenue' },
  { pnl: 'Total CAC', budget: null },
  { pnl: 'Contribution Profit', budget: 'Contribution Margin' },
  { pnl: 'Sales & Marketing', budget: null },
  { pnl: 'Research & Development', budget: null },
  { pnl: 'Content (Educational Content)', budget: null },
  { pnl: 'General & Administrative', budget: null },
  { pnl: 'Total Operating Expenses', budget: 'Total Operating Expenses', signo: -1 },
  { pnl: 'EBITDA', budget: 'Operating Profit' },
];

function parseCsv(file: string): string[][] {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const out: string[][] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells: string[] = []; let cur = ''; let q = false;
    for (const ch of line) {
      if (ch === '"') q = !q;
      else if (ch === ',' && !q) { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    out.push(cells.map((c) => c.trim()));
  }
  return out;
}

function num(s: string | undefined): number | null {
  if (s === undefined) return null;
  const t = s.replace(/[$,\s]/g, '').replace(/^\((.*)\)$/, '-$1');
  if (t === '' || t === '-') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function pnlFacts(): EstelaFacts['pnl'] {
  const dir = path.join(process.cwd(), 'data', 'estela');
  const pnlFile = path.join(dir, 'pnl-2026-cons-usd.csv');
  const budgetFile = path.join(dir, 'budget-2026-cash-conservative.csv');
  if (!fs.existsSync(pnlFile)) return null;

  const pnl = parseCsv(pnlFile);
  const header = pnl[0];
  // Columnas de mes disponibles: la última con datos en "Gross Revenue" marca el último mes cerrado.
  const gross = pnl.find((r) => r[0] === 'Gross Revenue') ?? [];
  const monthCols = header.map((h, i) => ({ h, i })).filter(({ h }) => MONTHS.includes(h));
  const closed = monthCols.filter(({ i }) => (num(gross[i]) ?? 0) > 0);
  if (closed.length === 0) return null;
  const last = closed[closed.length - 1];
  const prev = closed[closed.length - 2];
  const last3 = closed.slice(-3);
  // Si existe una columna ajustada del último mes (p. ej. "Aug Aj"), se usa esa.
  const adjIdx = header.indexOf(`${last.h} Aj`);
  const lastIdx = adjIdx >= 0 ? adjIdx : last.i;

  const budget = fs.existsSync(budgetFile) ? parseCsv(budgetFile) : [];
  const bHeader = budget[0] ?? [];
  const bCol = bHeader.indexOf(last.h);
  const bLine = (name: string | null) => {
    if (!name || bCol < 0) return null;
    const r = budget.find((x) => x[0] === name);
    return r ? num(r[bCol]) : null;
  };

  const lineas: PnlLine[] = [];
  for (const def of PNL_LINES) {
    const r = pnl.find((x) => x[0] === def.pnl);
    if (!r) continue;
    const avg = last3.map(({ i }) => num(r[i])).filter((v): v is number => v !== null);
    const b = bLine(def.budget);
    const ultimo = num(r[lastIdx]);
    const bud = b === null ? null : (def.signo ?? 1) * b;
    const diff = ultimo !== null && bud !== null ? ultimo - bud : null;
    const pct = diff !== null && bud ? ` (${diff / Math.abs(bud) >= 0 ? '+' : '−'}${Math.round(Math.abs(diff / bud) * 100)}%)` : '';
    lineas.push({
      linea: def.pnl,
      ultimoMes: usd(ultimo),
      mesAnterior: usd(prev ? num(r[prev.i]) : null),
      promedio3m: usd(avg.length ? avg.reduce((a, c) => a + c, 0) / avg.length : null),
      budgetMes: usd(bud),
      vsBudget: diff === null ? 'n/a' : `${usd(diff)}${pct}`,
    });
  }
  const notas = [
    `P&L consolidado en USD (fuente: Formato P&L Kinedu 2026, Arrowpoint). Último mes cerrado: ${MES_ES[last.h]}${adjIdx >= 0 ? ' (columna ajustada)' : ''}.`,
    'Budget: escenario conservador del Budget 2026 cash; EBITDA se compara contra Operating Profit del budget.',
  ];
  return { mes: MES_ES[last.h], mesAnterior: prev ? MES_ES[prev.h] : 'n/a', lineas, notas };
}

// ---- Caja (Google Sheets, opcional) ---------------------------------------------------

async function cajaFacts(): Promise<EstelaFacts['caja']> {
  const keyB64 = process.env.ESTELA_GCP_SA_KEY_B64;
  const sheetId = process.env.ESTELA_CASH_SHEET_ID;
  if (!keyB64 || !sheetId) return null;
  try {
    const { google } = await import('googleapis');
    const creds = JSON.parse(Buffer.from(keyB64, 'base64').toString('utf8'));
    const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
    const sheets = google.sheets({ version: 'v4', auth });
    const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
    const titles = (meta.data.sheets ?? []).map((s) => s.properties?.title ?? '').filter(Boolean);
    // Última pestaña que parece un mes o un rango de meses del año en curso.
    const year = todayMx().slice(0, 4);
    const tab = [...titles].reverse().find((t) => t.includes(year)) ?? titles[titles.length - 1];
    if (!tab) return null;
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: `'${tab}'!A1:P60` });
    const rows = (res.data.values ?? []) as string[][];
    const lineas: string[] = [];
    for (const r of rows) {
      const first = (r[0] ?? '').toString().trim();
      if (!first) continue;
      if (/saldo|balance|pendiente|diferencia|total|revenue|apple|google|stripe|semana/i.test(first)) {
        lineas.push(r.filter((c) => c !== '').slice(0, 7).join(' · '));
      }
      if (lineas.length >= 40) break;
    }
    return { hoja: 'Cash analysis', mes: tab, lineas };
  } catch (e) {
    console.error('[estela] cash sheet failed:', e instanceof Error ? e.message : e);
    return null;
  }
}

// ---- Seguimiento (Supabase) -----------------------------------------------------------

async function seguimiento(): Promise<EstelaFacts['seguimiento']> {
  try {
    const sb = createServerClient();
    const { data, error } = await sb
      .from('estela_proposals')
      .select('id, week_start, titulo, estado, impacto_cash')
      .in('estado', ['propuesta', 'aceptada'])
      .order('week_start', { ascending: false })
      .limit(12);
    if (error || !data) return [];
    return (data as Array<{ id: number; week_start: string; titulo: string; estado: string; impacto_cash: string | null }>)
      .map((r) => ({ id: r.id, semana: r.week_start, titulo: r.titulo, estado: r.estado, impacto: r.impacto_cash ?? 'n/a' }));
  } catch {
    return [];
  }
}

// ---- Entrada ------------------------------------------------------------------------

export async function buildEstelaFacts(opts: { today?: string } = {}): Promise<EstelaFacts> {
  const today = opts.today ?? todayMx();
  const [kpis, mrr, caja, seg] = await Promise.all([weeklyKpis(today), mrrFacts(), cajaFacts(), seguimiento()]);
  const pnl = pnlFacts();
  const fuentes = ['BigQuery an_operational_dash (KPIs semanales, fórmulas validadas)'];
  if (mrr) fuentes.push('MRR Dashboard (Supabase mrr_daily_snapshots)');
  if (pnl) fuentes.push('P&L consolidado y budget cash (data/estela)');
  if (caja) fuentes.push('Cash analysis (Google Sheets)');
  const notas: string[] = [];
  if (!caja) notas.push('Sin acceso a la hoja de caja esta semana: no hay lectura de saldos ni de pagos pendientes.');
  if (!mrr) notas.push('Sin lectura de MRR esta semana.');
  const d = new Date(today + 'T12:00:00Z');
  const semana = d.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  return { semana, fuentes, kpisSemanales: kpis, mrr, pnl, caja, seguimiento: seg, notas };
}

export { usd };
