/**
 * Cal · fuente Google Calendar.
 *
 * Lee el calendario "Kinedu INC y SAPI fillings" con una cuenta de servicio de BizOps
 * (hay que compartir el calendario con su correo como "ver todos los detalles").
 * Si no está configurado, Cal usa data/cal/compliance.json.
 *
 * Convención en la descripción del evento: "[Cal: alertas 30,15,5]" fija los días de aviso.
 * Sin esa marca, Cal avisa a 30, 15, 5 y 1 días.
 */
import type { CalItem } from './cal';

export const CAL_CALENDAR_ID = () =>
  process.env.CAL_CALENDAR_ID ?? 'c_22e075dc173c1294c45a8f9ce4e37eca8d284a12593badce2ac40c3c19cef018@group.calendar.google.com';

const DEFAULT_ALERTS = [30, 15, 5, 1];

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseAlerts(desc: string): number[] {
  const m = desc.match(/\[Cal:\s*alertas\s*([0-9,\s]+)\]/i);
  if (!m) return DEFAULT_ALERTS;
  const n = m[1].split(',').map((x) => Number(x.trim())).filter((x) => Number.isFinite(x) && x >= 0);
  return n.length ? n : DEFAULT_ALERTS;
}

/** Devuelve null si la fuente no está configurada o falla (el llamador usa el JSON). */
export async function loadCalendarItems(fromDay: string, days = 120): Promise<CalItem[] | null> {
  const keyB64 = process.env.BIZOPS_GCP_SA_KEY_B64 ?? process.env.ESTELA_GCP_SA_KEY_B64;
  if (!keyB64) return null;
  try {
    const { google } = await import('googleapis');
    const creds = JSON.parse(Buffer.from(keyB64, 'base64').toString('utf8'));
    const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/calendar.readonly'] });
    const cal = google.calendar({ version: 'v3', auth });
    const timeMin = new Date(fromDay + 'T00:00:00Z'); timeMin.setUTCDate(timeMin.getUTCDate() - 14);
    const timeMax = new Date(fromDay + 'T00:00:00Z'); timeMax.setUTCDate(timeMax.getUTCDate() + days);
    const res = await cal.events.list({
      calendarId: CAL_CALENDAR_ID(), singleEvents: true, orderBy: 'startTime',
      timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(), maxResults: 250,
    });
    const items: CalItem[] = [];
    for (const e of res.data.items ?? []) {
      // Las fechas límite son eventos de día completo; en eventos de varios días cuenta el ÚLTIMO día (end es exclusivo).
      const start = e.start?.date ?? e.start?.dateTime?.slice(0, 10);
      const endExcl = e.end?.date ?? e.end?.dateTime?.slice(0, 10);
      if (!start) continue;
      let fecha = start;
      if (e.end?.date && endExcl) {
        const d = new Date(endExcl + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 1);
        fecha = d.toISOString().slice(0, 10);
      }
      const desc = stripHtml(e.description ?? '');
      items.push({
        id: e.id ?? `${fecha}-${e.summary}`,
        titulo: (e.summary ?? '(sin título)').trim(),
        fecha,
        entidad: /sapi/i.test(e.summary ?? '') ? 'SAPI' : /inc|delaware|1099|1120|carta|stripe/i.test(e.summary ?? '') ? 'INC' : 'Kinedu',
        responsable: 'Pepis',
        ejecuta: desc.slice(0, 160) || 'ver evento',
        fuente: 'Google Calendar · Kinedu INC y SAPI fillings',
        alertas: parseAlerts(desc),
        notas: '',
      });
    }
    return items;
  } catch (err) {
    console.error('[cal] calendar source failed:', err instanceof Error ? err.message : err);
    return null;
  }
}
