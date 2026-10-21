export const dynamic = 'force-dynamic';
export const maxDuration = 30;

import { OperativoContent, type OperativoData, type PeriodRow, type GroupRow, type TodayBlock, type DefPair } from '@/components/dashboard/OperativoContent';
import { computeKpis, scaleAgg, projectAgg, type AggRow } from '@/lib/kpi/replica';
import { loadCore, loadDims, loadMeta, loadToday, buildRequest, type PageParams } from '@/lib/kpi/operativo-data';
import { todayMx, mxDayProgress } from '@/lib/kpi/period';
export type { Preset } from '@/lib/kpi/operativo-data';
const pair = (a: AggRow): DefPair => ({ looker: computeKpis(a, 'looker'), fixed: computeKpis(a, 'fixed') });
// Antes de ~2.4 h del día MX la proyección a ritmo lineal multiplica por >10 y no es informativa.
const MIN_FRACTION = 0.1;
function toPeriodRows(rows: AggRow[]): PeriodRow[] {
  return rows.map((a) => ({ period: a.period, looker: computeKpis(a, 'looker'), fixed: computeKpis(a, 'fixed') }));
}
function toGroupRows(rows: AggRow[]): GroupRow[] {
  return rows.map((a) => ({ period: a.period, grp: a.grp, looker: computeKpis(a, 'looker'), fixed: computeKpis(a, 'fixed') }));
}

export default async function OperativoPage({ searchParams }: { searchParams: Promise<PageParams> }) {
  const params = await searchParams;
  const { range, filters, prior, days } = buildRequest(params);

  let error: string | null = null;
  let data: OperativoData | null = null;
  try {
    const today = todayMx();
    const [core, dims, meta, todayAggs] = await Promise.all([
      loadCore(filters, range.grain, prior), loadDims(), loadMeta(range.start, range.end),
      loadToday({ region: filters.region ?? [], country: filters.country ?? [], os: filters.os ?? [], language: filters.language ?? [] }, today),
    ]);
    const { series, current: cur, previous: prev, breakdown, groupSeries } = core;
    const { status, storeCoverage, guard } = meta;

    // Franja "Hoy": lo que va del día, proyección del cierre a ritmo lineal (sobre la fracción del día
    // MX ya transcurrida AL CORTE de los datos) y comparación vs el mismo día de semana (últimos N).
    const running = pair(todayAggs.today);
    const hasData = running.looker.signups > 0 || running.looker.spend > 0 || running.looker.newSubs > 0 || running.looker.nsSales > 0;
    const prog = status.lastSyncedAt ? mxDayProgress(status.lastSyncedAt) : null;
    const stale = prog ? prog.dateMx !== today : true;           // el último sync no es de hoy
    const fraction = prog && !stale ? prog.fraction : null;
    const tooEarly = fraction !== null && fraction < MIN_FRACTION;
    const canProject = fraction !== null && !tooEarly && fraction > 0;
    // Afinado: ya-entró-hoy + resto de un día típico (con spend de día típico). Sin base del mismo día
    // de semana cae al estimado crudo por ritmo (lo que va ÷ fracción).
    const projected = canProject
      ? (todayAggs.baselineDays ? pair(projectAgg(todayAggs.today, todayAggs.baseline, fraction!)) : pair(scaleAgg(todayAggs.today, 1 / fraction!)))
      : null;
    const todayBlock: TodayBlock = {
      date: today,
      cutoffIso: status.lastSyncedAt, cutoffLabel: prog?.label ?? null, fraction,
      stale, tooEarly, hasData, baselineDays: todayAggs.baselineDays,
      running,
      projected,
      baseline: todayAggs.baselineDays ? pair(todayAggs.baseline) : null,
      yesterday: pair(todayAggs.yesterday),
    };
    data = {
      preset: range.preset, start: range.start, end: range.end, grain: range.grain, days,
      filters: { region: filters.region ?? [], country: filters.country ?? [], os: filters.os ?? [], language: filters.language ?? [] },
      totals: { current: { looker: computeKpis(cur, 'looker'), fixed: computeKpis(cur, 'fixed') }, previous: { looker: computeKpis(prev, 'looker'), fixed: computeKpis(prev, 'fixed') }, priorStart: prior.start, priorEnd: prior.end },
      series: toPeriodRows(series),
      breakdown: { os: toGroupRows(breakdown.os), country: toGroupRows(breakdown.country), kinedu_language: toGroupRows(breakdown.kinedu_language), kinedu_region: toGroupRows(breakdown.kinedu_region) },
      groupSeries,
      dims: dims.map((d) => ({ dim: d.dim, value: d.value, signups: d.signups })),
      status,
      storeCoverage,
      guard,
      today: todayBlock,
      generatedAt: new Date().toISOString(),
    };
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[#0E3687]">Operativo</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Réplica del Looker Operational Dashboard sobre la copia diaria de BigQuery (kpi_daily) — mismos filtros, misma fuente, mismas fórmulas, verificada cada mañana.
        </p>
      </div>
      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          No pude leer la réplica: {error}. Si acabas de crear la tabla, falta correr la migración 032 (funciones kpi_daily_agg, kpi_daily_dim_values, kpi_daily_status).
        </div>
      ) : data ? (
        <OperativoContent data={data} />
      ) : null}
    </div>
  );
}
