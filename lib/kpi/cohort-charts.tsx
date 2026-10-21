/**
 * Gráfica del brief de cohortes (PNG dentro del mensaje de Slack). Mismo dibujo que las del brief calendar
 * (`renderPanels` de brief-charts): por OS, conversión a 8 y a 30 días por semana de signup, signups por semana
 * y refunds por semana de cobro. Se dibuja en el servidor con `next/og`: los datos no salen de Kinedu.
 */
import { renderPanels, weekLabel, BLUE, NAVY, GREEN, ROSE, type PanelData } from './brief-charts';
import type { SlackFile } from '@/lib/slack/post';

export interface CohortChartWeek {
  week: string;
  /** Por segmento (iOS, Android, Total): signups y compradores a 8 / 30 días. d30 = null si la cohorte no maduró. */
  segs: Record<string, { signups: number; d8: number; d30: number | null }>;
}
export interface CohortChartRefundWeek { week: string; charges: number; refunded: number; mature: boolean }

const PRIOR = 4;

/** Serie de tasas y base de las 4 previas a la última (cociente de las sumas, igual que el brief). */
function rateSeries(weeks: CohortChartWeek[], seg: string, k: 'd8' | 'd30') {
  const pts = weeks
    .map((w) => ({ week: w.week, s: w.segs[seg]?.signups ?? 0, c: w.segs[seg]?.[k] ?? null }))
    .filter((p): p is { week: string; s: number; c: number } => p.c !== null && p.s > 0);
  const prior = pts.slice(-PRIOR - 1, -1);
  const ps = prior.reduce((a, p) => a + p.s, 0);
  return {
    labels: pts.map((p) => weekLabel(p.week)),
    values: pts.map((p) => p.c / p.s),
    base: ps ? prior.reduce((a, p) => a + p.c, 0) / ps : null,
  };
}

export async function buildCohortCharts(weeks: CohortChartWeek[], refunds: CohortChartRefundWeek[], yesterday: string): Promise<SlackFile[]> {
  const panels: PanelData[] = [];
  for (const os of ['iOS', 'Android']) {
    const r = rateSeries(weeks, os, 'd8');
    panels.push({ title: `${os} · 8 dias`, fmt: 'pct', kind: 'line', higherIsBetter: true, ...r, color: BLUE });
  }
  panels.push({ title: 'Signups por semana', fmt: 'int', kind: 'bar', higherIsBetter: true, labels: weeks.map((w) => weekLabel(w.week)), values: weeks.map((w) => w.segs.Total?.signups ?? null), color: NAVY });
  for (const os of ['iOS', 'Android']) {
    const r = rateSeries(weeks, os, 'd30');
    panels.push({ title: `${os} · 30 dias`, fmt: 'pct', kind: 'line', higherIsBetter: true, ...r, color: GREEN });
  }
  const mature = refunds.filter((w) => w.mature && w.charges > 0);
  const prior = mature.slice(-PRIOR - 1, -1); const pc = prior.reduce((a, w) => a + w.charges, 0);
  panels.push({
    title: 'Refunds % por cobro', fmt: 'pct', kind: 'line', higherIsBetter: false, color: ROSE,
    labels: mature.map((w) => weekLabel(w.week)), values: mature.map((w) => w.refunded / w.charges),
    base: pc ? prior.reduce((a, w) => a + w.refunded, 0) / pc : null,
  });
  const img = await renderPanels(
    'Cohortes - ultimas 12 semanas',
    '% de cada semana de signup que compro en 8 y 30 dias (incluye trial) · refunds: % de cobros devueltos (semanas maduras)',
    panels, 3);
  return [{ filename: `cohortes-12-semanas-${yesterday}.png`, title: 'Cohortes - ultimas 12 semanas', data: img }];
}
