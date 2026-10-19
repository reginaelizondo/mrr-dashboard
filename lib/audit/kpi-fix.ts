/**
 * Corrección automática de las alertas de la Guardia de KPIs (botón "🔧 Corregir" en Slack o `/kpi arreglar`).
 *
 * Cada chequeo en rojo/amarillo tiene una "receta" de corrección segura e idempotente (re-sincronizar, recalibrar,
 * recalentar caché). Lo que no se puede corregir desde aquí (fórmulas que cambiaron en el código, datos de la fuente,
 * el Looker) se reporta con a quién le toca. Después de corregir se vuelve a correr la Guardia y se reporta el
 * antes y el después. Ver docs/AUDITORIA.md → "Corregir desde Slack".
 */
import { runKpiGuard, recordAndAlert, type GuardCheck, type GuardRun } from '@/lib/audit/kpi-guard';
import { runDailyKpiSync } from '@/lib/sync/kpi-daily';
import { runStoreDailySync } from '@/lib/sync/store-daily';
import { warmOperativoCache } from '@/lib/kpi/operativo-data';
import { createServerClient } from '@/lib/supabase/server';
import { todayMx } from '@/lib/kpi/period';

type Action = 'replica' | 'tiendas' | 'tiendas-75' | 'cache';

/** Qué hacer por chequeo. null = no se corrige solo (se explica en `manual`). */
const RECIPES: Record<string, { actions: Action[]; manual?: string }> = {
  'frescura.bigquery': { actions: ['replica'] },
  'replica.dias': { actions: ['replica'] },
  'formulas.paridad': { actions: ['replica'], manual: 'si sigue después de re-sincronizar, cambió una fórmula en el código (formulas.ts vs replica.ts): necesita revisión de código' },
  'frescura.tiendas': { actions: ['tiendas-75'] },
  'calibracion.tiendas': { actions: ['tiendas'] },
  'pagina.salud': { actions: ['cache'] },
  'tiendas.looker': { actions: [], manual: 'es el Looker contra las tiendas (base de BigQuery): se corrige del lado de tech/dbt, no en el dashboard' },
  'datos.invariantes': { actions: ['replica'], manual: 'si sigue, el dato viene así de la fuente (BigQuery/dbt): avisar a tech' },
};

const LABEL: Record<Action, string> = {
  replica: 're-sincronicé la réplica (95 días) y verifiqué/reparé todo el historial contra BigQuery',
  tiendas: 're-sincronicé las tiendas (10 días) y recalibré',
  'tiendas-75': 're-sincronicé las tiendas (75 días, incluye el earnings de Google) y recalibré',
  cache: 'recalenté la caché del dashboard',
};

export interface FixResult { before: GuardRun; after: GuardRun; done: string[]; failed: string[]; manual: string[]; seconds: number }

/** Evita dos correcciones a la vez (p. ej. dos clics): hay un sync de la réplica corriendo hace < 6 min. */
export async function fixInProgress(): Promise<boolean> {
  const { data } = await createServerClient().from('sync_log').select('started_at').eq('source', 'kpi_daily').eq('status', 'running')
    .gte('started_at', new Date(Date.now() - 6 * 60_000).toISOString()).limit(1);
  return !!data?.length;
}

export async function runKpiFix(opts: { before?: GuardRun; triggeredBy?: string } = {}): Promise<FixResult> {
  const t0 = Date.now();
  const before = opts.before ?? (await runKpiGuard());
  const failing = before.checks.filter((c) => c.status !== 'ok');
  const actions = new Set<Action>();
  const manual: string[] = [];
  for (const c of failing) {
    const r = RECIPES[c.id];
    if (!r) { manual.push(`${c.area}: sin receta automática`); continue; }
    r.actions.forEach((a) => actions.add(a));
    if (r.manual) manual.push(`${c.area}: ${r.manual}`);
  }
  if (actions.has('tiendas-75')) actions.delete('tiendas');
  const done: string[] = []; const failed: string[] = [];
  const today = todayMx();
  const sb = createServerClient();
  // Orden: tiendas primero (la réplica recalibra al cambiar), luego réplica, al final la caché.
  for (const a of (['tiendas-75', 'tiendas', 'replica', 'cache'] as Action[]).filter((x) => actions.has(x))) {
    try {
      if (a === 'tiendas' || a === 'tiendas-75') await runStoreDailySync(today, a === 'tiendas' ? 10 : 75);
      if (a === 'replica') {
        const { data: log } = await sb.from('sync_log').insert({ source: 'kpi_daily', sync_type: 'manual', status: 'running', details: { trigger: `slack-fix ${opts.triggeredBy ?? ''}`.trim() } }).select().single();
        try {
          const r = await runDailyKpiSync(today, { rotate: false });
          if (log) await sb.from('sync_log').update({ status: 'success', completed_at: new Date().toISOString(), records_synced: r.window.rows, details: { ...r, trigger: 'slack-fix' } }).eq('id', log.id);
        } catch (e) {
          if (log) await sb.from('sync_log').update({ status: 'error', completed_at: new Date().toISOString(), details: { error: e instanceof Error ? e.message : String(e) } }).eq('id', log.id);
          throw e;
        }
      }
      if (a === 'cache') await warmOperativoCache();
      done.push(LABEL[a]);
    } catch (e) {
      failed.push(`${LABEL[a]} — falló: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`);
    }
  }
  const after = await runKpiGuard();
  // Guarda la corrida "después" sin volver a avisar (el resultado se reporta en el hilo de la corrección).
  await recordAndAlert(after, { post: false }).catch(() => undefined);
  return { before, after, done, failed, manual, seconds: Math.round((Date.now() - t0) / 1000) };
}

const icon = (s: GuardCheck['status']) => (s === 'ok' ? '✅' : s === 'warn' ? '⚠️' : '🔴');

/** Texto para el hilo de Slack con el antes y el después. */
export function formatFixResult(r: FixResult, who?: string): string {
  const okN = (g: GuardRun) => g.checks.filter((c) => c.status === 'ok').length;
  const lines = [
    `*🔧 Corrección${who ? ` (pedida por ${who})` : ''} — ${r.after.status === 'ok' ? 'todo en verde ✅' : `${r.after.checks.filter((c) => c.status !== 'ok').length} chequeo(s) siguen con problema`}*`,
    `Antes ${okN(r.before)}/${r.before.checks.length} ✅ → después ${okN(r.after)}/${r.after.checks.length} ✅ · ${r.seconds} s`,
  ];
  if (r.done.length) lines.push('', '*Qué hice:*', ...r.done.map((d) => `• ${d}`));
  if (r.failed.length) lines.push('', '*Falló:*', ...r.failed.map((d) => `• ${d}`));
  const still = r.after.checks.filter((c) => c.status !== 'ok');
  if (still.length) lines.push('', '*Sigue así:*', ...still.map((c) => `${icon(c.status)} ${c.line}`));
  if (r.manual.length && still.length) lines.push('', '*No se corrige solo:*', ...r.manual.map((m) => `• ${m}`));
  if (!r.done.length && !r.failed.length && !still.length) lines.push('', 'No había nada que corregir.');
  return lines.join('\n').slice(0, 2900);
}
