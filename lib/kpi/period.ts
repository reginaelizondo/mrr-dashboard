/**
 * Period utilities — derive ISO Mon-Sun week ranges in Mexico City timezone.
 * The agent runs on Vercel (UTC) but reports against MX business weeks.
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

export interface Period {
  start: string; // YYYY-MM-DD
  end: string;   // YYYY-MM-DD
  label: string;
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
