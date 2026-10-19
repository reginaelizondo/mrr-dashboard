'use client';

import { useState } from 'react';
import { CalendarDays, X, RotateCcw, Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import { MultiSelect } from '@/components/ui/multi-select';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import type { Definition, Grain, ReplicaStatus } from '@/lib/kpi/replica';
import type { Preset } from '@/app/(dashboard)/dashboard/operativo/page';

const PRESET_LABELS: Record<Exclude<Preset, 'custom'>, string> = {
  yesterday: 'Ayer', '7d': '7 días', wtd: 'Esta semana', mtd: 'Este mes', '30d': '30 días', '90d': '90 días',
  ytd: 'YTD', '12m': '12 meses', all: 'Todo',
};
const GRAINS: { g: Grain; label: string }[] = [{ g: 'day', label: 'Día' }, { g: 'week', label: 'Semana' }, { g: 'month', label: 'Mes' }, { g: 'quarter', label: 'Trim.' }, { g: 'year', label: 'Año' }];

export type DimKey = 'kinedu_region' | 'country' | 'os' | 'kinedu_language';
export const DIMS: { key: DimKey; label: string; param: string; filter: 'region' | 'country' | 'os' | 'language' }[] = [
  { key: 'kinedu_region', label: 'Región', param: 'region', filter: 'region' },
  { key: 'country', label: 'País', param: 'country', filter: 'country' },
  { key: 'os', label: 'OS', param: 'os', filter: 'os' },
  { key: 'kinedu_language', label: 'Idioma', param: 'lang', filter: 'language' },
];

const shortDate = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: '2-digit', timeZone: 'UTC' });

function Segmented<T extends string>({ items, value, onChange, title }: { items: { v: T; label: string; title?: string }[]; value: T | null; onChange: (v: T) => void; title?: string }) {
  return (
    <div className="inline-flex rounded-lg bg-slate-100 p-0.5" title={title}>
      {items.map((it) => (
        <button key={it.v} type="button" onClick={() => onChange(it.v)} title={it.title}
          className={cn('whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition-all',
            value === it.v ? 'bg-white text-[#0E3687] shadow-sm' : 'text-slate-500 hover:text-[#0E3687]')}>
          {it.label}
        </button>
      ))}
    </div>
  );
}

export function FilterBar({ preset, start, end, grain, days, priorStart, priorEnd, filters, dimOptions, def, setDef, setParams, pending, status }: {
  preset: Preset; start: string; end: string; grain: Grain; days: number; priorStart: string; priorEnd: string;
  filters: Record<'region' | 'country' | 'os' | 'language', string[]>;
  dimOptions: Record<DimKey, { value: string; label: string; hint?: string }[]>;
  def: Definition; setDef: (d: Definition) => void; setParams: (patch: Record<string, string | null>) => void; pending: boolean; status: ReplicaStatus;
}) {
  const [cs, setCs] = useState(start); const [ce, setCe] = useState(end); const [open, setOpen] = useState(false);
  const chips = DIMS.flatMap((d) => filters[d.filter].map((v) => ({ d, v })));
  const removeChip = (d: (typeof DIMS)[number], v: string) => setParams({ [d.param]: filters[d.filter].filter((x) => x !== v).join(',') || null });
  const synced = status.lastSyncedAt ? new Date(status.lastSyncedAt).toLocaleString('es-MX', { timeZone: 'America/Mexico_City', dateStyle: 'short', timeStyle: 'short' }) : '—';

  return (
    <div className="z-30 -mx-6 bg-[#F2F2F4]/90 px-6 py-3 backdrop-blur-md md:sticky md:top-0">
      <div className="relative overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-sm">
        {pending && <div className="absolute inset-x-0 top-0 h-0.5 overflow-hidden bg-[#0086D8]/10"><div className="op-progress h-full w-1/3 bg-[#0086D8]" /></div>}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-3">
          <CalendarDays className="h-4 w-4 text-[#0086D8]" />
          <div className="max-w-full overflow-x-auto">
            <Segmented items={(Object.keys(PRESET_LABELS) as Exclude<Preset, 'custom'>[]).map((p) => ({ v: p, label: PRESET_LABELS[p] }))}
              value={preset === 'custom' ? null : (preset as Exclude<Preset, 'custom'>)} onChange={(p) => setParams({ preset: p, start: null, end: null, grain: null })} />
          </div>
          <Popover open={open} onOpenChange={(o) => { setOpen(o); if (o) { setCs(start); setCe(end); } }}>
            <PopoverTrigger asChild>
              <button type="button" className={cn('inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors',
                preset === 'custom' ? 'border-[#0E3687] bg-[#0E3687] text-white' : 'border-slate-200 text-slate-600 hover:border-[#0086D8]/50 hover:text-[#0E3687]')}>
                {shortDate(start)} → {shortDate(end)}
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-auto space-y-3 bg-white">
              <p className="text-xs font-semibold text-[#0E3687]">Rango personalizado</p>
              <div className="flex items-center gap-2">
                <input type="date" value={cs} min="2024-01-01" max={ce} onChange={(e) => setCs(e.target.value)} className="rounded-md border border-slate-200 px-2 py-1 text-xs" />
                <span className="text-xs text-slate-400">→</span>
                <input type="date" value={ce} min={cs} onChange={(e) => setCe(e.target.value)} className="rounded-md border border-slate-200 px-2 py-1 text-xs" />
              </div>
              <button type="button" disabled={!cs || !ce || cs > ce} onClick={() => { setOpen(false); setParams({ preset: 'custom', start: cs, end: ce }); }}
                className="w-full rounded-md bg-[#0E3687] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#0A2A6B] disabled:opacity-40">Aplicar</button>
            </PopoverContent>
          </Popover>
          <span className="hidden h-5 w-px bg-slate-200 md:block" />
          <Segmented items={GRAINS.map((x) => ({ v: x.g, label: x.label }))} value={grain} onChange={(g) => setParams({ grain: g })} title="Granularidad" />
          <div className="ml-auto flex items-center gap-2">
            <span className="text-[11px] uppercase tracking-wider text-slate-400">Vista</span>
            <Segmented<Definition> value={def} onChange={setDef} items={[
              { v: 'looker', label: 'Looker (hoy)', title: 'Exactamente como el Looker lo calcula hoy, con sus inconsistencias' },
              { v: 'fixed', label: 'Corregido', title: 'Con todas las correcciones documentadas; montos calibrados con lo que reportan las tiendas' },
            ]} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
          {DIMS.map((d) => (
            <MultiSelect key={d.key} label={d.label} options={dimOptions[d.key]} selected={filters[d.filter]} allLabel="Todos" maxWidth="220px"
              onChange={(next) => setParams({ [d.param]: next.join(',') || null })} />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 border-t border-slate-100 bg-slate-50/60 px-4 py-2 text-[11px] text-slate-500">
          {chips.map(({ d, v }) => (
            <span key={d.key + v} className="inline-flex items-center gap-1 rounded-full border border-[#0086D8]/30 bg-[#F0F7FF] py-0.5 pl-2 pr-1 text-[#0E3687]">
              <span className="text-slate-500">{d.label}:</span> {v}
              <button type="button" onClick={() => removeChip(d, v)} className="rounded-full p-0.5 hover:bg-[#0086D8]/15" aria-label={`Quitar ${v}`}><X className="h-3 w-3" /></button>
            </span>
          ))}
          {chips.length > 1 && (
            <button type="button" onClick={() => setParams({ region: null, country: null, os: null, lang: null })} className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-slate-500 hover:bg-slate-100 hover:text-[#0E3687]">
              <RotateCcw className="h-3 w-3" />Limpiar filtros
            </button>
          )}
          <span className={cn('inline-flex items-center gap-1', chips.length && 'ml-auto')}>
            <Info className="h-3 w-3" />
            {days} días · comparado con {shortDate(priorStart)} → {shortDate(priorEnd)} · datos al {status.maxDate ? shortDate(status.maxDate) : '—'} (sync {synced})
            {pending && <span className="ml-1 font-medium text-[#0086D8]">· actualizando…</span>}
          </span>
        </div>
      </div>
    </div>
  );
}
