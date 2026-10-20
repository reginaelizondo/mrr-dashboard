/**
 * Gráficas del brief como imagen PNG (se suben al hilo de Slack). Mismos datos y colores que el dashboard Operativo:
 * la réplica `kpi_daily` en definición Corregido y la cohorte de signup de `an_conversion_analysis`.
 * Se dibujan en el propio servidor con `next/og` (sin servicios externos): los datos no salen de Kinedu.
 */
import { ImageResponse } from 'next/og';
import { addDays } from './period';
import type { CohortWeek } from './brief-queries';
import type { KpiValues } from './replica';
import type { SlackFile } from '@/lib/slack/post';

const BLUE = '#0086D8', NAVY = '#0E3687', GREEN = '#2F9E38', ROSE = '#DA4D7A', GRID = '#E8EDF3', MUTED = '#64748B';
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const W = 1200, H = 675;
const ADDITIVE_KEYS = new Set<keyof KpiValues>(['newSubs', 'totalContribution', 'spend', 'signups', 'nsSales']);

type Fmt = 'int' | 'usd' | 'usd2' | 'pct';
interface PanelData {
  title: string; fmt: Fmt; kind: 'bar' | 'line'; higherIsBetter: boolean; labels: string[]; values: Array<number | null>; color?: string;
  /** Base de las 4 semanas previas, calculada igual que la alerta del brief (cociente de sumas para ratios). */
  base?: number | null;
}

// Solo ASCII y Latin-1: la fuente incluida (Noto Sans latin) no trae "−" ni emoji.
function fmt(v: number | null, f: Fmt): string {
  if (v === null || !Number.isFinite(v)) return 'n/d';
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  switch (f) {
    case 'int': return sign + Math.round(a).toLocaleString('en-US');
    case 'usd': return sign + '$' + (a >= 1e4 ? `${(a / 1e3).toFixed(1)}K` : Math.round(a).toLocaleString('en-US'));
    case 'usd2': return sign + '$' + a.toFixed(2);
    case 'pct': return sign + (a * 100).toFixed(a < 0.1 ? 2 : 1) + '%';
  }
}
const weekLabel = (iso: string) => { const d = new Date(iso + 'T00:00:00Z'); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };

/** Última semana vs la base de las 4 previas (la que manda el brief; si no, promedio simple). */
function deltaVsPrior(values: Array<number | null>, given?: number | null): number | null {
  const last = values[values.length - 1];
  const prior = values.slice(-5, -1).filter((v): v is number => v !== null && Number.isFinite(v));
  if (last === null || last === undefined) return null;
  const base = given ?? (prior.length ? prior.reduce((a, b) => a + b, 0) / prior.length : null);
  return base ? (last - base) / Math.abs(base) : null;
}

function Panel({ p, w, h }: { p: PanelData; w: number; h: number }) {
  const color = p.color ?? (p.kind === 'bar' ? BLUE : NAVY);
  const pts = p.values.map((v) => (v !== null && Number.isFinite(v) ? v : null));
  const nums = pts.filter((v): v is number => v !== null);
  const last = pts[pts.length - 1] ?? null;
  const d = deltaVsPrior(pts, p.base);
  const good = d === null ? null : p.higherIsBetter ? d >= 0 : d <= 0;
  const plotW = w - 92, plotH = h - 132;
  let lo = nums.length ? Math.min(...nums) : 0, hi = nums.length ? Math.max(...nums) : 1;
  if (p.kind === 'bar') lo = Math.min(0, lo);
  else { const pad = (hi - lo) * 0.15 || Math.abs(hi) * 0.1 || 1; lo -= pad; hi += pad; }
  if (hi === lo) hi = lo + 1;
  const n = pts.length;
  const x = (i: number) => (n === 1 ? plotW / 2 : (i + 0.5) * (plotW / n));
  const y = (v: number) => plotH - ((v - lo) / (hi - lo)) * plotH;
  const bw = Math.max(4, (plotW / n) * 0.62);
  const line = pts.map((v, i) => (v === null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`)).filter(Boolean).join(' ');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: w, height: h, padding: '14px 18px', backgroundColor: '#FFFFFF', borderRadius: 14, border: '1px solid #E2E8F0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', height: 26 }}>
        <div style={{ display: 'flex', fontSize: 17, color: MUTED, overflow: 'hidden', whiteSpace: 'nowrap' }}>{p.title}</div>
        {d !== null && (
          <div style={{ display: 'flex', flexShrink: 0, whiteSpace: 'nowrap', fontSize: 15, padding: '2px 10px', borderRadius: 999, marginLeft: 8, color: good ? GREEN : ROSE, backgroundColor: good ? '#EAF7EC' : '#FCEBF1' }}>
            {`${d >= 0 ? '+' : '-'}${Math.abs(d * 100).toFixed(0)}% vs 4 sem.`}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', fontSize: 30, color: NAVY, height: 42 }}>{fmt(last, p.fmt)}</div>
      <div style={{ display: 'flex', marginTop: 10 }}>
        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', width: 64, height: plotH, fontSize: 13, color: MUTED, paddingRight: 8, alignItems: 'flex-end' }}>
          <div style={{ display: 'flex' }}>{fmt(hi, p.fmt)}</div>
          <div style={{ display: 'flex' }}>{fmt(lo, p.fmt)}</div>
        </div>
        <svg width={plotW} height={plotH} viewBox={`0 0 ${plotW} ${plotH}`}>
          {[0, 0.5, 1].map((t) => <line key={t} x1={0} x2={plotW} y1={t * plotH} y2={t * plotH} stroke={GRID} strokeWidth={1} />)}
          {p.kind === 'bar'
            ? pts.map((v, i) => (v === null ? null : (
                <rect key={i} x={x(i) - bw / 2} y={Math.min(y(v), y(0))} width={bw} height={Math.max(1, Math.abs(y(v) - y(0)))} rx={3}
                  fill={color} fillOpacity={i === n - 1 ? 1 : 0.55} />
              )))
            : [
                <polyline key="l" points={line} fill="none" stroke={color} strokeWidth={3} strokeLinejoin="round" strokeLinecap="round" />,
                ...pts.map((v, i) => (v === null ? null : <circle key={i} cx={x(i)} cy={y(v)} r={i === n - 1 ? 6 : 3} fill={i === n - 1 ? color : '#FFFFFF'} stroke={color} strokeWidth={2} />)),
              ]}
        </svg>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginLeft: 64, fontSize: 13, color: MUTED, marginTop: 6 }}>
        <div style={{ display: 'flex' }}>{p.labels[0] ?? ''}</div>
        <div style={{ display: 'flex' }}>{p.labels[p.labels.length - 1] ?? ''}</div>
      </div>
    </div>
  );
}

async function render(title: string, subtitle: string, panels: PanelData[], cols: number): Promise<Uint8Array> {
  const rows = Math.ceil(panels.length / cols);
  const gap = 16, pad = 28, headH = 78;
  const pw = Math.floor((W - pad * 2 - gap * (cols - 1)) / cols);
  const ph = Math.floor((H - pad * 2 - headH - gap * (rows - 1)) / rows);
  const img = new ImageResponse(
    (
      <div style={{ display: 'flex', flexDirection: 'column', width: W, height: H, padding: pad, backgroundColor: '#F2F2F4', fontFamily: 'Noto Sans' }}>
        <div style={{ display: 'flex', flexDirection: 'column', height: headH }}>
          <div style={{ display: 'flex', fontSize: 28, color: NAVY }}>{title}</div>
          <div style={{ display: 'flex', fontSize: 16, color: MUTED, marginTop: 4 }}>{subtitle}</div>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap }}>
          {panels.map((p, i) => <Panel key={i} p={p} w={pw} h={ph} />)}
        </div>
      </div>
    ),
    { width: W, height: H },
  );
  return new Uint8Array(await img.arrayBuffer());
}

export interface BriefChartsInput {
  /** Lunes de la última semana completa y su domingo. */
  lwStart: string; lwEnd: string;
  /** Cohortes completas por OS (de la más vieja a la más nueva). */
  cohorts: Record<string, CohortWeek[]> | null;
  /** Enlaces al dashboard (ya armados por el brief). */
  links: { total: string; ios: string; android: string };
}

/** Dos imágenes: tendencia total de 12 semanas y C.R. / CAC / cohorte por OS. */
export async function buildBriefCharts(inp: BriefChartsInput): Promise<{ files: SlackFile[]; comment: string }> {
  const r = await import('./replica');
  const start = addDays(inp.lwStart, -77); const end = inp.lwEnd;
  const [total, byOs] = await Promise.all([r.fetchAgg({ start, end }, 'week'), r.fetchAgg({ start, end }, 'week', 'os')]);
  const weeks = [...new Set(total.map((a) => a.period))].sort();
  const labels = weeks.map(weekLabel);
  const kTotal = new Map(total.map((a) => [a.period, r.computeKpis(a, 'fixed')]));
  const kOs = new Map(byOs.map((a) => [`${a.grp}|${a.period}`, r.computeKpis(a, 'fixed')]));
  const series = (m: (w: string) => KpiValues | undefined, key: keyof KpiValues) => weeks.map((w) => (m(w)?.[key] as number | null | undefined) ?? null);

  const t = (w: string) => kTotal.get(w);
  // Base de las 4 semanas previas a la última, igual que la alerta del brief: conteos = promedio semanal,
  // ratios = KPI sobre la suma de las 4 semanas.
  const prior4 = weeks.slice(-5, -1);
  const baseOf = (rows: typeof total, key: keyof KpiValues): number | null => {
    const sel = rows.filter((a) => prior4.includes(a.period));
    if (!sel.length) return null;
    const v = r.computeKpis(r.sumAgg(sel), 'fixed')[key] as number | null;
    return v === null ? null : ADDITIVE_KEYS.has(key) ? v / prior4.length : v;
  };
  const totalImg = await render(
    'Kinedu - ultimas 12 semanas',
    `Semana del ${labels[0]} a la del ${weekLabel(inp.lwStart)} (lun-dom, cada etiqueta = lunes) · vista Corregido · color fuerte = ultima semana · etiqueta = vs las 4 previas`,
    [
      { title: 'New Subs', fmt: 'int', kind: 'bar', higherIsBetter: true, labels, values: series(t, 'newSubs'), base: baseOf(total, 'newSubs') },
      { title: 'CAC', fmt: 'usd2', kind: 'line', higherIsBetter: false, labels, values: series(t, 'cac'), color: ROSE, base: baseOf(total, 'cac') },
      { title: 'Conversion Rate', fmt: 'pct', kind: 'line', higherIsBetter: true, labels, values: series(t, 'conversionRate'), color: GREEN, base: baseOf(total, 'conversionRate') },
      { title: 'Total Contribution', fmt: 'usd', kind: 'bar', higherIsBetter: true, labels, values: series(t, 'totalContribution'), color: NAVY, base: baseOf(total, 'totalContribution') },
    ], 2);

  const osPanels: PanelData[] = [];
  for (const os of ['iOS', 'Android']) {
    const m = (w: string) => kOs.get(`${os}|${w}`);
    const osRows = byOs.filter((a) => a.grp === os);
    osPanels.push({ title: `${os} · C.R.`, fmt: 'pct', kind: 'line', higherIsBetter: true, labels, values: series(m, 'conversionRate'), color: GREEN, base: baseOf(osRows, 'conversionRate') });
    osPanels.push({ title: `${os} · CAC`, fmt: 'usd2', kind: 'line', higherIsBetter: false, labels, values: series(m, 'cac'), color: ROSE, base: baseOf(osRows, 'cac') });
    const cw = inp.cohorts?.[os] ?? [];
    const prevC = cw.slice(-5, -1); const prevSignups = prevC.reduce((a, c) => a + c.signups, 0);
    osPanels.push({ title: `${os} · Cohorte 8 dias`, fmt: 'pct', kind: 'line', higherIsBetter: true, labels: cw.map((c) => weekLabel(c.week)), values: cw.map((c) => c.rate), color: BLUE,
      base: prevSignups ? prevC.reduce((a, c) => a + c.converted, 0) / prevSignups : null });
  }
  const osImg = await render(
    'Por OS - ultimas 12 semanas',
    'C.R. y CAC por semana (Corregido) · Cohorte 8 dias = de quienes se registraron esa semana, % que compro en sus primeros 8 dias (incluye el trial)',
    osPanels, 3);

  return {
    files: [
      { filename: `kpis-12-semanas-${inp.lwEnd}.png`, title: 'KPIs - ultimas 12 semanas', data: totalImg },
      { filename: `kpis-por-os-${inp.lwEnd}.png`, title: 'KPIs por OS - ultimas 12 semanas', data: osImg },
    ],
    comment: `*Gráficas — últimas 12 semanas* (mismos números que el dashboard, vista Corregido). Ver en el dashboard: <${inp.links.total}|total por semana> · <${inp.links.ios}|iOS> · <${inp.links.android}|Android>`,
  };
}
