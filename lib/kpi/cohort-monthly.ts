/**
 * Cohortes mensuales de compra para el brief de cohortes (primer día hábil del mes).
 *
 * NO recalcula nada: lee las celdas que el proyecto kinedu-cohorts calcula cada noche desde BigQuery y guarda en
 * su Supabase (`cohort_cells`). Así el canal y el dashboard de cohortes dan siempre el mismo número, y las
 * definiciones son las que ese proyecto validó contra Tableau (ver kinedu-cohorts/VALIDACION.md):
 *   - `ltv`            an_learn_sales (neto de refunds); cohorte = mes del primer pago. users = pagadores en cada
 *                      mes relativo; revenue_net_usd = neto de comisiones de tienda (tasas medidas).
 *   - `churn_cohort_m` in_track_subscriptions; churned en el mes relativo en que terminó el último periodo pagado.
 *                      Réplica del Tableau "Churn by Cohort".
 *   - `retention`      notificaciones de tiendas: apagó la renovación automática (≠ dejó de pagar).
 *   - `revenue_dist_m` revenue cobrado (`revenue_cash`) y gasto de adquisición del mes (`spend`, rel 0) → ROAS.
 *
 * Requiere COHORTS_SUPABASE_URL y COHORTS_SUPABASE_SERVICE_ROLE_KEY (las del proyecto kinedu-cohorts). Sin ellas
 * devuelve null y el brief sale sin la sección mensual.
 *
 * Fechas de mes siempre como texto 'YYYY-MM' (la guía de kinedu-cohorts: un Date en UTC−6 ya costó $31K).
 */
import { createClient } from '@supabase/supabase-js';

type Flag = 'mejor' | 'peor' | null;
const VIEWS = ['ltv', 'churn_cohort_m', 'retention', 'revenue_dist_m'] as const;
const ROWS = 13;      // cohortes en la tabla (el último mes completo y los 12 anteriores)
const PRIOR = 3;      // base = las 3 cohortes previas a la misma edad
const MIN_PCT = 10;
const MIN_PAYERS = 1000;

/** 'YYYY-MM' + n meses (n puede ser negativo). */
export function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}
export function monthDiff(a: string, b: string): number {
  const [ya, ma] = a.split('-').map(Number); const [yb, mb] = b.split('-').map(Number);
  return (yb * 12 + mb) - (ya * 12 + ma);
}
const MONTHS_ES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
export const monthLabel = (ym: string) => { const [y, m] = ym.split('-'); return `${MONTHS_ES[Number(m) - 1]} ${y.slice(2)}`; };

interface Cell { view: string; cohort_month: string; rel_month: number; metric: string; value: number }

async function fetchCells(from: string): Promise<Cell[] | null> {
  const url = process.env.COHORTS_SUPABASE_URL, key = process.env.COHORTS_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error('[cohort-monthly] faltan COHORTS_SUPABASE_URL / COHORTS_SUPABASE_SERVICE_ROLE_KEY'); return null; }
  const sb = createClient(url, key, { auth: { persistSession: false } });
  const out: Cell[] = [];
  let lastId = 0;
  // Paginación por llave (keyset), no por offset: la guía de kinedu-cohorts lo exige.
  for (let i = 0; i < 50; i++) {
    const { data, error } = await sb.from('cohort_cells')
      .select('id,view,cohort_month,rel_month,metric,value')
      .in('view', VIEWS as unknown as string[])
      .eq('store', 'all').eq('sku', 'all').eq('plan', 'all').eq('region', 'all')
      .gte('cohort_month', from)
      .gt('id', lastId).order('id').limit(1000);
    if (error) { console.error('[cohort-monthly] supabase:', error.message); return null; }
    if (!data?.length) break;
    for (const r of data) out.push({ view: r.view, cohort_month: r.cohort_month, rel_month: Number(r.rel_month), metric: r.metric, value: Number(r.value) });
    lastId = data[data.length - 1].id;
    if (data.length < 1000) break;
  }
  return out;
}

export interface MonthlyCheck { label: string; cohort: string; value: number | null; base: number | null; rel: number | null; flag: Flag; fmt: 'usd' | 'pct' }
export interface MonthlyRow {
  cohort: string; payers: number;
  ltv: Record<0 | 3 | 6 | 12, number | null>;
  alive6: number | null; renew12: number | null; autoOff: number | null; roas: number | null;
}
export interface CohortMonthly { lastMonth: string; rows: MonthlyRow[]; checks: MonthlyCheck[]; computedNote: string }

/**
 * `today` = 'YYYY-MM-DD' (MX). Último mes completo = el anterior al de hoy. Una métrica a la edad k solo existe si
 * la cohorte ya cumplió k meses completos (cohorte + k ≤ último mes completo).
 */
export async function buildCohortMonthly(today: string): Promise<CohortMonthly | null> {
  const lastMonth = addMonths(today.slice(0, 7), -1);
  const first = addMonths(lastMonth, -(ROWS - 1) - PRIOR - 12);
  const cells = await fetchCells(first);
  if (!cells) return null;

  const get = (view: string, metric: string, c: string, rel: number) =>
    cells.filter((x) => x.view === view && x.metric === metric && x.cohort_month === c && x.rel_month === rel).reduce((a, x) => a + x.value, 0);
  const sumTo = (view: string, metric: string, c: string, maxRel: number) =>
    cells.filter((x) => x.view === view && x.metric === metric && x.cohort_month === c && x.rel_month <= maxRel).reduce((a, x) => a + x.value, 0);
  const age = (c: string) => monthDiff(c, lastMonth);

  // Numerador y denominador de cada métrica, para comparar con cociente de sumas.
  const parts = {
    ltv: (c: string, k: number) => (age(c) >= k ? { n: sumTo('ltv', 'revenue_net_usd', c, k), d: get('ltv', 'users', c, 0) } : null),
    alive6: (c: string) => (age(c) >= 6 ? { n: get('churn_cohort_m', 'users', c, 0) - sumTo('churn_cohort_m', 'churned', c, 6), d: get('churn_cohort_m', 'users', c, 0) } : null),
    renew12: (c: string) => (age(c) >= 12 ? { n: get('ltv', 'users', c, 12), d: get('ltv', 'users', c, 0) } : null),
    autoOff: (c: string) => (age(c) >= 1 ? { n: sumTo('retention', 'cancels', c, 1), d: get('retention', 'users', c, 0) } : null),
  };
  const ratio = (p: { n: number; d: number } | null) => (p && p.d ? p.n / p.d : null);

  const cohorts = Array.from({ length: ROWS }, (_, i) => addMonths(lastMonth, -(ROWS - 1 - i)));
  const rows: MonthlyRow[] = cohorts.map((c) => {
    const spend = get('revenue_dist_m', 'spend', c, 0);
    return {
      cohort: c,
      payers: get('ltv', 'users', c, 0),
      ltv: { 0: ratio(parts.ltv(c, 0)), 3: ratio(parts.ltv(c, 3)), 6: ratio(parts.ltv(c, 6)), 12: ratio(parts.ltv(c, 12)) },
      alive6: ratio(parts.alive6(c)),
      renew12: ratio(parts.renew12(c)),
      autoOff: ratio(parts.autoOff(c)),
      roas: spend ? sumTo('revenue_dist_m', 'revenue_cash', c, age(c)) / spend : null,
    };
  });

  // La cohorte más reciente que ya tiene la métrica vs las 3 anteriores a la misma edad.
  const mk = (label: string, k: number, f: (c: string) => { n: number; d: number } | null, fmt: 'usd' | 'pct', higherIsBetter = true): MonthlyCheck => {
    const c = addMonths(lastMonth, -k);
    const cur = f(c);
    const prior = Array.from({ length: PRIOR }, (_, i) => f(addMonths(c, -(i + 1)))).filter((p): p is { n: number; d: number } => !!p && p.d > 0);
    const pd = prior.reduce((a, p) => a + p.d, 0);
    const value = ratio(cur);
    const base = pd ? prior.reduce((a, p) => a + p.n, 0) / pd : null;
    const rel = value !== null && base ? ((value - base) / base) * 100 : null;
    const enough = !!cur && cur.d >= MIN_PAYERS && prior.length === PRIOR;
    const flag: Flag = enough && rel !== null && Math.round(Math.abs(rel)) >= MIN_PCT ? ((higherIsBetter ? rel > 0 : rel < 0) ? 'mejor' : 'peor') : null;
    return { label, cohort: c, value, base, rel, flag, fmt };
  };
  const checks = [
    mk('LTV neto en el mes de compra', 0, (c) => parts.ltv(c, 0), 'usd'),
    mk('LTV neto a 3 meses', 3, (c) => parts.ltv(c, 3), 'usd'),
    mk('Apagó la renovación en sus 2 primeros meses', 1, parts.autoOff, 'pct', false),
    mk('Sigue pagando a 6 meses', 6, parts.alive6, 'pct'),
    mk('Volvió a pagar a 12 meses (renovación anual)', 12, parts.renew12, 'pct'),
  ];

  return { lastMonth, rows, checks, computedNote: 'kinedu-cohorts (cálculo nocturno desde BigQuery)' };
}
