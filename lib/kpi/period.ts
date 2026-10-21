/**
 * Period utilities — derive ISO Mon-Sun week ranges and day ranges in Mexico City time.
 * The agent runs on Vercel (UTC) but reports against MX business days/weeks.
 *
 * All date math is done on 'YYYY-MM-DD' strings via Date.UTC(), never via local-time
 * Date objects — local-time math shifts a day/month in UTC-6 (see feedback_tz_month_math).
 */

const MX_TZ_OFFSET_HOURS = -6; // Mexico City is UTC-6 year-round (no DST since 2022)

function nowInMx(): Date {
  const utcNow = new Date();
  return new Date(utcNow.getTime() + MX_TZ_OFFSET_HOURS * 3600 * 1000);
}

function fmtDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 'YYYY-MM-DD' → Date at UTC midnight (safe for UTC-based arithmetic). */
function parseDay(s: string): Date {
  return new Date(s + 'T00:00:00Z');
}

export interface Period {
  start: string; // YYYY-MM-DD
  end: string;   // YYYY-MM-DD
  label: string;
}

/** Today's calendar date in Mexico City as 'YYYY-MM-DD'. */
export function todayMx(): string {
  const n = nowInMx();
  return fmtDate(new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate())));
}

/**
 * Progreso del día de Ciudad de México en el instante `iso` dado: qué fecha MX es, cuántas
 * horas del día llevaban transcurridas y qué fracción (0–1). Se usa para proyectar el cierre
 * del día a ritmo lineal: la fracción se mide sobre la HORA DE CORTE de los datos (último sync),
 * no sobre el reloj, porque entre reconstrucciones de dbt el dato de "hoy" queda congelado.
 */
export function mxDayProgress(iso: string): { dateMx: string; hours: number; fraction: number; label: string } {
  const mx = new Date(new Date(iso).getTime() + MX_TZ_OFFSET_HOURS * 3600 * 1000);
  const dateMx = fmtDate(new Date(Date.UTC(mx.getUTCFullYear(), mx.getUTCMonth(), mx.getUTCDate())));
  const hours = mx.getUTCHours() + mx.getUTCMinutes() / 60;
  const label = `${String(mx.getUTCHours()).padStart(2, '0')}:${String(mx.getUTCMinutes()).padStart(2, '0')}`;
  return { dateMx, hours, fraction: Math.min(1, Math.max(0, hours / 24)), label };
}

/** Add (or subtract) whole days to a 'YYYY-MM-DD' string. */
export function addDays(day: string, delta: number): string {
  const d = parseDay(day);
  d.setUTCDate(d.getUTCDate() + delta);
  return fmtDate(d);
}

/** 0 = Monday … 6 = Sunday (ISO). */
export function isoWeekday(day: string): number {
  const dow = parseDay(day).getUTCDay(); // 0=Sun
  return dow === 0 ? 6 : dow - 1;
}

/** Monday of the ISO week containing `day`. */
export function mondayOf(day: string): string {
  return addDays(day, -isoWeekday(day));
}

/** Single-day period. */
export function dayPeriod(day: string): Period {
  return { start: day, end: day, label: day };
}

/** Inclusive range period. */
export function rangePeriod(start: string, end: string): Period {
  return { start, end, label: `${start} → ${end}` };
}

/**
 * Returns the most recent COMPLETE Mon-Sun week (ending before today).
 * If today is Mon, returns last week (Mon-Sun that just finished).
 */
export function lastCompleteWeek(reference: Date = nowInMx()): Period {
  const ref = new Date(Date.UTC(
    reference.getFullYear(), reference.getMonth(), reference.getDate()
  ));
  const dayOfWeek = ref.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  // Sunday that ended last complete week
  const lastSunday = new Date(ref);
  lastSunday.setUTCDate(ref.getUTCDate() - daysSinceMonday - 1);
  const lastMonday = new Date(lastSunday);
  lastMonday.setUTCDate(lastSunday.getUTCDate() - 6);
  return {
    start: fmtDate(lastMonday),
    end: fmtDate(lastSunday),
    label: `${fmtDate(lastMonday)} → ${fmtDate(lastSunday)}`,
  };
}

/**
 * The week immediately before the given period (also Mon-Sun).
 */
export function priorWeek(period: Period): Period {
  const start = new Date(period.start + 'T00:00:00Z');
  const prevSunday = new Date(start);
  prevSunday.setUTCDate(start.getUTCDate() - 1);
  const prevMonday = new Date(prevSunday);
  prevMonday.setUTCDate(prevSunday.getUTCDate() - 6);
  return {
    start: fmtDate(prevMonday),
    end: fmtDate(prevSunday),
    label: `${fmtDate(prevMonday)} → ${fmtDate(prevSunday)}`,
  };
}

// --- Spanish labels -----------------------------------------------------------

const DOW_ES = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
const DOW_ES_SHORT = ['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'];
const MONTH_ES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const MONTH_ES_LONG = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** 'lunes 12 de octubre' */
export function dayLabelEs(day: string): string {
  const d = parseDay(day);
  return `${DOW_ES[isoWeekday(day)]} ${d.getUTCDate()} de ${MONTH_ES_LONG[d.getUTCMonth()]}`;
}

/** 'dom 11-oct' */
export function dayShortEs(day: string): string {
  const d = parseDay(day);
  return `${DOW_ES_SHORT[isoWeekday(day)]} ${d.getUTCDate()}-${MONTH_ES[d.getUTCMonth()]}`;
}

/** '5–11 oct' (same month) or '28 sep–4 oct' */
export function rangeShortEs(start: string, end: string): string {
  const s = parseDay(start), e = parseDay(end);
  if (s.getUTCMonth() === e.getUTCMonth()) {
    return `${s.getUTCDate()}–${e.getUTCDate()} ${MONTH_ES[e.getUTCMonth()]}`;
  }
  return `${s.getUTCDate()} ${MONTH_ES[s.getUTCMonth()]}–${e.getUTCDate()} ${MONTH_ES[e.getUTCMonth()]}`;
}
