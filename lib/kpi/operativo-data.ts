import { unstable_cache } from 'next/cache';
import { fetchAgg, fetchDimValues, fetchReplicaStatus, fetchStoreCoverage, fetchLastGuard, sumAgg, type Grain, type ReplicaFilters, type AggRow, type ReplicaStatus } from '@/lib/kpi/replica';
import { todayMx, addDays, mondayOf } from '@/lib/kpi/period';

/**
 * Datos de la página Operativo (réplica del Looker): resolución de periodo/filtros, cargadores cacheados y
 * pre-calentado de la caché después de cada sync. Ver docs/OPERATIVO.md → Rendimiento.
 */

// ─── Carga de datos (optimizada 2026-10-16) ──────────────────────────────────
// Antes: 14 llamadas por carga (≈ 4 s), la serie diaria × país paginaba 4 veces (≈ 2.6 s). Ahora:
//  · los totales (periodo, OS, idioma, región) se derivan de las series por dimensión — sin llamadas extra;
//  · la serie × país solo trae los 9 países con más spend (el resto va como "Other", que es lo que grafica);
//  · todo se cachea por combinación de filtros con la etiqueta 'operativo'; los syncs de la réplica y de
//    tiendas la invalidan al terminar (revalidateTag), así que nunca se sirve un dato más viejo que el sync.
const TOP_COUNTRIES = 9;

/** Suma filas por periodo (todas las filas de una dimensión cubren el total del periodo). */
function byPeriod(rows: AggRow[]): AggRow[] {
  const m = new Map<string, AggRow[]>();
  for (const r of rows) (m.get(r.period) ?? m.set(r.period, []).get(r.period)!).push(r);
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([p, rs]) => sumAgg(rs, p, ''));
}
/** Suma filas por grupo (total del rango por valor de la dimensión). */
function byGroup(rows: AggRow[]): AggRow[] {
  const m = new Map<string, AggRow[]>();
  for (const r of rows) (m.get(r.grp) ?? m.set(r.grp, []).get(r.grp)!).push(r);
  return [...m.entries()].map(([g, rs]) => sumAgg(rs, 'total', g));
}
const spendOnly = (rows: AggRow[]) => rows.map((a) => ({ period: a.period, grp: a.grp, spend: a.spend }));

// La caché de Next guarda hasta 2 MB por entrada: se guarda solo lo que la página usa (serie y totales ya
// sumados; de las series por dimensión, solo el spend). Diario × 90 días pasaba de 2 MB y no se cacheaba.
export const loadCore = unstable_cache(
  async (f: ReplicaFilters, grain: Grain, prior: ReplicaFilters) => {
    const [seriesOs, seriesLang, seriesRegion, totalCountry, prev] = await Promise.all([
      fetchAgg(f, grain, 'os'), fetchAgg(f, grain, 'kinedu_language'), fetchAgg(f, grain, 'kinedu_region'),
      fetchAgg(f, 'total', 'country'), fetchAgg(prior, 'total'),
    ]);
    const top = [...totalCountry].filter((r) => r.grp !== 'null').sort((a, b) => b.spend - a.spend).slice(0, TOP_COUNTRIES).map((r) => r.grp);
    const countrySeries = top.length ? await fetchAgg({ ...f, country: top }, grain, 'country') : [];
    const series = byPeriod(seriesOs);
    // Serie × país: los 9 con más spend + "Other" = total del periodo − esos 9 (solo se usa el spend).
    const topSpend = new Map<string, number>();
    for (const r of countrySeries) topSpend.set(r.period, (topSpend.get(r.period) ?? 0) + r.spend);
    return {
      series, current: sumAgg(seriesOs, 'total'), previous: sumAgg(prev, 'total'),
      breakdown: { os: byGroup(seriesOs), kinedu_language: byGroup(seriesLang), kinedu_region: byGroup(seriesRegion), country: totalCountry },
      groupSeries: {
        os: spendOnly(seriesOs), kinedu_language: spendOnly(seriesLang), kinedu_region: spendOnly(seriesRegion),
        country: [
          ...spendOnly(countrySeries),
          ...series.map((p) => ({ period: p.period, grp: 'Other', spend: Math.max(0, p.spend - (topSpend.get(p.period) ?? 0)) })).filter((x) => x.spend > 0.005),
        ],
      },
    };
  },
  ['operativo-core', 'v2'],
  { revalidate: 1800, tags: ['operativo'] },
);
export const loadDims = unstable_cache(async () => fetchDimValues(), ['operativo-dims', 'v1'], { revalidate: 86400, tags: ['operativo'] });
export const loadMeta = unstable_cache(
  async (start: string, end: string) => {
    const [status, storeCoverage, guard] = await Promise.all([
      // Informativo: si falla, la página carga igual.
      fetchReplicaStatus().catch((): ReplicaStatus => ({ minDate: null, maxDate: null, rows: 0, lastSyncedAt: null, lastJob: null })),
      fetchStoreCoverage(start, end).catch(() => []),
      fetchLastGuard().catch(() => null),
    ]);
    return { status, storeCoverage, guard };
  },
  ['operativo-meta', 'v1'],
  { revalidate: 300, tags: ['operativo'] },
);



/**
 * "Operativo" — réplica del Looker Operational Dashboard sobre kpi_daily (Supabase).
 * Mismos filtros (fecha, kinedu_region, country, os, kinedu_language), misma tabla
 * fuente, mismas fórmulas; con un selector de granularidad que reemplaza las 5 copias
 * de cada página del Looker y un toggle de definición (Looker / corregido).
 */

export type Preset = 'yesterday' | '7d' | 'wtd' | 'mtd' | '30d' | '90d' | 'ytd' | '12m' | 'all' | 'custom';

export interface PageParams {
  preset?: string; start?: string; end?: string; grain?: string;
  region?: string; country?: string; os?: string; lang?: string;
}

const PRESETS: Preset[] = ['yesterday', '7d', 'wtd', 'mtd', '30d', '90d', 'ytd', '12m', 'all', 'custom'];
const GRAINS: Grain[] = ['day', 'week', 'month', 'quarter', 'year'];

export function resolveRange(p: PageParams): { preset: Preset; start: string; end: string; grain: Grain } {
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


/** Periodo, filtros y periodo previo exactamente como los arma la página (la caché depende de que coincidan). */
export function buildRequest(params: PageParams) {
  const range = resolveRange(params);
  const filters: ReplicaFilters = {
    start: range.start, end: range.end,
    region: splitParam(params.region), country: splitParam(params.country), os: splitParam(params.os), language: splitParam(params.lang),
  };
  const days = Math.round((Date.parse(range.end) - Date.parse(range.start)) / 86400000) + 1;
  const prior: ReplicaFilters = { ...filters, start: addDays(range.start, -days), end: addDays(range.start, -1) };
  return { range, filters, prior, days };
}

/** Pre-calienta la caché de las vistas más usadas (sin filtros). Lo llaman los syncs tras invalidarla. */
export async function warmOperativoCache(presets: Preset[] = ['30d', '7d', 'mtd', '90d', '12m']): Promise<{ preset: Preset; ms: number }[]> {
  const out: { preset: Preset; ms: number }[] = [];
  await loadDims();
  for (const preset of presets) {
    const t0 = Date.now();
    const { range, filters, prior } = buildRequest({ preset });
    await Promise.all([loadCore(filters, range.grain, prior), loadMeta(range.start, range.end)]);
    out.push({ preset, ms: Date.now() - t0 });
  }
  return out;
}
