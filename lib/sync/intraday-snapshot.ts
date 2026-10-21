import { createServerClient } from '@/lib/supabase/server';
import { fetchAgg, sumAgg } from '@/lib/kpi/replica';
import { mxDayProgress, isoWeekday } from '@/lib/kpi/period';

/**
 * Foto del cumulado del día EN CURSO a la hora de corte del sync (kpi_intraday_snapshot, migración 039).
 *
 * La llama el cron /api/cron/kpi-daily después de cada sync que incluye hoy. Con una foto por sync a lo
 * largo del día, en ~2–3 semanas tenemos por (día de semana, hora) la fracción de un día típico ya
 * realizada — la curva intradía con la que el estimado de cierre deja de asumir reparto uniforme.
 *
 * Best-effort: si la tabla aún no existe (migración 039 sin aplicar) o falla el insert, NO rompe el sync.
 */
export async function captureIntradaySnapshot(today: string): Promise<{ captured: boolean; reason?: string; mxHour?: number }> {
  // Cumulado de hoy hasta el corte (todas las dimensiones sumadas).
  const agg = sumAgg(await fetchAgg({ start: today, end: today }, 'total'), 'total');
  const prog = mxDayProgress(new Date().toISOString());
  // Solo tiene sentido si el corte cae en el día que estamos fotografiando.
  if (prog.dateMx !== today) return { captured: false, reason: 'el corte no es de hoy' };

  const { error } = await createServerClient().from('kpi_intraday_snapshot').insert({
    day: today,
    weekday: isoWeekday(today),
    cutoff_at: new Date().toISOString(),
    mx_hour: prog.hours,
    fraction: prog.fraction,
    signups: agg.signups,
    new_subscriptions: agg.new_subscriptions,
    new_subscriptions_sales: agg.new_subscriptions_sales,
    spend: agg.spend,
    agg,
  });
  if (error) return { captured: false, reason: error.message, mxHour: prog.hours };
  return { captured: true, mxHour: prog.hours };
}
