'use client';

import { Fragment, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { Filter as FunnelIcon, DollarSign, LineChart as LineIcon, PieChart, Percent, Layers, ShieldCheck, TrendingUp, TrendingDown } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import type { KpiValues, Grain, ReplicaStatus, Definition, StoreCoverage, GuardSnapshot } from '@/lib/kpi/replica';
import { LOOKER_DIFFERENCES } from '@/lib/kpi/looker-differences';
import type { Preset } from '@/app/(dashboard)/dashboard/operativo/page';
import { KpiChart, Sparkline, TrendExplorer, type ChartRow, type EstRange, type SeriesDef } from './operativo/charts';
import { KpiTable, BreakdownTable } from './operativo/tables';
import { TodayStrip } from './operativo/today';
import { FilterBar, DIMS, type DimKey } from './operativo/filters';
import {
  fmt, compact, nf0, MONTHS, periodLabel, MONEY_KEYS, KPI_BY_KEY,
  FUNNEL_COLS, SALES_COLS, CONVERSION_COLS, SCORECARDS, BLUE, NAVY, GREEN, ROSE, GRAY, SLATE, PALETTE,
} from './operativo/format';

// ─── Tipos que recibe del servidor ───────────────────────────────────────────

export interface PeriodRow { period: string; looker: KpiValues; fixed: KpiValues }
export interface GroupRow extends PeriodRow { grp: string }
export interface DefPair { looker: KpiValues; fixed: KpiValues }
export interface TodayBlock {
  date: string;
  cutoffIso: string | null; cutoffLabel: string | null; fraction: number | null;
  stale: boolean; tooEarly: boolean; hasData: boolean; baselineDays: number;
  running: DefPair; projected: DefPair | null; baseline: DefPair | null; yesterday: DefPair;
}
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
  today: TodayBlock;
  generatedAt: string; // ISO, hora del servidor al generar la página
}

const TABS = ['funnel', 'sales', 'graphs', 'margin', 'conversion', 'breakdown', 'audit'];
const TAB_META: { v: string; label: string; icon: typeof FunnelIcon }[] = [
  { v: 'funnel', label: 'Funnel', icon: FunnelIcon }, { v: 'sales', label: 'Sales Metrics', icon: DollarSign },
  { v: 'graphs', label: 'Gráficas', icon: LineIcon }, { v: 'margin', label: 'Ventas y margen', icon: PieChart },
  { v: 'conversion', label: 'Conversión', icon: Percent }, { v: 'breakdown', label: 'Desglose', icon: Layers },
  { v: 'audit', label: 'Auditoría', icon: ShieldCheck },
];
const DIM_TITLE: Record<DimKey, string> = { os: 'OS', kinedu_region: 'Región (kinedu_region)', kinedu_language: 'Idioma (kinedu_language)', country: 'País (country)' };

export function OperativoContent({ data }: { data: OperativoData }) {
  const router = useRouter(); const pathname = usePathname(); const sp = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [def, setDefState] = useState<Definition>(sp.get('def') === 'fixed' ? 'fixed' : 'looker');
  const [tab, setTabState] = useState<string>(TABS.includes(sp.get('tab') ?? '') ? (sp.get('tab') as string) : 'funnel');
  const [focus, setFocusState] = useState<string>(KPI_BY_KEY[sp.get('kpi') ?? ''] ? (sp.get('kpi') as string) : 'totalContribution');
  const [compare, setCompareState] = useState<string>(sp.has('vs') ? (KPI_BY_KEY[sp.get('vs') ?? ''] ? (sp.get('vs') as string) : '') : 'spend');
  const explorerRef = useRef<HTMLDivElement>(null);
  // Pestaña, definición y KPI en foco viven en la URL (sin recargar) para que los enlaces abran la vista exacta.
  function syncUrl(patch: Record<string, string>) {
    const next = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(patch)) next.set(k, v);
    window.history.replaceState(null, '', `${pathname}?${next.toString()}`);
  }
  const setDef = (d: Definition) => { setDefState(d); syncUrl({ def: d }); };
  const setTab = (t: string) => { setTabState(t); syncUrl({ tab: t }); };
  const setFocus = (k: string) => { setFocusState(k); syncUrl({ kpi: k }); };
  const setCompare = (k: string) => { setCompareState(k); syncUrl({ vs: k }); };

  // Los filtros recargan los datos del servidor: en transición, para que la página siga usable y muestre "actualizando…".
  function setParams(patch: Record<string, string | null>) {
    const next = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(patch)) { if (v === null || v === '') next.delete(k); else next.set(k, v); }
    startTransition(() => router.push(`${pathname}?${next.toString()}`, { scroll: false }));
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
  const chartData = useMemo<ChartRow[]>(() => rows.map((r) => ({
    label: periodLabel(r.period, data.grain), ...r[def],
    ...(monthlyLooker ? { newSalesOverSpend: r[def].newSalesOverSpendNet } : {}),
  })), [rows, def, data.grain, monthlyLooker]);
  const curView = monthlyLooker ? { ...cur, newSalesOverSpend: cur.newSalesOverSpendNet } : cur;
  // Corregido: tramo con ventas estimadas (tienda sin reporte definitivo), sombreado en las gráficas de montos.
  const est = useMemo<EstRange | null>(() => {
    if (def !== 'fixed') return null;
    const e = chartData.filter((r) => (r.calibration?.estimatedShare ?? 0) > 0.0005);
    return e.length ? { x1: e[0].label, x2: e[e.length - 1].label } : null;
  }, [chartData, def]);
  const chart = (title: string, series: SeriesDef[], note?: string) => <KpiChart title={title} data={chartData} series={series} note={note} def={def} est={est} totals={curView} />;

  const toggleDim = (dim: DimKey, value: string) => {
    const d = DIMS.find((x) => x.key === dim)!; const sel = data.filters[d.filter];
    const next = sel.includes(value) ? sel.filter((v) => v !== value) : [...sel, value];
    setParams({ [d.param]: next.join(',') || null });
  };
  const drill = (start: string, end: string, grain: Grain) => setParams({ preset: 'custom', start, end, grain });
  const tableProps = { rows, grain: data.grain, def, total: cur, rangeStart: data.start, rangeEnd: data.end, onDrill: drill };

  return (
    <div className="space-y-5">
      <FilterBar preset={data.preset} start={data.start} end={data.end} grain={data.grain} days={data.days} priorStart={data.totals.priorStart} priorEnd={data.totals.priorEnd}
        filters={data.filters} dimOptions={dimOptions} def={def} setDef={setDef} setParams={setParams} pending={pending} status={data.status} />

      <div className={cn('space-y-5 transition-opacity duration-200', pending && 'opacity-60')}>
        <TodayStrip today={data.today} def={def} />

        {def === 'fixed' && <CalibrationBanner coverage={data.storeCoverage} kpis={cur} />}

        {/* Tarjetas: clic = ver el KPI en grande en el explorador */}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {SCORECARDS.map((c) => {
            const v = cur[c.key] as number | null; const p = prev[c.key] as number | null;
            const delta = v !== null && p !== null && p !== 0 ? (v - p) / Math.abs(p) : null;
            const good = delta === null ? null : c.higherIsBetter ? delta >= 0 : delta <= 0;
            const active = focus === c.key;
            const estimated = def === 'fixed' && MONEY_KEYS.has(c.key) && cur.calibration.estimatedShare > 0.0005;
            return (
              <button key={c.key} type="button"
                onClick={() => { setFocus(c.key); explorerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }}
                className={cn('group rounded-xl border bg-white px-4 pb-2 pt-3.5 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md',
                  active ? 'border-[#0086D8] ring-2 ring-[#0086D8]/15' : 'border-slate-200/80 hover:border-[#0086D8]/40')}>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] font-medium uppercase tracking-wider text-slate-500">{c.label}</p>
                  {estimated && <span className="text-[11px] text-amber-600" title="Incluye ventas estimadas">≈</span>}
                </div>
                <p className="mt-0.5 text-2xl font-bold tracking-tight text-[#0E3687] tabular-nums">{fmt(v, c.fmt)}</p>
                <div className="mt-1 flex items-center gap-1.5 text-[11px]">
                  {delta === null ? <span className="text-slate-400">sin periodo previo</span> : (
                    <>
                      <span className={cn('inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 font-semibold', good ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700')}>
                        {delta >= 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}{delta >= 0 ? '+' : ''}{(delta * 100).toFixed(1)}%
                      </span>
                      <span className="truncate text-slate-400">vs {fmt(p, c.fmt)}</span>
                    </>
                  )}
                </div>
                <div className="mt-1.5 opacity-80 transition-opacity group-hover:opacity-100"><Sparkline data={chartData} k={c.key} color={good === false ? ROSE : BLUE} /></div>
              </button>
            );
          })}
        </div>

        <div ref={explorerRef} className="scroll-mt-48">
          <TrendExplorer data={chartData} focus={focus} onFocus={setFocus} compare={compare} onCompare={setCompare} cur={curView} prev={prev} def={def} grain={data.grain} est={est} />
        </div>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="h-auto flex-wrap gap-1 rounded-xl border border-slate-200/80 bg-white p-1 shadow-sm">
            {TAB_META.map(({ v, label, icon: Icon }) => (
              <TabsTrigger key={v} value={v} className="gap-1.5 rounded-lg px-3 py-1.5 text-xs text-slate-600 data-[state=active]:bg-[#0E3687] data-[state=active]:text-white data-[state=active]:shadow-sm">
                <Icon className="h-3.5 w-3.5" />{label}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="funnel"><KpiTable {...tableProps} cols={FUNNEL_COLS} name="funnel" /></TabsContent>
          <TabsContent value="sales"><KpiTable {...tableProps} cols={SALES_COLS} name="sales" /></TabsContent>

          <TabsContent value="graphs">
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {chart('1st Ticket / CAC · spend', [{ key: 'firstTicketCac', label: '1st Ticket / CAC', type: 'line', fmt: 'x', color: NAVY }, { key: 'spend', label: 'spend', type: 'bar', fmt: 'usd', axis: 'right', color: SLATE }])}
              {chart('CPFT · CAC', [{ key: 'cpft', label: 'CPFT', type: 'line', fmt: 'usd2', color: BLUE }, { key: 'cac', label: 'CAC', type: 'line', fmt: 'usd2', color: ROSE }])}
              {chart('ARPU · CAC · ARPU−CAC', [{ key: 'arpu', label: 'ARPU', type: 'line', fmt: 'usd2', color: GREEN }, { key: 'cac', label: 'CAC', type: 'line', fmt: 'usd2', color: ROSE }, { key: 'arpuMinusCac', label: 'ARPU−CAC', type: 'bar', fmt: 'usd2', color: SLATE }])}
              {chart('CPNU · Conversion Rate', [{ key: 'cpnu', label: 'CPNU', type: 'line', fmt: 'usd2', color: BLUE }, { key: 'conversionRate', label: 'Conversion Rate', type: 'line', fmt: 'pct', axis: 'right', color: GREEN }])}
              {chart('New Subs · renewals · renewals_yearly_ios', [{ key: 'newSubs', label: 'New Subs', type: 'bar', fmt: 'int', color: BLUE, stack: 'v' }, { key: 'renewals', label: 'renewals', type: 'bar', fmt: 'int', color: GREEN, stack: 'v' }, { key: 'renewalsYearlyIos', label: 'renewals_yearly_ios', type: 'bar', fmt: 'int', color: NAVY, stack: 'v' }])}
              {chart('signups · spend', [{ key: 'signups', label: 'signups', type: 'bar', fmt: 'int', color: BLUE }, { key: 'spend', label: 'spend', type: 'line', fmt: 'usd', axis: 'right', color: ROSE }])}
              {chart('fts_started · FreeTrialStartRate', [{ key: 'ftsStarted', label: 'fts_started', type: 'bar', fmt: 'int', color: BLUE }, { key: 'ftStartRate', label: 'FT start rate', type: 'line', fmt: 'pct', axis: 'right', color: GREEN }])}
              {chart("fts_converted · Purchases (non FT's)", [{ key: 'ftsConverted', label: 'fts_converted', type: 'bar', fmt: 'int', color: GREEN, stack: 'v' }, { key: 'purchasesNonFt', label: "Purchases (non FT's)", type: 'bar', fmt: 'int', color: BLUE, stack: 'v' }])}
            </div>
          </TabsContent>

          <TabsContent value="margin">
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {chart('TOTAL CONTRIBUTION · Cont. Mgn / Sales · New Subs Margin', [{ key: 'totalContribution', label: 'TOTAL CONTRIBUTION', type: 'bar', fmt: 'usd', color: BLUE }, { key: 'contributionMarginPct', label: 'Cont. Mgn / Sales', type: 'line', fmt: 'pct', axis: 'right', color: GREEN }, { key: 'newSubsMargin', label: 'New Subs Margin', type: 'line', fmt: 'pct', axis: 'right', color: ROSE }])}
              {chart('NS Sales · spend', [{ key: 'nsSales', label: 'NS Sales', type: 'bar', fmt: 'usd', color: GREEN }, { key: 'spend', label: 'spend', type: 'bar', fmt: 'usd', color: ROSE }])}
              {chart('TOTAL CONTRIBUTION · spend', [{ key: 'spend', label: 'spend', type: 'bar', fmt: 'usd', color: SLATE }, { key: 'totalContribution', label: 'TOTAL CONTRIBUTION', type: 'bar', fmt: 'usd', color: BLUE }])}
              {chart('Sales / Spend · New Sales / Spend · Cont / Spend', [{ key: 'salesOverSpend', label: 'Sales / Spend', type: 'line', fmt: 'x', color: NAVY }, { key: 'newSalesOverSpend', label: 'New Sales / Spend', type: 'line', fmt: 'x', color: BLUE }, { key: 'contributionOverSpend', label: 'Cont / Spend', type: 'line', fmt: 'x', color: GREEN }])}
              {chart('Net Sales · Total Sales', [{ key: 'totalSales', label: 'Total Sales', type: 'bar', fmt: 'usd', color: SLATE }, { key: 'netSales', label: 'Net Sales', type: 'bar', fmt: 'usd', color: BLUE }])}
              {chart('NS Sales · renewals_sales · renewals_sales_yearly_ios', [{ key: 'nsSales', label: 'NS Sales', type: 'bar', fmt: 'usd', color: BLUE, stack: 'v' }, { key: 'renewalsSales', label: 'renewals_sales', type: 'bar', fmt: 'usd', color: GREEN, stack: 'v' }, { key: 'renewalsSalesYearlyIos', label: 'renewals_sales_yearly_ios', type: 'bar', fmt: 'usd', color: NAVY, stack: 'v' }])}
            </div>
          </TabsContent>

          <TabsContent value="conversion">
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {chart('Conv. from FT · Conv. from Purchases', [{ key: 'convFromFt', label: 'Conv. from FT', type: 'bar', fmt: 'pct', color: GREEN, stack: 'v' }, { key: 'convFromPurchases', label: 'Conv. from Purchases', type: 'bar', fmt: 'pct', color: BLUE, stack: 'v' }])}
                {chart('CAC from Purchases · CAC from Free Trials · CAC', [{ key: 'cacFromPurchases', label: 'CAC from Purchases', type: 'line', fmt: 'usd2', color: BLUE }, { key: 'cacFromFt', label: 'CAC from Free Trials', type: 'line', fmt: 'usd2', color: ROSE }, { key: 'cacCalculated', label: 'CAC calculated', type: 'line', fmt: 'usd2', color: NAVY }],
                  def === 'looker' ? 'Como en el Looker: estas tres series cuentan las compras con New Subs netas de reembolsos; el CAC de las tablas usa brutas.' : undefined)}
                {chart('Users per purchase · Users per Trial converted', [{ key: 'usersPerPurchase', label: 'Users per purchase', type: 'line', fmt: 'num1', color: BLUE }, { key: 'usersPerFtConverted', label: 'Users per Trial converted', type: 'line', fmt: 'num1', color: GREEN }])}
                {chart('signups · downloads · signups/downloads', [{ key: 'signups', label: 'signups', type: 'bar', fmt: 'int', color: BLUE }, { key: 'downloads', label: 'downloads', type: 'bar', fmt: 'int', color: GRAY }, { key: 'signupsPerDownload', label: 'signups/downloads', type: 'line', fmt: 'num1', axis: 'right', color: ROSE }],
                  'downloads llega en 0 muchos días desde sep-2026 (pendiente con tech): CPI y signups/downloads no son confiables esos días.')}
              </div>
              <KpiTable {...tableProps} cols={CONVERSION_COLS} name="conversion" />
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {(['os', 'kinedu_region', 'kinedu_language', 'country'] as const).map((dim) => (
                  <ShareOfSpend key={dim} title={`Share of spend · ${dim}`} rows={data.groupSeries[dim]} grain={data.grain} />
                ))}
              </div>
            </div>
          </TabsContent>

          <TabsContent value="breakdown">
            <div className="space-y-4">
              {(['os', 'kinedu_region', 'kinedu_language', 'country'] as const).map((dim) => (
                <BreakdownTable key={dim} title={DIM_TITLE[dim]} rows={data.breakdown[dim]} def={def} total={cur}
                  selected={data.filters[DIMS.find((d) => d.key === dim)!.filter]} onToggle={(v) => toggleDim(dim, v)} />
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
    </div>
  );
}

// ─── Share of spend (barras 100 % apiladas) ──────────────────────────────────

function ShareOfSpend({ title, rows, grain }: { title: string; rows: { period: string; grp: string; spend: number }[]; grain: Grain }) {
  const { data, series } = useMemo(() => {
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
      const out: ChartRow = { label: periodLabel(p, grain) };
      for (const g of groups) out[g] = total ? (rec[g] ?? 0) / total : 0;
      return out;
    });
    const series: SeriesDef[] = groups.map((g, i) => ({ key: g, label: g, type: 'bar', fmt: 'pct', color: g === 'Other' ? SLATE : PALETTE[i % PALETTE.length], stack: 's' }));
    return { data, series };
  }, [rows, grain]);
  return <KpiChart title={title} data={data} series={series} yDomain={[0, 1]} height={230} />;
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
      <CardHeader className="pb-2"><CardTitle className="text-sm font-semibold text-[#0E3687]">Guardia de KPIs (auditor automático, 4 veces al día)</CardTitle></CardHeader>
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

