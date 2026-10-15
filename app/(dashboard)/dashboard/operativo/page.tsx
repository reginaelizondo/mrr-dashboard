export const dynamic = 'force-dynamic';
export const maxDuration = 30;

import { OperativoContent, type OperativoData, type PeriodRow, type GroupRow } from '@/components/dashboard/OperativoContent';
import { fetchAgg, fetchDimValues, fetchReplicaStatus, computeKpis, sumAgg, type Grain, type ReplicaFilters, type AggRow, type ReplicaStatus } from '@/lib/kpi/replica';
import { todayMx, addDays, mondayOf } from '@/lib/kpi/period';

/**
 * "Operativo" — réplica del Looker Operational Dashboard sobre kpi_daily (Supabase).
 * Mismos filtros (fecha, kinedu_region, country, os, kinedu_language), misma tabla
 * fuente, mismas fórmulas; con un selector de granularidad que reemplaza las 5 copias
 * de cada página del Looker y un toggle de definición (Looker / corregido).
 */

export type Preset = 'yesterday' | '7d' | 'wtd' | 'mtd' | '30d' | '90d' | 'ytd' | '12m' | 'all' | 'custom';

interface PageParams {
  preset?: string; start?: string; end?: string; grain?: string;
  region?: string; country?: string; os?: string; lang?: string;
}

const PRESETS: Preset[] = ['yesterday', '7d', 'wtd', 'mtd', '30d', '90d', 'ytd', '12m', 'all', 'custom'];
const GRAINS: Grain[] = ['day', 'week', 'month', 'quarter', 'year'];

function resolveRange(p: PageParams): { preset: Preset; start: string; end: string; grain: Grain } {
  const today = todayMx();
  let preset = (PRESETS.includes(p.preset as Preset) ? p.preset : '30d') as Preset;
  let start: string; let end = today;
  switch (preset) {
    case 'yesterday': start = end = addDays(today, -1); break;
    case '7d': start = addDays(today, -7); end = addDays(today, -1); break;
    case 'wtd': start = mondayOf(today); break;
    case 'mtd': start = today.slice(0, 8) + '01'; break;
    case '90d': start = addDays(today, -90); end = addDays(today, -1); break;
    case 'ytd': start = today.slice(0, 4) + '-01-01'; break;
    case '12m': start = addDays(today, -365); break;
    case 'all': start = '2024-01-01'; break;
    case 'custom':
      if (p.start && p.end && /^\d{4}-\d{2}-\d{2}$/.test(p.start) && /^\d{4}-\d{2}-\d{2}$/.test(p.end) && p.start <= p.end) { start = p.start; end = p.end; }
      else { preset = '30d'; start = addDays(today, -30); end = addDays(today, -1); }
      break;
    default: start = addDays(today, -30); end = addDays(today, -1);
  }
  const days = Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1;
  const autoGrain: Grain = days <= 100 ? 'day' : days <= 400 ? 'week' : 'month';
  let grain = (GRAINS.includes(p.grain as Grain) ? p.grain : autoGrain) as Grain;
  // Diario sobre más de ~13 meses son >400 columnas ilegibles y una consulta pesada: sube a semana.
  if (grain === 'day' && days > 400) grain = 'week';
  return { preset, start, end, grain };
}

const splitParam = (v?: string) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

function toPeriodRows(rows: AggRow[]): PeriodRow[] {
  return rows.map((a) => ({ period: a.period, looker: computeKpis(a, 'looker'), fixed: computeKpis(a, 'fixed') }));
}
function toGroupRows(rows: AggRow[]): GroupRow[] {
  return rows.map((a) => ({ period: a.period, grp: a.grp, looker: computeKpis(a, 'looker'), fixed: computeKpis(a, 'fixed') }));
}

export default async function OperativoPage({ searchParams }: { searchParams: Promise<PageParams> }) {
  const params = await searchParams;
  const range = resolveRange(params);
  const filters: ReplicaFilters = {
    start: range.start, end: range.end,
    region: splitParam(params.region), country: splitParam(params.country), os: splitParam(params.os), language: splitParam(params.lang),
  };
  const days = Math.round((Date.parse(range.end) - Date.parse(range.start)) / 86400000) + 1;
  const prior: ReplicaFilters = { ...filters, start: addDays(range.start, -days), end: addDays(range.start, -1) };

  let error: string | null = null;
  let data: OperativoData | null = null;
  try {
    const [series, current, previous, byOs, byCountry, byLang, byRegion, seriesOs, seriesLang, seriesRegion, seriesCountry, dims, status] = await Promise.all([
      fetchAgg(filters, range.grain),
      fetchAgg(filters, 'total'),
      fetchAgg(prior, 'total'),
      fetchAgg(filters, 'total', 'os'),
      fetchAgg(filters, 'total', 'country'),
      fetchAgg(filters, 'total', 'kinedu_language'),
      fetchAgg(filters, 'total', 'kinedu_region'),
      fetchAgg(filters, range.grain, 'os'),
      fetchAgg(filters, range.grain, 'kinedu_language'),
      fetchAgg(filters, range.grain, 'kinedu_region'),
      fetchAgg(filters, range.grain, 'country'),
      fetchDimValues(),
      // El estado de la réplica es informativo: si falla, la página carga igual.
      fetchReplicaStatus().catch((): ReplicaStatus => ({ minDate: null, maxDate: null, rows: 0, lastSyncedAt: null, lastJob: null })),
    ]);
    const cur = sumAgg(current, 'total'); const prev = sumAgg(previous, 'total');
    data = {
      preset: range.preset, start: range.start, end: range.end, grain: range.grain, days,
      filters: { region: filters.region ?? [], country: filters.country ?? [], os: filters.os ?? [], language: filters.language ?? [] },
      totals: { current: { looker: computeKpis(cur, 'looker'), fixed: computeKpis(cur, 'fixed') }, previous: { looker: computeKpis(prev, 'looker'), fixed: computeKpis(prev, 'fixed') }, priorStart: prior.start, priorEnd: prior.end },
      series: toPeriodRows(series),
      breakdown: { os: toGroupRows(byOs), country: toGroupRows(byCountry), kinedu_language: toGroupRows(byLang), kinedu_region: toGroupRows(byRegion) },
      groupSeries: {
        os: seriesOs.map((a) => ({ period: a.period, grp: a.grp, spend: a.spend })),
        kinedu_language: seriesLang.map((a) => ({ period: a.period, grp: a.grp, spend: a.spend })),
        kinedu_region: seriesRegion.map((a) => ({ period: a.period, grp: a.grp, spend: a.spend })),
        country: seriesCountry.map((a) => ({ period: a.period, grp: a.grp, spend: a.spend })),
      },
      dims: dims.map((d) => ({ dim: d.dim, value: d.value, signups: d.signups })),
      status,
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
