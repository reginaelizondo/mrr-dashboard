'use client';

import { Fragment, useMemo, useState } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import {
  ResponsiveContainer, ComposedChart, Line, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { MultiSelect } from '@/components/ui/multi-select';
import { cn } from '@/lib/utils';
import type { KpiValues, Grain, ReplicaStatus, Definition, StoreCoverage, GuardSnapshot } from '@/lib/kpi/replica';
import { LOOKER_DIFFERENCES } from '@/lib/kpi/looker-differences';
import type { Preset } from '@/app/(dashboard)/dashboard/operativo/page';

// ─── Tipos que recibe del servidor ───────────────────────────────────────────

export interface PeriodRow { period: string; looker: KpiValues; fixed: KpiValues }
export interface GroupRow extends PeriodRow { grp: string }
export interface OperativoData {
  preset: Preset; start: string; end: string; grain: Grain; days: number;
  filters: { region: string[]; country: string[]; os: string[]; language: string[] };
  totals: { current: Record<Definition, KpiValues>; previous: Record<Definition, KpiValues>; priorStart: string; priorEnd: string };
  series: PeriodRow[];
  breakdown: Record<'os' | 'country' | 'kinedu_language' | 'kinedu_region', GroupRow[]>;
  groupSeries: Record<'os' | 'country' | 'kinedu_language' | 'kinedu_region', { period: string; grp: string; spend: number }[]>;
  dims: { dim: string; value: string; signups: number }[];
  status: ReplicaStatus;
  storeCoverage: StoreCoverage[];
  guard: GuardSnapshot | null;
  generatedAt: string; // ISO, hora del servidor al generar la página
}

// ─── Formato ─────────────────────────────────────────────────────────────────

type Fmt = 'usd' | 'usd2' | 'int' | 'pct' | 'x' | 'num1';
const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
function fmt(v: number | null | undefined, f: Fmt): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  switch (f) {
    case 'usd': return (v < 0 ? '-$' : '$') + nf0.format(Math.abs(v));
    case 'usd2': return (v < 0 ? '-$' : '$') + nf2.format(Math.abs(v));
    case 'int': return nf0.format(v);
    case 'pct': return nf1.format(v * 100) + '%';
    case 'x': return nf2.format(v) + 'x';
    case 'num1': return nf1.format(v);
  }
}
const compact = (v: number) => Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : Math.abs(v) >= 1e3 ? `${(v / 1e3).toFixed(0)}K` : `${Math.round(v)}`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - dow);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t.getTime() - y0.getTime()) / 86400000 + 1) / 7);
}
function periodLabel(p: string, grain: Grain): string {
  const d = new Date(p + 'T00:00:00Z');
  switch (grain) {
    case 'day': return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`;
    case 'week': return `W${isoWeek(d)} · ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
    case 'month': return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    case 'quarter': return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`;
    case 'year': return String(d.getUTCFullYear());
    default: return p;
  }
}

// ─── Catálogo de columnas (nombres del Looker) ───────────────────────────────

interface Col { key: keyof KpiValues; label: string; fmt: Fmt; higherIsBetter?: boolean }
const FUNNEL_COLS: Col[] = [
  { key: 'spend', label: 'spend', fmt: 'usd' }, { key: 'signups', label: 'signups', fmt: 'int' }, { key: 'cpnu', label: 'CPNU', fmt: 'usd2' },
  { key: 'newSubs', label: 'New Subs', fmt: 'int' }, { key: 'cac', label: 'CAC', fmt: 'usd2' }, { key: 'conversionRate', label: 'C.R.', fmt: 'pct' },
  { key: 'ftsStarted', label: 'FTS', fmt: 'int' }, { key: 'cpft', label: 'CPFT', fmt: 'usd2' }, { key: 'nsSales', label: 'NS Sales', fmt: 'usd' },
  { key: 'newSubsMargin', label: 'NS mgn', fmt: 'pct' }, { key: 'arpu', label: 'ARPU', fmt: 'usd2' }, { key: 'firstTicketCac', label: '1stTkt/CAC', fmt: 'x' },
  { key: 'mobileCm', label: 'Cont mbl', fmt: 'usd' }, { key: 'totalContribution', label: 'Cont. Tot', fmt: 'usd' }, { key: 'contributionMarginPct', label: 'CM/Sales', fmt: 'pct' },
];
const SALES_COLS: Col[] = [
  { key: 'spend', label: 'spend', fmt: 'usd' }, { key: 'signups', label: 'signups', fmt: 'int' }, { key: 'newSubs', label: 'New Subs', fmt: 'int' },
  { key: 'totalSales', label: 'Total Sales', fmt: 'usd' }, { key: 'nsSales', label: 'NS Sales', fmt: 'usd' }, { key: 'totalRenewalSales', label: 'Total Renewal Sales', fmt: 'usd' },
  { key: 'netSales', label: 'Net Sales', fmt: 'usd' }, { key: 'mobileCm', label: 'Mobile CM', fmt: 'usd' }, { key: 'totalContribution', label: 'Total Contribution', fmt: 'usd' },
  { key: 'contributionMarginPct', label: 'CM/Sales', fmt: 'pct' }, { key: 'firstTicketCac', label: '1stTkt/CAC', fmt: 'x' },
];
const CONVERSION_COLS: Col[] = [
  { key: 'signups', label: 'signups', fmt: 'int' }, { key: 'downloads', label: 'downloads', fmt: 'int' }, { key: 'signupsPerDownload', label: 'signups/downloads', fmt: 'num1' },
  { key: 'ftsStarted', label: 'fts_started', fmt: 'int' }, { key: 'ftStartRate', label: 'FT start rate', fmt: 'pct' }, { key: 'ftsConverted', label: 'fts_converted', fmt: 'int' },
  { key: 'purchasesNonFt', label: "Purchases (non FT's)", fmt: 'int' }, { key: 'convFromFt', label: 'Conv. from FT', fmt: 'pct' }, { key: 'convFromPurchases', label: 'Conv. from Purchases', fmt: 'pct' },
  { key: 'cacFromPurchases', label: 'CAC from Purchases', fmt: 'usd2' }, { key: 'cacFromFt', label: 'CAC from Free Trials', fmt: 'usd2' }, { key: 'cac', label: 'CAC', fmt: 'usd2' },
  { key: 'usersPerPurchase', label: 'Users per purchase', fmt: 'num1' }, { key: 'usersPerFtConverted', label: 'Users per Trial conv.', fmt: 'num1' },
];
const BREAKDOWN_COLS: Col[] = [
  { key: 'spend', label: 'spend', fmt: 'usd' }, { key: 'signups', label: 'signups', fmt: 'int' }, { key: 'newSubs', label: 'New Subs', fmt: 'int' },
  { key: 'conversionRate', label: 'C.R.', fmt: 'pct' }, { key: 'cac', label: 'CAC', fmt: 'usd2' }, { key: 'arpu', label: 'ARPU', fmt: 'usd2' },
  { key: 'firstTicketCac', label: '1stTkt/CAC', fmt: 'x' }, { key: 'nsSales', label: 'NS Sales', fmt: 'usd' }, { key: 'totalSales', label: 'Total Sales', fmt: 'usd' },
  { key: 'totalContribution', label: 'Total Contribution', fmt: 'usd' }, { key: 'contributionMarginPct', label: 'CM/Sales', fmt: 'pct' },
];
const SCORECARDS: Col[] = [
  { key: 'spend', label: 'Spend', fmt: 'usd', higherIsBetter: false }, { key: 'signups', label: 'Signups', fmt: 'int', higherIsBetter: true },
  { key: 'newSubs', label: 'New Subs', fmt: 'int', higherIsBetter: true }, { key: 'cac', label: 'CAC', fmt: 'usd2', higherIsBetter: false },
  { key: 'nsSales', label: 'NS Sales', fmt: 'usd', higherIsBetter: true }, { key: 'totalSales', label: 'Total Sales', fmt: 'usd', higherIsBetter: true },
  { key: 'totalContribution', label: 'Total Contribution', fmt: 'usd', higherIsBetter: true }, { key: 'firstTicketCac', label: '1st Ticket / CAC', fmt: 'x', higherIsBetter: true },
];

// ─── Filtros ─────────────────────────────────────────────────────────────────

const PRESET_LABELS: Record<Preset, string> = {
  yesterday: 'Ayer', '7d': 'Últimos 7 días', wtd: 'Semana en curso', mtd: 'Mes en curso', '30d': 'Últimos 30 días', '90d': 'Últimos 90 días',
  ytd: 'YTD', '12m': 'Últimos 12 meses', all: 'Todo (2024→)', custom: 'Personalizado',
};
const GRAIN_LABELS: Record<Grain, string> = { day: 'Día', week: 'Semana ISO', month: 'Mes', quarter: 'Trimestre', year: 'Año', total: 'Total' };
const DIM_LABELS = { kinedu_region: 'kinedu_region', country: 'country', os: 'os', kinedu_language: 'kinedu_language' } as const;
type DimKey = keyof typeof DIM_LABELS;
const DIM_PARAM: Record<DimKey, string> = { kinedu_region: 'region', country: 'country', os: 'os', kinedu_language: 'lang' };

const BLUE = '#0086D8', NAVY = '#0E3687', GREEN = '#45C94E', ROSE = '#DA4D7A', GRAY = '#94A3B8', AMBER = '#F59E0B';
const PALETTE = [BLUE, GREEN, NAVY, ROSE, AMBER, '#8B5CF6', '#14B8A6', '#F97316', '#64748B', '#A3E635'];

const TABS = ['funnel', 'sales', 'graphs', 'margin', 'conversion', 'breakdown', 'audit'];

export function OperativoContent({ data }: { data: OperativoData }) {
  const router = useRouter(); const pathname = usePathname(); const sp = useSearchParams();
  const [def, setDefState] = useState<Definition>(sp.get('def') === 'fixed' ? 'fixed' : 'looker');
  const [tab, setTabState] = useState<string>(TABS.includes(sp.get('tab') ?? '') ? (sp.get('tab') as string) : 'funnel');
  // Pestaña y definición viven en la URL (sin recargar) para que los enlaces del brief abran la vista exacta.
  function syncUrl(patch: Record<string, string>) {
    const next = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(patch)) next.set(k, v);
    window.history.replaceState(null, '', `${pathname}?${next.toString()}`);
  }
  const setDef = (d: Definition) => { setDefState(d); syncUrl({ def: d }); };
  const setTab = (t: string) => { setTabState(t); syncUrl({ tab: t }); };
  const [customStart, setCustomStart] = useState(data.start);
  const [customEnd, setCustomEnd] = useState(data.end);

  function setParams(patch: Record<string, string | null>) {
    const next = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) { if (v === null || v === '') next.delete(k); else next.set(k, v); }
    router.push(`${pathname}?${next.toString()}`);
  }

  const dimOptions = useMemo(() => {
    const out: Record<DimKey, { value: string; label: string; hint?: string }[]> = { kinedu_region: [], country: [], os: [], kinedu_language: [] };
    for (const d of data.dims) if (d.dim in out) out[d.dim as DimKey].push({ value: d.value, label: d.value, hint: d.signups ? `${compact(d.signups)}` : undefined });
    return out;
  }, [data.dims]);

  const cur = data.totals.current[def]; const prev = data.totals.previous[def];
  const rows = data.series;
  // Vista Looker a granularidad mensual o mayor: "New Sales / Spend" usa ventas netas, como su gráfica mensual.
  const monthlyLooker = def === 'looker' && ['month', 'quarter', 'year'].includes(data.grain);
  const chartData = useMemo(() => rows.map((r) => ({
    label: periodLabel(r.period, data.grain), ...r[def],
    ...(monthlyLooker ? { newSalesOverSpend: r[def].newSalesOverSpendNet } : {}),
  })), [rows, def, data.grain, monthlyLooker]);

  const activeFilters = (Object.keys(DIM_LABELS) as DimKey[]).filter((k) => data.filters[k === 'kinedu_region' ? 'region' : k === 'kinedu_language' ? 'language' : k].length > 0);

  return (
    <div className="space-y-6">
      {/* Filtros */}
      <Card>
        <CardContent className="pt-5 pb-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs uppercase tracking-wider text-muted-foreground mr-1">Periodo</span>
            {(Object.keys(PRESET_LABELS) as Preset[]).filter((p) => p !== 'custom').map((p) => (
              <button key={p} type="button" onClick={() => setParams({ preset: p, start: null, end: null, grain: null })}
                className={cn('rounded-md px-2.5 py-1 text-xs font-medium border transition-colors', data.preset === p ? 'bg-[#0E3687] text-white border-[#0E3687]' : 'bg-white text-muted-foreground border-border hover:border-[#0086D8]/50 hover:text-[#0E3687]')}>
                {PRESET_LABELS[p]}
              </button>
            ))}
            <span className="mx-1 text-muted-foreground/40">|</span>
            <input type="date" value={customStart} min="2024-01-01" max={data.end} onChange={(e) => setCustomStart(e.target.value)} className="rounded-md border border-border bg-white px-2 py-1 text-xs" />
            <span className="text-xs text-muted-foreground">→</span>
            <input type="date" value={customEnd} min="2024-01-01" onChange={(e) => setCustomEnd(e.target.value)} className="rounded-md border border-border bg-white px-2 py-1 text-xs" />
            <button type="button" onClick={() => setParams({ preset: 'custom', start: customStart, end: customEnd })}
              className={cn('rounded-md px-2.5 py-1 text-xs font-medium border', data.preset === 'custom' ? 'bg-[#0E3687] text-white border-[#0E3687]' : 'bg-white text-[#0E3687] border-[#0086D8]/50 hover:bg-[#F0F4FF]')}>
              Aplicar
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="inline-flex items-center gap-2">
              <span className="text-xs uppercase tracking-wider text-muted-foreground">Granularidad</span>
              <select value={data.grain} onChange={(e) => setParams({ grain: e.target.value })} className="rounded-md border border-border bg-white px-2 py-1.5 text-sm">
                {(['day', 'week', 'month', 'quarter', 'year'] as Grain[]).map((g) => <option key={g} value={g}>{GRAIN_LABELS[g]}</option>)}
              </select>
            </div>
            {(Object.keys(DIM_LABELS) as DimKey[]).map((dim) => {
              const selected = data.filters[dim === 'kinedu_region' ? 'region' : dim === 'kinedu_language' ? 'language' : dim];
              return (
                <MultiSelect key={dim} label={DIM_LABELS[dim]} options={dimOptions[dim]} selected={selected} allLabel="Todos"
                  onChange={(next) => setParams({ [DIM_PARAM[dim]]: next.join(',') })} />
              );
            })}
            <div className="ml-auto inline-flex items-center gap-2">
              <span className="text-xs uppercase tracking-wider text-muted-foreground">Definición</span>
              <div className="inline-flex rounded-md border border-border overflow-hidden">
                {(['looker', 'fixed'] as Definition[]).map((d) => (
                  <button key={d} type="button" onClick={() => setDef(d)}
                    className={cn('px-3 py-1.5 text-xs font-medium', def === d ? 'bg-[#0E3687] text-white' : 'bg-white text-muted-foreground hover:text-[#0E3687]')}
                    title={d === 'looker' ? 'Tal como el Looker lo calcula hoy (Stripe contado dos veces en Total Contribution)' : 'Variante 2 acordada: Stripe al 0.965 dentro de Net Sales; Total Contribution = Net Sales − spend'}>
                    {d === 'looker' ? 'Looker (hoy)' : 'Corregido'}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {data.start} → {data.end} · {data.days} días · comparado con {data.totals.priorStart} → {data.totals.priorEnd}
            {activeFilters.length ? ` · filtros: ${activeFilters.map((k) => DIM_LABELS[k]).join(', ')}` : ''}
            {' · '}réplica al {data.status.maxDate ?? '—'} (sync {data.status.lastSyncedAt ? new Date(data.status.lastSyncedAt).toLocaleString('es-MX', { timeZone: 'America/Mexico_City', dateStyle: 'short', timeStyle: 'short' }) : '—'})
          </p>
        </CardContent>
      </Card>

      {def === 'fixed' && <CalibrationBanner coverage={data.storeCoverage} kpis={cur} />}

      {/* Scorecards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {SCORECARDS.map((c) => {
          const v = cur[c.key] as number | null; const p = prev[c.key] as number | null;
          const delta = v !== null && p !== null && p !== 0 ? (v - p) / Math.abs(p) : null;
          const good = delta === null ? null : c.higherIsBetter ? delta >= 0 : delta <= 0;
          return (
            <Card key={c.key} className="border-l-4 border-l-[#0086D8]">
              <CardContent className="pt-4 pb-3">
                <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{c.label}</p>
                <p className="text-2xl font-bold text-[#0E3687]">{fmt(v, c.fmt)}</p>
                <p className={cn('text-xs mt-0.5', delta === null ? 'text-muted-foreground' : good ? 'text-[#2F9E38]' : 'text-[#DA4D7A]')}>
                  {delta === null ? 'sin periodo previo' : `${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)}% vs periodo previo (${fmt(p, c.fmt)})`}
                </p>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="funnel">Funnel</TabsTrigger>
          <TabsTrigger value="sales">Sales Metrics</TabsTrigger>
          <TabsTrigger value="graphs">Gráficas</TabsTrigger>
          <TabsTrigger value="margin">Ventas y margen</TabsTrigger>
          <TabsTrigger value="conversion">Conversión</TabsTrigger>
          <TabsTrigger value="breakdown">Desglose</TabsTrigger>
          <TabsTrigger value="audit">Auditoría</TabsTrigger>
        </TabsList>

        <TabsContent value="funnel"><KpiTable rows={rows} grain={data.grain} def={def} cols={FUNNEL_COLS} total={cur} /></TabsContent>
        <TabsContent value="sales"><KpiTable rows={rows} grain={data.grain} def={def} cols={SALES_COLS} total={cur} /></TabsContent>

        <TabsContent value="graphs">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <KpiChart title="1st Ticket / CAC · spend" data={chartData} series={[{ key: 'firstTicketCac', label: '1st Ticket / CAC', type: 'line', fmt: 'x', color: NAVY }, { key: 'spend', label: 'spend', type: 'bar', fmt: 'usd', axis: 'right', color: '#CBD5E1' }]} />
            <KpiChart title="CPFT · CAC" data={chartData} series={[{ key: 'cpft', label: 'CPFT', type: 'line', fmt: 'usd2', color: BLUE }, { key: 'cac', label: 'CAC', type: 'line', fmt: 'usd2', color: ROSE }]} />
            <KpiChart title="ARPU · CAC · ARPU−CAC" data={chartData} series={[{ key: 'arpu', label: 'ARPU', type: 'line', fmt: 'usd2', color: GREEN }, { key: 'cac', label: 'CAC', type: 'line', fmt: 'usd2', color: ROSE }, { key: 'arpuMinusCac', label: 'ARPU−CAC', type: 'bar', fmt: 'usd2', color: '#CBD5E1' }]} />
            <KpiChart title="CPNU · Conversion Rate" data={chartData} series={[{ key: 'cpnu', label: 'CPNU', type: 'line', fmt: 'usd2', color: BLUE }, { key: 'conversionRate', label: 'Conversion Rate', type: 'line', fmt: 'pct', axis: 'right', color: GREEN }]} />
            <KpiChart title="New Subs · renewals · renewals_yearly_ios" data={chartData} series={[{ key: 'newSubs', label: 'New Subs', type: 'bar', fmt: 'int', color: BLUE, stack: 'v' }, { key: 'renewals', label: 'renewals', type: 'bar', fmt: 'int', color: GREEN, stack: 'v' }, { key: 'renewalsYearlyIos', label: 'renewals_yearly_ios', type: 'bar', fmt: 'int', color: NAVY, stack: 'v' }]} />
            <KpiChart title="signups · spend" data={chartData} series={[{ key: 'signups', label: 'signups', type: 'bar', fmt: 'int', color: BLUE }, { key: 'spend', label: 'spend', type: 'line', fmt: 'usd', axis: 'right', color: ROSE }]} />
            <KpiChart title="fts_started · FreeTrialStartRate" data={chartData} series={[{ key: 'ftsStarted', label: 'fts_started', type: 'bar', fmt: 'int', color: BLUE }, { key: 'ftStartRate', label: 'FT start rate', type: 'line', fmt: 'pct', axis: 'right', color: GREEN }]} />
            <KpiChart title="fts_converted · Purchases (non FT's)" data={chartData} series={[{ key: 'ftsConverted', label: 'fts_converted', type: 'bar', fmt: 'int', color: GREEN, stack: 'v' }, { key: 'purchasesNonFt', label: "Purchases (non FT's)", type: 'bar', fmt: 'int', color: BLUE, stack: 'v' }]} />
          </div>
        </TabsContent>

        <TabsContent value="margin">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <KpiChart title="TOTAL CONTRIBUTION · Cont. Mgn / Sales · New Subs Margin" data={chartData} series={[{ key: 'totalContribution', label: 'TOTAL CONTRIBUTION', type: 'bar', fmt: 'usd', color: BLUE }, { key: 'contributionMarginPct', label: 'Cont. Mgn / Sales', type: 'line', fmt: 'pct', axis: 'right', color: GREEN }, { key: 'newSubsMargin', label: 'New Subs Margin', type: 'line', fmt: 'pct', axis: 'right', color: ROSE }]} />
            <KpiChart title="NS Sales · spend" data={chartData} series={[{ key: 'nsSales', label: 'NS Sales', type: 'bar', fmt: 'usd', color: GREEN }, { key: 'spend', label: 'spend', type: 'bar', fmt: 'usd', color: ROSE }]} />
            <KpiChart title="TOTAL CONTRIBUTION · spend" data={chartData} series={[{ key: 'spend', label: 'spend', type: 'bar', fmt: 'usd', color: '#CBD5E1' }, { key: 'totalContribution', label: 'TOTAL CONTRIBUTION', type: 'bar', fmt: 'usd', color: BLUE }]} />
            <KpiChart title="Sales / Spend · New Sales / Spend · Cont / Spend" data={chartData} series={[{ key: 'salesOverSpend', label: 'Sales / Spend', type: 'line', fmt: 'x', color: NAVY }, { key: 'newSalesOverSpend', label: 'New Sales / Spend', type: 'line', fmt: 'x', color: BLUE }, { key: 'contributionOverSpend', label: 'Cont / Spend', type: 'line', fmt: 'x', color: GREEN }]} />
            <KpiChart title="Net Sales · Total Sales" data={chartData} series={[{ key: 'totalSales', label: 'Total Sales', type: 'bar', fmt: 'usd', color: '#CBD5E1' }, { key: 'netSales', label: 'Net Sales', type: 'bar', fmt: 'usd', color: BLUE }]} />
            <KpiChart title="NS Sales · renewals_sales · renewals_sales_yearly_ios" data={chartData} series={[{ key: 'nsSales', label: 'NS Sales', type: 'bar', fmt: 'usd', color: BLUE, stack: 'v' }, { key: 'renewalsSales', label: 'renewals_sales', type: 'bar', fmt: 'usd', color: GREEN, stack: 'v' }, { key: 'renewalsSalesYearlyIos', label: 'renewals_sales_yearly_ios', type: 'bar', fmt: 'usd', color: NAVY, stack: 'v' }]} />
          </div>
        </TabsContent>

        <TabsContent value="conversion">
          <div className="space-y-4">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <KpiChart title="Conv. from FT · Conv. from Purchases" data={chartData} series={[{ key: 'convFromFt', label: 'Conv. from FT', type: 'bar', fmt: 'pct', color: GREEN, stack: 'v' }, { key: 'convFromPurchases', label: 'Conv. from Purchases', type: 'bar', fmt: 'pct', color: BLUE, stack: 'v' }]} />
              <KpiChart title="CAC from Purchases · CAC from Free Trials · CAC" data={chartData} series={[{ key: 'cacFromPurchases', label: 'CAC from Purchases', type: 'line', fmt: 'usd2', color: BLUE }, { key: 'cacFromFt', label: 'CAC from Free Trials', type: 'line', fmt: 'usd2', color: ROSE }, { key: 'cacCalculated', label: 'CAC calculated', type: 'line', fmt: 'usd2', color: NAVY }]} note={def === 'looker' ? 'Como en el Looker: estas tres series cuentan las compras con New Subs netas de reembolsos; el CAC de las tablas usa brutas.' : undefined} />
              <KpiChart title="Users per purchase · Users per Trial converted" data={chartData} series={[{ key: 'usersPerPurchase', label: 'Users per purchase', type: 'line', fmt: 'num1', color: BLUE }, { key: 'usersPerFtConverted', label: 'Users per Trial converted', type: 'line', fmt: 'num1', color: GREEN }]} />
              <KpiChart title="signups · downloads · signups/downloads" data={chartData} series={[{ key: 'signups', label: 'signups', type: 'bar', fmt: 'int', color: BLUE }, { key: 'downloads', label: 'downloads', type: 'bar', fmt: 'int', color: GRAY }, { key: 'signupsPerDownload', label: 'signups/downloads', type: 'line', fmt: 'num1', axis: 'right', color: ROSE }]} note="downloads llega en 0 muchos días desde sep-2026 (pendiente con tech): CPI y signups/downloads no son confiables esos días." />
            </div>
            <KpiTable rows={rows} grain={data.grain} def={def} cols={CONVERSION_COLS} total={cur} />
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {(['os', 'kinedu_region', 'kinedu_language', 'country'] as const).map((dim) => (
                <ShareOfSpend key={dim} title={`Share of spend · ${dim}`} rows={data.groupSeries[dim]} grain={data.grain} />
              ))}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="breakdown">
          <div className="space-y-4">
            {(['os', 'kinedu_region', 'kinedu_language', 'country'] as const).map((dim) => (
              <BreakdownTable key={dim} title={dim} rows={data.breakdown[dim]} def={def} total={cur} />
            ))}
          </div>
        </TabsContent>

        <TabsContent value="audit">
          <AuditPanel status={data.status} cur={data.totals.current} generatedAt={data.generatedAt} />
          <GuardPanel guard={data.guard} />
          <DifferencesPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ─── Tabla de KPIs por periodo ───────────────────────────────────────────────

function KpiTable({ rows, grain, def, cols, total }: { rows: PeriodRow[]; grain: Grain; def: Definition; cols: Col[]; total: KpiValues }) {
  const ordered = [...rows].reverse();
  return (
    <Card>
      <CardContent className="pt-4 overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="whitespace-nowrap">{GRAIN_LABELS[grain]}</TableHead>
              {cols.map((c) => <TableHead key={c.key} className="text-right whitespace-nowrap">{c.label}</TableHead>)}
            </TableRow>
          </TableHeader>
          <TableBody>
            {ordered.map((r) => (
              <TableRow key={r.period}>
                <TableCell className="whitespace-nowrap font-medium" title={def === 'fixed' && r.fixed.calibration.estimatedShare > 0.0005 ? `${(r.fixed.calibration.estimatedShare * 100).toFixed(0)} % de las ventas de este periodo es estimado (tienda sin reporte definitivo)` : undefined}>
                  {def === 'fixed' && r.fixed.calibration.estimatedShare > 0.0005 ? <span className="text-amber-600 mr-1">≈</span> : null}{periodLabel(r.period, grain)}
                </TableCell>
                {cols.map((c) => <TableCell key={c.key} className="text-right tabular-nums">{fmt(r[def][c.key] as number | null, c.fmt)}</TableCell>)}
              </TableRow>
            ))}
            <TableRow className="bg-muted/40 font-semibold">
              <TableCell>Total</TableCell>
              {cols.map((c) => <TableCell key={c.key} className="text-right tabular-nums">{fmt(total[c.key] as number | null, c.fmt)}</TableCell>)}
            </TableRow>
          </TableBody>
        </Table>
        <p className="text-[11px] text-muted-foreground mt-2">La fila Total recalcula cada KPI sobre las sumas del periodo completo (como el Looker), no promedia las filas.{def === 'fixed' ? ' ≈ = el periodo incluye ventas estimadas (la tienda aún no publica su reporte definitivo).' : ''}</p>
      </CardContent>
    </Card>
  );
}

// ─── Tabla de desglose por dimensión ─────────────────────────────────────────

function BreakdownTable({ title, rows, def, total }: { title: string; rows: GroupRow[]; def: Definition; total: KpiValues }) {
  const sorted = [...rows].sort((a, b) => (b[def].nsSales ?? 0) - (a[def].nsSales ?? 0)).slice(0, 15);
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-sm font-semibold text-[#0E3687]">{title}{rows.length > 15 ? ` · top 15 de ${rows.length} por NS Sales` : ''}</CardTitle></CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{title}</TableHead>
              <TableHead className="text-right">share NS</TableHead>
              {BREAKDOWN_COLS.map((c) => <TableHead key={c.key} className="text-right whitespace-nowrap">{c.label}</TableHead>)}
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((r) => (
              <TableRow key={r.grp}>
                <TableCell className="font-medium">{r.grp}</TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">{total.nsSales ? fmt(r[def].nsSales / total.nsSales, 'pct') : '—'}</TableCell>
                {BREAKDOWN_COLS.map((c) => <TableCell key={c.key} className="text-right tabular-nums">{fmt(r[def][c.key] as number | null, c.fmt)}</TableCell>)}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

// ─── Gráfica genérica (líneas + barras, dos ejes) ────────────────────────────

interface SeriesDef { key: keyof KpiValues; label: string; type: 'line' | 'bar'; fmt: Fmt; axis?: 'left' | 'right'; color: string; stack?: string }

function KpiChart({ title, data, series, note }: { title: string; data: Record<string, unknown>[]; series: SeriesDef[]; note?: string }) {
  const hasRight = series.some((s) => s.axis === 'right');
  const leftFmt = series.find((s) => s.axis !== 'right')?.fmt ?? 'int';
  const rightFmt = series.find((s) => s.axis === 'right')?.fmt ?? 'int';
  const tick = (f: Fmt) => (v: number) => f === 'pct' ? `${Math.round(v * 100)}%` : f === 'x' ? `${v.toFixed(1)}x` : f === 'usd' || f === 'usd2' ? `$${compact(v)}` : compact(v);
  const fmtByKey = Object.fromEntries(series.map((s) => [s.key, s.fmt])) as Record<string, Fmt>;
  return (
    <Card>
      <CardHeader className="pb-1"><CardTitle className="text-sm font-semibold text-[#0E3687]">{title}</CardTitle></CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={data} margin={{ top: 8, right: hasRight ? 8 : 16, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
            <XAxis dataKey="label" tick={{ fontSize: 10 }} interval="preserveStartEnd" minTickGap={24} />
            <YAxis yAxisId="left" tick={{ fontSize: 10 }} tickFormatter={tick(leftFmt)} width={56} />
            {hasRight && <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10 }} tickFormatter={tick(rightFmt)} width={56} />}
            <Tooltip formatter={(v: unknown, name: unknown) => [fmt(typeof v === 'number' ? v : null, fmtByKey[String(name)] ?? 'int'), series.find((s) => s.key === name)?.label ?? String(name)]} contentStyle={{ fontSize: 12 }} />
            <Legend wrapperStyle={{ fontSize: 11 }} formatter={(v: string) => series.find((s) => s.key === v)?.label ?? v} />
            {series.map((s) => s.type === 'bar'
              ? <Bar key={s.key} yAxisId={s.axis ?? 'left'} dataKey={s.key} fill={s.color} stackId={s.stack} radius={s.stack ? 0 : [3, 3, 0, 0]} />
              : <Line key={s.key} yAxisId={s.axis ?? 'left'} type="monotone" dataKey={s.key} stroke={s.color} strokeWidth={2} dot={false} connectNulls />)}
          </ComposedChart>
        </ResponsiveContainer>
        {note && <p className="text-[11px] text-muted-foreground mt-1">{note}</p>}
      </CardContent>
    </Card>
  );
}

// ─── Share of spend (barras 100 % apiladas) ──────────────────────────────────

function ShareOfSpend({ title, rows, grain }: { title: string; rows: { period: string; grp: string; spend: number }[]; grain: Grain }) {
  const { data, groups } = useMemo(() => {
    const totalsByGrp = new Map<string, number>();
    for (const r of rows) totalsByGrp.set(r.grp, (totalsByGrp.get(r.grp) ?? 0) + r.spend);
    const top = [...totalsByGrp.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([g]) => g);
    const byPeriod = new Map<string, Record<string, number>>();
    for (const r of rows) {
      const g = top.includes(r.grp) ? r.grp : 'Other';
      const rec = byPeriod.get(r.period) ?? {}; rec[g] = (rec[g] ?? 0) + r.spend; byPeriod.set(r.period, rec);
    }
    const groups = rows.some((r) => !top.includes(r.grp)) ? [...top, 'Other'] : top;
    const data = [...byPeriod.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([p, rec]) => {
      const total = Object.values(rec).reduce((s, v) => s + v, 0);
      const out: Record<string, unknown> = { label: periodLabel(p, grain) };
      for (const g of groups) out[g] = total ? (rec[g] ?? 0) / total : 0;
      return out;
    });
    return { data, groups };
  }, [rows, grain]);
  return (
    <Card>
      <CardHeader className="pb-1"><CardTitle className="text-sm font-semibold text-[#0E3687]">{title}</CardTitle></CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={240}>
          <ComposedChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
            <XAxis dataKey="label" tick={{ fontSize: 10 }} interval="preserveStartEnd" minTickGap={24} />
            <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => `${Math.round(v * 100)}%`} width={40} domain={[0, 1]} />
            <Tooltip formatter={(v: unknown) => fmt(typeof v === 'number' ? v : null, 'pct')} contentStyle={{ fontSize: 12 }} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            {groups.map((g, i) => <Bar key={g} dataKey={g} stackId="s" fill={g === 'Other' ? '#CBD5E1' : PALETTE[i % PALETTE.length]} />)}
          </ComposedChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

// ─── Auditoría ───────────────────────────────────────────────────────────────

function AuditPanel({ status, cur, generatedAt }: { status: ReplicaStatus; cur: Record<Definition, KpiValues>; generatedAt: string }) {
  const factor = cur.fixed.totalContribution ? cur.looker.totalContribution / cur.fixed.totalContribution : null;
  const syncedAt = status.lastSyncedAt ? new Date(status.lastSyncedAt) : null;
  const ageH = syncedAt ? (Date.parse(generatedAt) - syncedAt.getTime()) / 36e5 : null;
  const fresh = ageH !== null && ageH < 30;
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm font-semibold text-[#0E3687]">Réplica kpi_daily</CardTitle></CardHeader>
        <CardContent className="text-sm space-y-1.5">
          <p>{fresh ? '✅' : '⚠️'} Última sincronización: {syncedAt ? syncedAt.toLocaleString('es-MX', { timeZone: 'America/Mexico_City' }) : '—'}{ageH !== null ? ` (hace ${ageH.toFixed(1)} h)` : ''}</p>
          <p>Cobertura: {status.minDate ?? '—'} → {status.maxDate ?? '—'} · {nf0.format(status.rows)} filas</p>
          {status.lastJob?.heal ? (
            <p>
              {status.lastJob.heal.badDays - status.lastJob.heal.healedDays > 0 ? '⚠️' : '✅'} Último job: {status.lastJob.heal.checkedDays.toLocaleString('en-US')} días comparados con BigQuery · {status.lastJob.heal.badDays} con diferencias · {status.lastJob.heal.healedDays} reparados
              {status.lastJob.rotated ? ` · mes re-sincronizado en rotación: ${status.lastJob.rotated.start.slice(0, 7)}` : ''}
            </p>
          ) : status.lastJob?.error ? (
            <p>🔴 El último job falló: {status.lastJob.error.slice(0, 200)}</p>
          ) : (
            <p className="text-muted-foreground">Aún no corre el job con verificación completa (empieza con el próximo sync diario).</p>
          )}
          <p className="text-muted-foreground text-xs">Fuente: BigQuery `an_operational_dash` (dbt, ≈09:01 MX). Job diario 09:10 MX: re-sincroniza los últimos 95 días (reembolsos y re-atribuciones llegan semanas después), un mes viejo en rotación, y compara los totales por día de todo el historial contra BigQuery reparando los días que difieran.</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm font-semibold text-[#0E3687]">Definiciones en disputa (periodo seleccionado)</CardTitle></CardHeader>
        <CardContent className="text-sm space-y-1.5">
          <p>Total Contribution Looker: <b>{fmt(cur.looker.totalContribution, 'usd')}</b> · corregido: <b>{fmt(cur.fixed.totalContribution, 'usd')}</b>{factor !== null ? ` · factor ${factor.toFixed(2)}×` : ''}</p>
          <p>Net Sales Looker: {fmt(cur.looker.netSales, 'usd')} · corregido: {fmt(cur.fixed.netSales, 'usd')}</p>
          <p>{factor !== null && factor < 1.05 ? '✅ El Looker ya aplica el fix de Stripe (factor < 1.05×).' : '⏳ Pendiente de tech: Stripe se netea como Apple/Google dentro de Net Sales y se suma otra vez al 0.965 en Total Contribution.'}</p>
          <p className="text-muted-foreground text-xs">Google: el Looker registra el monto cobrado con impuesto y a un tipo de cambio ≈8–10 % más fuerte que el de Google (≈ +12 % vs cobrado). Pendiente con tech/Finanzas; la auditoría diaria de tiendas lo marca como ⏳.</p>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Aviso de calibración (Corregido) ─────────────────────────────────────────

const STORE_LABEL: Record<StoreCoverage['store'], string> = { apple: 'Apple', google: 'Google', stripe: 'Stripe' };
const shortDay = (d: string) => { const x = new Date(d + 'T00:00:00Z'); return `${x.getUTCDate()} ${MONTHS[x.getUTCMonth()].toLowerCase()}`; };
function dayRanges(days: string[]): string {
  const out: string[] = []; let s: string | null = null; let prev: string | null = null;
  const next = (d: string) => new Date(Date.parse(d + 'T00:00:00Z') + 86_400_000).toISOString().slice(0, 10);
  for (const d of [...days].sort()) {
    if (s && prev && next(prev) === d) { prev = d; continue; }
    if (s) out.push(s === prev ? shortDay(s) : `${shortDay(s)}–${shortDay(prev!)}`);
    s = d; prev = d;
  }
  if (s) out.push(s === prev ? shortDay(s) : `${shortDay(s)}–${shortDay(prev!)}`);
  return out.join(', ');
}

function CalibrationBanner({ coverage, kpis }: { coverage: StoreCoverage[]; kpis: KpiValues }) {
  if (!kpis.calibration.calibrated) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900">
        Corregido con tasas fijas: la calibración con datos de tienda (migración 037) todavía no está activa.
      </div>
    );
  }
  const items = coverage.map((c) => {
    // Solo días recientes sin reporte (después del último definitivo); los anteriores a la cobertura van como "sin calibrar".
    const recentMissing = c.lastFinal ? c.missingDays.filter((d) => d > c.lastFinal!) : [];
    return { c, recentMissing };
  });
  const est = items.filter((x) => x.c.estimatedDays.length || x.recentMissing.length);
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-900 space-y-1">
      <p>
        <b>Corregido calibrado con tienda.</b> Real hasta: {items.map(({ c }) => `${STORE_LABEL[c.store]} ${c.lastFinal ? shortDay(c.lastFinal) : '—'}`).join(' · ')}.
        {kpis.calibration.estimatedShare > 0.0005 ? ` ${(kpis.calibration.estimatedShare * 100).toFixed(1)} % de las ventas de este periodo es estimado.` : ' Todo el periodo usa reportes definitivos.'}
        {kpis.calibration.uncalibratedShare > 0.0005 ? ` ${(kpis.calibration.uncalibratedShare * 100).toFixed(1)} % sin calibrar (antes de la cobertura de tienda o procesadores sin reporte: tasas fijas).` : ''}
      </p>
      {est.length > 0 && (
        <p>
          <b>Días estimados:</b>{' '}
          {est.map(({ c, recentMissing }) => [
            recentMissing.length ? `${STORE_LABEL[c.store]} ${dayRanges(recentMissing)} (aún no publica: factor de los 7 días previos)` : null,
            c.estimatedDays.length ? `${STORE_LABEL[c.store]} ${dayRanges(c.estimatedDays)} (${c.store === 'google' ? 'mes en curso: reporte diario + FX y comisión del último earnings' : 'reporte preliminar'})` : null,
          ].filter(Boolean).join(' · ')).join(' · ')}
        </p>
      )}
    </div>
  );
}

// ─── Guardia de KPIs y registro de diferencias (pestaña Auditoría) ───────────

const gIcon = (s: 'ok' | 'warn' | 'alarm') => (s === 'ok' ? '✅' : s === 'warn' ? '⚠️' : '🔴');

function GuardPanel({ guard }: { guard: GuardSnapshot | null }) {
  return (
    <Card className="mt-4">
      <CardHeader className="pb-2"><CardTitle className="text-sm font-semibold text-[#0E3687]">Guardia de KPIs (auditor automático, cada hora)</CardTitle></CardHeader>
      <CardContent className="text-sm space-y-1">
        {!guard ? <p className="text-muted-foreground">Aún no hay corridas registradas (la tabla se crea con la migración 037).</p> : (
          <>
            <p className="text-xs text-muted-foreground">Última corrida: {new Date(guard.ranAt).toLocaleString('es-MX', { timeZone: 'America/Mexico_City' })} · {gIcon(guard.status)} {guard.checks.filter((c) => c.status === 'ok').length}/{guard.checks.length} chequeos en verde · avisa a Slack solo cuando algo cambia de estado</p>
            {guard.checks.map((c) => <p key={c.id}>{gIcon(c.status)} <span className="text-muted-foreground">[{c.area}]</span> {c.line}</p>)}
          </>
        )}
      </CardContent>
    </Card>
  );
}

const STATUS_LABEL: Record<string, string> = { 'resuelto-en-looker': '✅ resuelto en el Looker', 'pendiente-tech': '⏳ pendiente de tech', 'solo-corregido': '🟦 solo en el Corregido', 'pendiente-decision': '❓ pendiente de decisión', documentado: '📄 documentado' };
const KIND_LABEL: Record<string, string> = { correccion: 'Corrección', inconsistencia: 'Inconsistencia del Looker', alcance: 'Por diseño', dato: 'Fuente de datos' };

function DifferencesPanel() {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Card className="mt-4">
      <CardHeader className="pb-2"><CardTitle className="text-sm font-semibold text-[#0E3687]">Diferencias vs Looker ({LOOKER_DIFFERENCES.length}) — registro completo, también en docs/DIFERENCIAS-LOOKER.md</CardTitle></CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader><TableRow><TableHead>Diferencia</TableHead><TableHead>Tipo</TableHead><TableHead>Estado</TableHead><TableHead>KPIs</TableHead><TableHead>Impacto</TableHead></TableRow></TableHeader>
          <TableBody>
            {LOOKER_DIFFERENCES.map((d) => (
              <Fragment key={d.id}>
                <TableRow className="cursor-pointer hover:bg-muted/40" onClick={() => setOpen(open === d.id ? null : d.id)}>
                  <TableCell className="font-medium">{open === d.id ? '▾' : '▸'} {d.title}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs">{KIND_LABEL[d.kind]}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs">{STATUS_LABEL[d.status]}</TableCell>
                  <TableCell className="text-xs">{d.kpis.join(', ')}</TableCell>
                  <TableCell className="text-xs">{d.impact}</TableCell>
                </TableRow>
                {open === d.id && (
                  <TableRow className="bg-muted/20">
                    <TableCell colSpan={5} className="text-xs space-y-1.5 whitespace-normal">
                      <p><b>Looker:</b> {d.looker}</p>
                      <p><b>Dashboard (Corregido):</b> {d.corregido}</p>
                      <p><b>Evidencia:</b> {d.evidence}</p>
                      {d.decision && <p><b>Decisión:</b> {d.decision}</p>}
                      <p className="text-muted-foreground">Encontrado: {d.found}{d.code ? ` · código: ${d.code}` : ''}</p>
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

