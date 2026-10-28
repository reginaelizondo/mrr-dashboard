'use client';

import { useMemo, useState, useTransition } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { CalendarDays, Info, RotateCcw, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { MultiSelect } from '@/components/ui/multi-select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { REGION_LABELS, SOURCE_LABELS } from '@/lib/constants';
import {
  SKU_GRAINS,
  SKU_PRESETS,
  countryLabel,
  fmtPeriod,
  type SkuDims,
  type SkuFilters,
  type SkuGrain,
  type SkuPreset,
} from '@/lib/sku-filters';

function Segmented<T extends string>({ items, value, onChange, title }: { items: { v: T; label: string }[]; value: T | null; onChange: (v: T) => void; title?: string }) {
  return (
    <div className="inline-flex rounded-lg bg-slate-100 p-0.5" title={title}>
      {items.map((it) => (
        <button key={it.v} type="button" onClick={() => onChange(it.v)}
          className={cn('whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition-all',
            value === it.v ? 'bg-white text-[#0E3687] shadow-sm' : 'text-slate-500 hover:text-[#0E3687]')}>
          {it.label}
        </button>
      ))}
    </div>
  );
}

const DIMS: { key: keyof SkuFilters; label: string }[] = [
  { key: 'sources', label: 'Store' },
  { key: 'regions', label: 'Region' },
  { key: 'countries', label: 'Country' },
];

/**
 * Filter bar for the SKU Breakdown tab (modeled on the Operativo one): month
 * presets + custom month range, period grain, and store / region / country
 * multi-selects. Everything lives in the URL; changes re-render the page on
 * the server inside a transition so the tab stays usable meanwhile.
 */
export function SkuFilterBar({ preset, start, end, grain, filters, dims, monthCount }: {
  preset: SkuPreset; start: string; end: string; grain: SkuGrain; filters: SkuFilters; dims: SkuDims | null; monthCount: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [cs, setCs] = useState(start);
  const [ce, setCe] = useState(end);

  function setParams(patch: Record<string, string | null>) {
    const next = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') next.delete(k);
      else next.set(k, v);
    }
    startTransition(() => router.push(`${pathname}?${next.toString()}`, { scroll: false }));
  }

  const options = useMemo(() => ({
    sources: (['apple', 'google', 'stripe'] as const).map((s) => ({ value: s, label: SOURCE_LABELS[s] })),
    regions: (dims?.regions.length ? dims.regions : Object.keys(REGION_LABELS).map((value) => ({ value, n: 0 })))
      .map((r) => ({ value: r.value, label: REGION_LABELS[r.value as keyof typeof REGION_LABELS] || r.value, hint: r.n ? r.n.toLocaleString() : undefined })),
    countries: (dims?.countries || []).map((c) => ({ value: c.value, label: `${countryLabel(c.value)} (${c.value})`, hint: c.n ? c.n.toLocaleString() : undefined })),
  }), [dims]);

  const labelOf = (key: keyof SkuFilters, v: string) => options[key].find((o) => o.value === v)?.label || v;
  const chips = DIMS.flatMap((d) => filters[d.key].map((v) => ({ d, v })));
  const removeChip = (key: keyof SkuFilters, v: string) => setParams({ [key]: filters[key].filter((x) => x !== v).join(',') || null });

  const rangeLabel = `${fmtPeriod(`${start}-01`)} → ${fmtPeriod(`${end}-01`)}`;

  return (
    <div className="z-30 -mx-6 bg-[#F2F2F4]/90 px-6 py-3 backdrop-blur-md md:sticky md:top-0">
      {/* No overflow-hidden here: the MultiSelect dropdowns are absolute divs inside this card. */}
      <div className="relative rounded-xl border border-slate-200/80 bg-white shadow-sm">
        {pending && <div className="absolute inset-x-0 top-0 h-0.5 overflow-hidden rounded-t-xl bg-[#0086D8]/10"><div className="op-progress h-full w-1/3 bg-[#0086D8]" /></div>}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-3">
          <CalendarDays className="h-4 w-4 text-[#0086D8]" />
          <Segmented items={SKU_PRESETS} value={preset === 'custom' ? null : preset}
            onChange={(p) => setParams({ preset: p, start: null, end: null })} />
          <Popover open={open} onOpenChange={(o) => { setOpen(o); if (o) { setCs(start); setCe(end); } }}>
            <PopoverTrigger asChild>
              <button type="button" className={cn('inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors',
                preset === 'custom' ? 'border-[#0E3687] bg-[#0E3687] text-white' : 'border-slate-200 text-slate-600 hover:border-[#0086D8]/50 hover:text-[#0E3687]')}>
                {rangeLabel}
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-auto space-y-3 bg-white">
              <p className="text-xs font-semibold text-[#0E3687]">Custom month range</p>
              <div className="flex items-center gap-2">
                <input type="month" value={cs} min="2024-01" max={ce} onChange={(e) => setCs(e.target.value)} className="rounded-md border border-slate-200 px-2 py-1 text-xs" />
                <span className="text-xs text-slate-400">→</span>
                <input type="month" value={ce} min={cs} onChange={(e) => setCe(e.target.value)} className="rounded-md border border-slate-200 px-2 py-1 text-xs" />
              </div>
              <button type="button" disabled={!cs || !ce || cs > ce} onClick={() => { setOpen(false); setParams({ preset: 'custom', start: cs, end: ce }); }}
                className="w-full rounded-md bg-[#0E3687] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#0A2A6B] disabled:opacity-40">Apply</button>
            </PopoverContent>
          </Popover>
          <span className="hidden h-5 w-px bg-slate-200 md:block" />
          <Segmented items={SKU_GRAINS} value={grain} onChange={(g) => setParams({ grain: g === 'month' ? null : g })} title="Period grain" />
        </div>
        <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
          {DIMS.map((d) => (
            <MultiSelect key={d.key} label={d.label} options={options[d.key]} selected={filters[d.key]} allLabel="All" maxWidth="240px"
              disabled={d.key === 'countries' && options.countries.length === 0}
              onChange={(next) => setParams({ [d.key]: next.join(',') || null })} />
          ))}
          {!dims && <span className="text-[11px] text-slate-400">Country list needs migration 045.</span>}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 border-t border-slate-100 bg-slate-50/60 px-4 py-2 text-[11px] text-slate-500">
          {chips.map(({ d, v }) => (
            <span key={d.key + v} className="inline-flex items-center gap-1 rounded-full border border-[#0086D8]/30 bg-[#F0F7FF] py-0.5 pl-2 pr-1 text-[#0E3687]">
              <span className="text-slate-500">{d.label}:</span> {labelOf(d.key, v)}
              <button type="button" onClick={() => removeChip(d.key, v)} className="rounded-full p-0.5 hover:bg-[#0086D8]/15" aria-label={`Remove ${v}`}><X className="h-3 w-3" /></button>
            </span>
          ))}
          {chips.length > 1 && (
            <button type="button" onClick={() => setParams({ sources: null, regions: null, countries: null })} className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-slate-500 hover:bg-slate-100 hover:text-[#0E3687]">
              <RotateCcw className="h-3 w-3" />Clear filters
            </button>
          )}
          <span className={cn('inline-flex items-center gap-1', chips.length && 'ml-auto')}>
            <Info className="h-3 w-3" />
            {monthCount} months · {rangeLabel} · current month is partial
            {pending && <span className="ml-1 font-medium text-[#0086D8]">· updating…</span>}
          </span>
        </div>
      </div>
    </div>
  );
}
