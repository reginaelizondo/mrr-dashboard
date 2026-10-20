/**
 * Cal · calendario único de cumplimiento (INC y SAPI).
 *
 * Fuente de verdad: data/cal/compliance.json. Cal no decide ni presenta nada: avisa en
 * #bizops-finanzas-agentes con la anticipación definida por cada fecha, y los lunes deja
 * el resumen de lo que viene en 45 días. Quien ejecuta sigue siendo la persona o el
 * despacho que dice cada fecha.
 */
import fs from 'fs';
import path from 'path';
import { todayMx, isoWeekday } from '@/lib/kpi/period';
import { postChatMessage, type SlackMessage } from '@/lib/slack/post';
import { loadCalendarItems } from './calendar-source';

export interface CalItem {
  id: string;
  titulo: string;
  fecha: string;        // YYYY-MM-DD
  entidad: string;
  responsable: string;
  ejecuta: string;
  fuente: string;
  alertas: number[];    // días antes
  notas: string;
}

export interface CalData { items: CalItem[]; pendientes: string[] }

export const CAL_CHANNEL = () => process.env.CAL_SLACK_CHANNEL ?? process.env.ESTELA_SLACK_CHANNEL ?? 'C0CAJT405R7';

export function loadCal(): CalData {
  const file = path.join(process.cwd(), 'data', 'cal', 'compliance.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as CalData;
  const items = [...raw.items].sort((a, b) => a.fecha.localeCompare(b.fecha));
  return { items, pendientes: raw.pendientes ?? [] };
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000);
}

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
export function fmtFecha(d: string): string {
  const [y, m, day] = d.split('-').map(Number);
  return `${day}-${MESES[m - 1]}-${y}`;
}

function cuando(days: number): string {
  if (days < 0) return `venció hace ${-days} día${-days === 1 ? '' : 's'}`;
  if (days === 0) return 'vence HOY';
  if (days === 1) return 'vence MAÑANA';
  return `en ${days} días`;
}

export interface CalRun {
  today: string;
  fuente: 'google-calendar' | 'json';
  alertasHoy: Array<{ item: CalItem; dias: number }>;   // fechas que caen exactamente en un umbral de alerta hoy
  vencidas: Array<{ item: CalItem; dias: number }>;     // pasadas hace ≤ 14 días (Cal no sabe si ya se hicieron)
  proximas45: Array<{ item: CalItem; dias: number }>;
  pendientes: string[];
  esLunes: boolean;
}

export async function runCal(today = todayMx()): Promise<CalRun> {
  const json = loadCal();
  const fromCalendar = await loadCalendarItems(today);
  const items = fromCalendar ?? json.items;
  const pendientes = json.pendientes;
  const withDays = items.map((item) => ({ item, dias: daysBetween(today, item.fecha) }));
  return {
    today,
    fuente: fromCalendar ? 'google-calendar' : 'json',
    alertasHoy: withDays.filter(({ item, dias }) => dias >= 0 && (item.alertas.includes(dias) || dias === 0)),
    vencidas: withDays.filter(({ dias }) => dias < 0 && dias >= -14),
    proximas45: withDays.filter(({ dias }) => dias >= 0 && dias <= 45),
    pendientes,
    esLunes: isoWeekday(today) === 0,
  };
}

type Block = NonNullable<SlackMessage['blocks']>[number];
const section = (text: string): Block => ({ type: 'section', text: { type: 'mrkdwn', text } });

function line({ item, dias }: { item: CalItem; dias: number }): string {
  return `• *${item.titulo}* · ${fmtFecha(item.fecha)} (${cuando(dias)}) · ${item.entidad} · ejecuta: ${item.ejecuta}${item.notas ? `\n   _${item.notas}_` : ''}`;
}

/** Devuelve null cuando no hay nada que decir hoy. */
export function buildCalMessage(run: CalRun): SlackMessage | null {
  const blocks: Block[] = [];
  if (run.alertasHoy.length) {
    blocks.push(section(`*📅 Cal · aviso de cumplimiento*\n${run.alertasHoy.map(line).join('\n')}`));
  }
  if (run.vencidas.length) {
    blocks.push(section(`*Pasaron de fecha (confirma si ya quedaron)*\n${run.vencidas.map(line).join('\n')}`));
  }
  if (run.esLunes) {
    const prox = run.proximas45.length ? run.proximas45.map(line).join('\n') : '_Nada en los próximos 45 días._';
    blocks.push(section(`*📅 Cal · lo que viene en 45 días*\n${prox}`));
    if (run.pendientes.length) {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Por confirmar: ${run.pendientes.join(' · ')}` }] });
    }
  }
  if (!blocks.length) return null;
  const fuente = run.fuente === 'google-calendar'
    ? 'Fuente: calendario "Kinedu INC y SAPI fillings". Para mover una fecha o quitar algo ya hecho, edita el evento ahí.'
    : 'Fuente: data/cal/compliance.json (respaldo). Cuando se comparta el calendario con la cuenta de servicio, Cal leerá el calendario.';
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `🤖 Cal · avisa, no presenta. ${fuente}` }] });
  const text = blocks
    .map((b) => (b.type === 'section' ? String((b as { text?: { text?: string } }).text?.text ?? '') : ''))
    .filter(Boolean).join('\n\n');
  return { text: text.slice(0, 2900), blocks };
}

export async function postCal(message: SlackMessage): Promise<{ ok: boolean; ts?: string; error?: string }> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return { ok: false, error: 'SLACK_BOT_TOKEN not set' };
  return postChatMessage(token, CAL_CHANNEL(), message);
}
