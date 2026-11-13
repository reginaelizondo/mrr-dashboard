import { unstable_cache } from 'next/cache';
import { createServerClient } from '@/lib/supabase/server';

/**
 * Curva intradía calibrada: s(weekday, hora, kpi) = fracción de un día típico ya realizada
 * a esa hora para ese KPI, promediando los mismos días de semana recientes ya cerrados.
 *
 * La construye desde kpi_intraday_snapshot (migración 039; alimentada por el cron kpi-daily
 * vía lib/sync/intraday-snapshot.ts). Con ella, el estimado de cierre del Operativo deja de
 * asumir reparto uniforme ("today + (1 - hora/24) * día típico") y usa "lo_que_va / s" —
 * en validación leave-one-out sobre 23 días cerrados el MAE bajó 3–7× por bucket.
 *
 * Fallback por diseño: si para un (weekday, hora, kpi) no hay suficientes muestras cerradas
 * (n < MIN_SAMPLES) o la share es poco informativa (< MIN_SHARE), getShare() devuelve null
 * y el caller cae al método actual. Spend se mantiene del día típico (retraso de ads).
 */

const KPIS = ['signups', 'new_subscriptions', 'new_subscriptions_sales'] as const;
export type CurveKpi = (typeof KPIS)[number];

const MIN_CLOSE_HOUR = 19;     // última foto del día >= 19h MX para considerarlo "cerrado"
const MIN_SAMPLES = 2;         // mínimo de muestras por (weekday, hora, kpi) para confiar
const MIN_SHARE = 0.02;        // share menor a esto no se usa (división inestable)
const HOUR_TOLERANCE = 1.5;    // nearest-hour match cuando la hora pedida no está exacta

interface CurvePoint {
  hour: number;
  n: number;
  shares: Partial<Record<CurveKpi, number>>;
}

export interface IntradayCurve {
  /** Por weekday (0=Lun … 6=Dom), lista de puntos ordenados por hora. */
  points: Map<number, CurvePoint[]>;
  /** Cuántos días cerrados contribuyeron. Útil para diagnóstico. */
  closedDays: number;
  /** Última actualización (fecha del día cerrado más reciente). */
  freshDay: string | null;
  /**
   * Devuelve la share s(weekday, hora, kpi) del día típico ya realizada, o null si no hay
   * suficientes muestras. Usa nearest-hour dentro de HOUR_TOLERANCE.
   */
  getShare(weekday: number, hour: number, kpi: CurveKpi): number | null;
}

interface SnapshotRow {
  day: string;
  weekday: number;
  mx_hour: number;
  signups: number;
  new_subscriptions: number;
  new_subscriptions_sales: number;
}

function buildCurve(rows: SnapshotRow[]): IntradayCurve {
  // Agrupar por día y encontrar días "cerrados".
  const byDay = new Map<string, SnapshotRow[]>();
  for (const r of rows) {
    const arr = byDay.get(r.day) ?? [];
    arr.push(r);
    byDay.set(r.day, arr);
  }
  const closed: { day: string; weekday: number; snaps: SnapshotRow[]; close: SnapshotRow }[] = [];
  for (const [day, snaps] of byDay) {
    snaps.sort((a, b) => a.mx_hour - b.mx_hour);
    const last = snaps[snaps.length - 1];
    if (last.mx_hour >= MIN_CLOSE_HOUR) closed.push({ day, weekday: last.weekday, snaps, close: last });
  }

  // Acumular shares por (weekday, hora, kpi). La hora se bucketa en 0.5 h para colapsar
  // ligeras variaciones entre syncs del mismo "slot".
  const acc = new Map<number, Map<string, { hour: number; n: number; sums: Record<string, number>; counts: Record<string, number> }>>();
  for (const { weekday, snaps, close } of closed) {
    for (const s of snaps) {
      if (s.mx_hour >= MIN_CLOSE_HOUR) continue; // la foto de cierre no es un "slot intradía"
      const hourBucket = Math.round(s.mx_hour * 2) / 2;
      const hbKey = hourBucket.toFixed(1);
      if (!acc.has(weekday)) acc.set(weekday, new Map());
      const wd = acc.get(weekday)!;
      if (!wd.has(hbKey)) wd.set(hbKey, { hour: hourBucket, n: 0, sums: {}, counts: {} });
      const b = wd.get(hbKey)!;
      b.n++;
      for (const k of KPIS) {
        const closeVal = close[k];
        const snapVal = s[k];
        if (closeVal > 0 && Number.isFinite(snapVal)) {
          b.sums[k] = (b.sums[k] ?? 0) + snapVal / closeVal;
          b.counts[k] = (b.counts[k] ?? 0) + 1;
        }
      }
    }
  }

  // Colapsar a medias por bucket.
  const points = new Map<number, CurvePoint[]>();
  for (const [wd, buckets] of acc) {
    const list: CurvePoint[] = [];
    for (const b of buckets.values()) {
      const shares: CurvePoint['shares'] = {};
      for (const k of KPIS) {
        if ((b.counts[k] ?? 0) >= MIN_SAMPLES) shares[k] = b.sums[k] / b.counts[k];
      }
      list.push({ hour: b.hour, n: b.n, shares });
    }
    list.sort((a, b) => a.hour - b.hour);
    points.set(wd, list);
  }

  const freshDay = closed.length ? closed.map((d) => d.day).sort().reverse()[0] : null;

  return {
    points,
    closedDays: closed.length,
    freshDay,
    getShare(weekday, hour, kpi) {
      const list = points.get(weekday);
      if (!list || !list.length) return null;
      let best: CurvePoint | null = null;
      let bestDiff = Infinity;
      for (const p of list) {
        const diff = Math.abs(p.hour - hour);
        if (diff < bestDiff && p.shares[kpi] != null) { bestDiff = diff; best = p; }
      }
      if (!best || bestDiff > HOUR_TOLERANCE) return null;
      const s = best.shares[kpi];
      if (s == null || s < MIN_SHARE || s > 1) return null;
      return s;
    },
  };
}

/** Lookback de 42 días para acumular ~6 muestras por weekday sin incluir señal vieja. */
const LOOKBACK_DAYS = 42;

export const loadIntradayCurve = unstable_cache(
  async (): Promise<IntradayCurve> => {
    const since = new Date(Date.now() - LOOKBACK_DAYS * 86400_000).toISOString().slice(0, 10);
    const { data, error } = await createServerClient()
      .from('kpi_intraday_snapshot')
      .select('day, weekday, mx_hour, signups, new_subscriptions, new_subscriptions_sales')
      .gte('day', since)
      .order('day', { ascending: true })
      .order('mx_hour', { ascending: true });
    if (error || !data) {
      return { points: new Map(), closedDays: 0, freshDay: null, getShare: () => null };
    }
    return buildCurve(data as SnapshotRow[]);
  },
  ['intraday-curve', 'v1'],
  { revalidate: 3600, tags: ['operativo'] },
);
