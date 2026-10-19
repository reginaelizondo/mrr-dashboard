'use client';

import { useEffect, useId, useMemo, useState } from 'react';
import {
  ResponsiveContainer, ComposedChart, AreaChart, Area, Line, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Brush, ReferenceLine, ReferenceArea,
} from 'recharts';
import { Download, Maximize2, X, TrendingUp, TrendingDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Definition, Grain, KpiValues } from '@/lib/kpi/replica';
import { fmt, tickFmt, KPI_GROUPS, KPI_BY_KEY, MONEY_KEYS, GRAIN_SHORT, BLUE, ROSE, NAVY, downloadCsv, type Fmt } from './format';

export type ChartRow = Record<string, unknown> & { label: string; calibration?: { estimatedShare: number } };
export interface SeriesDef { key: string; label: string; type: 'line' | 'bar'; fmt: Fmt; axis?: 'left' | 'right'; color: string; stack?: string }
/** Tramo final de la serie con ventas estimadas (Corregido): se sombrea en las gráficas de montos. */
export interface EstRange { x1: string; x2: string }

const SYNC = 'operativo';
const AXIS_TICK = { fontSize: 10, fill: '#64748B' };

// ─── Tooltip ─────────────────────────────────────────────────────────────────

interface TooltipLike { active?: boolean; label?: unknown; payload?: readonly { dataKey?: unknown; value?: unknown; color?: string; payload?: unknown }[] }

function ChartTooltip({ active, payload, label, series, def }: TooltipLike & { series: SeriesDef[]; def?: Definition }) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload as ChartRow | undefined;
  const est = def === 'fixed' ? row?.calibration?.estimatedShare ?? 0 : 0;
  const money = payload.some((p) => MONEY_KEYS.has(String(p.dataKey)));
  return (
    <div className="rounded-lg border border-slate-200 bg-white/95 px-3 py-2 text-xs shadow-xl backdrop-blur-sm min-w-[190px]">
      <p className="mb-1.5 font-semibold text-[#0E3687]">{String(label)}</p>
      <div className="space-y-1">
        {payload.map((p) => {
          const s = series.find((x) => x.key === p.dataKey);
          if (!s) return null;
          return (
            <div key={s.key} className="flex items-center justify-between gap-4">
              <span className="flex items-center gap-1.5 text-slate-600"><span className="h-2 w-2 rounded-full" style={{ background: s.color }} />{s.label}</span>
              <span className="font-semibold tabular-nums text-slate-900">{fmt(typeof p.value === 'number' ? p.value : null, s.fmt)}</span>
            </div>
          );
        })}
      </div>
      {money && est > 0.0005 && <p className="mt-1.5 border-t border-slate-100 pt-1.5 text-amber-700">≈ {(est * 100).toFixed(0)} % de las ventas de este periodo es estimado</p>}
    </div>
  );
}

// ─── Gráfica base (líneas + barras, dos ejes) ────────────────────────────────

function SeriesChart({ data, series, hidden, height, brush, est, def, yDomain, sync = true }: {
  data: ChartRow[]; series: SeriesDef[]; hidden: Set<string>; height: number; brush?: boolean; est?: EstRange | null; def?: Definition; yDomain?: [number, number]; sync?: boolean;
}) {
  const uid = useId().replace(/:/g, '');
  const visible = series.filter((s) => !hidden.has(s.key));
  const hasRight = series.some((s) => s.axis === 'right');
  const leftFmt = series.find((s) => s.axis !== 'right')?.fmt ?? 'int';
  const rightFmt = series.find((s) => s.axis === 'right')?.fmt ?? 'int';
  // En barras apiladas solo la de hasta arriba lleva esquinas redondeadas.
  const lastStacked = new Map<string, string>();
  for (const s of visible) if (s.type === 'bar' && s.stack) lastStacked.set(s.stack, s.key);
  const shadeEst = est && series.some((s) => MONEY_KEYS.has(s.key));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={{ top: 8, right: hasRight ? 4 : 12, left: 0, bottom: 0 }} syncId={sync ? SYNC : undefined} syncMethod="value">
        <defs>
          {series.filter((s) => s.type === 'bar').map((s) => (
            <linearGradient key={s.key} id={`g${uid}${s.key.replace(/\W/g, '')}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity={0.95} />
              <stop offset="100%" stopColor={s.color} stopOpacity={0.6} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid vertical={false} stroke="#EEF2F7" />
        <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: '#E2E8F0' }} interval="preserveStartEnd" minTickGap={28} />
        <YAxis yAxisId="left" tick={AXIS_TICK} tickLine={false} axisLine={false} tickFormatter={tickFmt(leftFmt)} width={52} domain={yDomain} />
        {hasRight && <YAxis yAxisId="right" orientation="right" tick={AXIS_TICK} tickLine={false} axisLine={false} tickFormatter={tickFmt(rightFmt)} width={48} />}
        <Tooltip content={(p) => <ChartTooltip {...(p as TooltipLike)} series={series} def={def} />} cursor={{ fill: 'rgba(0,134,216,0.06)', stroke: '#0086D8', strokeOpacity: 0.25 }} />
        {shadeEst && <ReferenceArea yAxisId="left" x1={est!.x1} x2={est!.x2} fill="#F59E0B" fillOpacity={0.08} stroke="#F59E0B" strokeOpacity={0.25} strokeDasharray="3 3" label={{ value: '≈ incluye estimado', position: 'insideTopRight', fontSize: 10, fill: '#B45309' }} />}
        {visible.map((s) => s.type === 'bar'
          ? <Bar key={s.key} yAxisId={s.axis ?? 'left'} dataKey={s.key} fill={`url(#g${uid}${s.key.replace(/\W/g, '')})`} stackId={s.stack} maxBarSize={28}
              radius={!s.stack || lastStacked.get(s.stack) === s.key ? [3, 3, 0, 0] : 0} animationDuration={500} />
          : <Line key={s.key} yAxisId={s.axis ?? 'left'} type="monotone" dataKey={s.key} stroke={s.color} strokeWidth={2.25} dot={false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: '#fff' }} connectNulls animationDuration={500} />)}
        {brush && data.length > 12 && <Brush dataKey="label" height={22} stroke="#8EC5EC" travellerWidth={8} fill="#F8FAFC" tickFormatter={() => ''} />}
      </ComposedChart>
    </ResponsiveContainer>
  );
}

// ─── Pastillas de serie (encender / apagar) ──────────────────────────────────

function SeriesPills({ series, hidden, toggle, totals }: { series: SeriesDef[]; hidden: Set<string>; toggle: (k: string) => void; totals?: Partial<KpiValues> }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {series.map((s) => {
        const off = hidden.has(s.key);
        const total = totals ? (totals as Record<string, unknown>)[s.key] : undefined;
        return (
          <button key={s.key} type="button" onClick={() => toggle(s.key)} title={off ? 'Mostrar serie' : 'Ocultar serie'}
            className={cn('inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] transition-all',
              off ? 'border-dashed border-slate-300 text-slate-400' : 'border-slate-200 bg-white text-slate-700 hover:border-[#0086D8]/50 hover:shadow-sm')}>
            <span className={cn('h-2 w-2 rounded-full', off && 'opacity-30')} style={{ background: s.color }} />
            <span className={cn(off && 'line-through')}>{s.label}</span>
            {typeof total === 'number' && !off && <span className="font-semibold tabular-nums text-[#0E3687]">{fmt(total, s.fmt)}</span>}
          </button>
        );
      })}
    </div>
  );
}

// ─── Tarjeta de gráfica: pastillas, ampliar, descargar ───────────────────────

export function KpiChart({ title, data, series, note, def, est, totals, yDomain, height = 250 }: {
  title: string; data: ChartRow[]; series: SeriesDef[]; note?: string; def?: Definition; est?: EstRange | null; totals?: Partial<KpiValues>; yDomain?: [number, number]; height?: number;
}) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState(false);
  const toggle = (k: string) => setHidden((h) => {
    const n = new Set(h);
    if (n.has(k)) n.delete(k); else if (n.size < series.length - 1) n.add(k); // siempre queda al menos una
    return n;
  });
  const csv = () => downloadCsv(`${title.replace(/[^\w]+/g, '_').toLowerCase()}.csv`, ['periodo', ...series.map((s) => s.label)],
    data.map((r) => [r.label, ...series.map((s) => r[s.key] as number | null)]));

  const header = (big: boolean) => (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 space-y-1.5">
        <h3 className={cn('font-semibold text-[#0E3687] leading-tight', big ? 'text-base' : 'text-sm')}>{title}</h3>
        <SeriesPills series={series} hidden={hidden} toggle={toggle} totals={totals} />
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <IconBtn label="Descargar CSV" onClick={csv}><Download className="h-3.5 w-3.5" /></IconBtn>
        {big ? <IconBtn label="Cerrar" onClick={() => setExpanded(false)}><X className="h-4 w-4" /></IconBtn>
          : <IconBtn label="Ampliar (con zoom)" onClick={() => setExpanded(true)}><Maximize2 className="h-3.5 w-3.5" /></IconBtn>}
      </div>
    </div>
  );

  return (
    <>
      <div className="group rounded-xl border border-slate-200/80 bg-white p-4 shadow-sm transition-shadow hover:shadow-md">
        {header(false)}
        <div className="mt-3"><SeriesChart data={data} series={series} hidden={hidden} height={height} est={est} def={def} yDomain={yDomain} /></div>
        {note && <p className="mt-1 text-[11px] text-muted-foreground">{note}</p>}
      </div>
      {expanded && (
        <Modal onClose={() => setExpanded(false)}>
          {header(true)}
          <div className="mt-4"><SeriesChart data={data} series={series} hidden={hidden} height={480} brush est={est} def={def} yDomain={yDomain} sync={false} /></div>
          <p className="mt-2 text-[11px] text-muted-foreground">Arrastra los extremos de la barra de abajo para hacer zoom a un tramo. {note ?? ''}</p>
        </Modal>
      )}
    </>
  );
}

function IconBtn({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} title={label} aria-label={label}
      className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-[#F0F4FF] hover:text-[#0E3687]">{children}</button>
  );
}

export function Modal({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-[2px] animate-in fade-in" onClick={onClose}>
      <div className="w-full max-w-6xl rounded-2xl bg-white p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>{children}</div>
    </div>
  );
}

// ─── Mini-gráfica para las tarjetas ──────────────────────────────────────────

export function Sparkline({ data, k, color = BLUE }: { data: ChartRow[]; k: string; color?: string }) {
  const uid = useId().replace(/:/g, '');
  if (data.length < 2) return <div className="h-9" />;
  return (
    <ResponsiveContainer width="100%" height={36}>
      <AreaChart data={data} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={`s${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.35} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <YAxis hide domain={['dataMin', 'dataMax']} />
        <Area type="monotone" dataKey={k} stroke={color} strokeWidth={1.5} fill={`url(#s${uid})`} dot={false} isAnimationActive={false} connectNulls />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// ─── Explorador: cualquier KPI en grande, comparado con otro ─────────────────

export function TrendExplorer({ data, focus, onFocus, compare, onCompare, cur, prev, def, grain, est }: {
  data: ChartRow[]; focus: string; onFocus: (k: string) => void; compare: string; onCompare: (k: string) => void;
  cur: KpiValues; prev: KpiValues; def: Definition; grain: Grain; est?: EstRange | null;
}) {
  const uid = useId().replace(/:/g, '');
  const main = KPI_BY_KEY[focus] ?? KPI_BY_KEY.totalContribution;
  const other = compare ? KPI_BY_KEY[compare] : undefined;
  const stats = useMemo(() => {
    const pts = data.map((r) => ({ label: r.label, v: r[main.key] as number | null })).filter((p): p is { label: string; v: number } => typeof p.v === 'number' && Number.isFinite(p.v));
    if (!pts.length) return null;
    const avg = pts.reduce((s, p) => s + p.v, 0) / pts.length;
    const max = pts.reduce((a, b) => (b.v > a.v ? b : a)); const min = pts.reduce((a, b) => (b.v < a.v ? b : a));
    return { avg, max, min };
  }, [data, main.key]);
  const v = cur[main.key] as number | null; const p = prev[main.key] as number | null;
  const delta = v !== null && p !== null && p !== 0 ? (v - p) / Math.abs(p) : null;
  const good = delta === null ? null : main.higherIsBetter === false ? delta <= 0 : delta >= 0;
  const best = main.higherIsBetter === false ? stats?.min : stats?.max;
  const worst = main.higherIsBetter === false ? stats?.max : stats?.min;
  const series: SeriesDef[] = [
    { key: main.key, label: main.label, type: 'line', fmt: main.fmt, color: BLUE },
    ...(other ? [{ key: other.key, label: other.label, type: 'line' as const, fmt: other.fmt, axis: 'right' as const, color: ROSE }] : []),
  ];
  const shadeEst = est && series.some((s) => MONEY_KEYS.has(s.key));

  return (
    <div className="rounded-xl border border-slate-200/80 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <KpiSelect value={main.key} onChange={onFocus} className="text-base font-semibold text-[#0E3687]" />
            <span className="text-xs text-slate-400">vs</span>
            <KpiSelect value={compare} onChange={onCompare} allowNone className="text-sm text-slate-600" />
          </div>
          <div className="mt-1 flex flex-wrap items-baseline gap-3">
            <span className="text-3xl font-bold tracking-tight text-[#0E3687]">{fmt(v, main.fmt)}</span>
            {delta !== null && (
              <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold', good ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700')}>
                {delta >= 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                {delta >= 0 ? '+' : ''}{(delta * 100).toFixed(1)}% vs periodo previo ({fmt(p, main.fmt)})
              </span>
            )}
          </div>
        </div>
        {stats && (
          <div className="grid grid-cols-3 gap-2 text-xs">
            <Stat label={`Promedio por ${GRAIN_SHORT[grain]}`} value={fmt(stats.avg, main.fmt)} />
            <Stat label="Mejor" value={fmt(best!.v, main.fmt)} sub={best!.label} tone="good" />
            <Stat label="Peor" value={fmt(worst!.v, main.fmt)} sub={worst!.label} tone="bad" />
          </div>
        )}
      </div>
      <div className="mt-4">
        <ResponsiveContainer width="100%" height={300}>
          <ComposedChart data={data} margin={{ top: 8, right: other ? 4 : 12, left: 0, bottom: 0 }} syncId={SYNC} syncMethod="value">
            <defs>
              <linearGradient id={`h${uid}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={BLUE} stopOpacity={0.28} />
                <stop offset="100%" stopColor={BLUE} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke="#EEF2F7" />
            <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: '#E2E8F0' }} interval="preserveStartEnd" minTickGap={32} />
            <YAxis yAxisId="left" tick={AXIS_TICK} tickLine={false} axisLine={false} tickFormatter={tickFmt(main.fmt)} width={56} />
            {other && <YAxis yAxisId="right" orientation="right" tick={AXIS_TICK} tickLine={false} axisLine={false} tickFormatter={tickFmt(other.fmt)} width={52} />}
            <Tooltip content={(tp) => <ChartTooltip {...(tp as TooltipLike)} series={series} def={def} />} cursor={{ stroke: '#0086D8', strokeOpacity: 0.3 }} />
            {shadeEst && <ReferenceArea yAxisId="left" x1={est!.x1} x2={est!.x2} fill="#F59E0B" fillOpacity={0.08} stroke="#F59E0B" strokeOpacity={0.25} strokeDasharray="3 3" label={{ value: '≈ incluye estimado', position: 'insideTopRight', fontSize: 10, fill: '#B45309' }} />}
            {stats && <ReferenceLine yAxisId="left" y={stats.avg} stroke={NAVY} strokeOpacity={0.35} strokeDasharray="4 4" label={{ value: 'promedio', position: 'insideBottomLeft', fontSize: 10, fill: '#64748B' }} />}
            <Area yAxisId="left" type="monotone" dataKey={main.key} stroke={BLUE} strokeWidth={2.5} fill={`url(#h${uid})`} dot={false} activeDot={{ r: 5, strokeWidth: 2, stroke: '#fff' }} connectNulls animationDuration={500} />
            {other && <Line yAxisId="right" type="monotone" dataKey={other.key} stroke={ROSE} strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: '#fff' }} connectNulls animationDuration={500} />}
            {data.length > 20 && <Brush dataKey="label" height={22} stroke="#8EC5EC" travellerWidth={8} fill="#F8FAFC" tickFormatter={() => ''} />}
          </ComposedChart>
        </ResponsiveContainer>
        <p className="mt-1 text-[11px] text-muted-foreground">
          Da clic en cualquier tarjeta de arriba para verla aquí, o elige el KPI en el menú.{data.length > 20 ? ' Arrastra los extremos de la barra de abajo para hacer zoom.' : ''} El total recalcula el KPI sobre el periodo completo (como el Looker).
        </p>
      </div>
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'good' | 'bad' }) {
  return (
    <div className={cn('rounded-lg border px-3 py-2 min-w-[108px]', tone === 'good' ? 'border-emerald-100 bg-emerald-50/50' : tone === 'bad' ? 'border-rose-100 bg-rose-50/50' : 'border-slate-100 bg-slate-50/60')}>
      <p className="text-[10px] uppercase tracking-wider text-slate-500">{label}</p>
      <p className="font-semibold tabular-nums text-slate-900">{value}</p>
      {sub && <p className="text-[10px] text-slate-500 truncate">{sub}</p>}
    </div>
  );
}

function KpiSelect({ value, onChange, allowNone, className }: { value: string; onChange: (k: string) => void; allowNone?: boolean; className?: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}
      className={cn('cursor-pointer rounded-md border border-transparent bg-transparent py-0.5 pr-1 hover:border-slate-200 hover:bg-slate-50 focus:border-[#0086D8]/50 focus:outline-none', className)}>
      {allowNone && <option value="">comparar con…</option>}
      {KPI_GROUPS.map((g) => (
        <optgroup key={g.group} label={g.group}>
          {g.items.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
        </optgroup>
      ))}
    </select>
  );
}
