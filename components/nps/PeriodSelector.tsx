'use client';

import { NpsFilters, PeriodKey } from '@/lib/nps/types';
import { cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { SlidersHorizontal, X } from 'lucide-react';

interface PeriodSelectorProps {
  filters: NpsFilters;
  onChange: (filters: NpsFilters) => void;
  planTypes: string[];
  locales: string[];
  categories: string[];
  osValues: string[];
}

const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: '90d', label: 'Last 90 days' },
  { key: 'all', label: 'All time' },
];

export default function PeriodSelector({
  filters,
  onChange,
  planTypes,
  locales,
  categories,
  osValues,
}: PeriodSelectorProps) {
  const activeSecondary = [filters.planType, filters.locale, filters.category, filters.os].filter(Boolean).length;

  const updateSecondary = (key: keyof NpsFilters, value: string) => {
    onChange({ ...filters, [key]: value });
  };

  const clearSecondary = () => {
    onChange({ ...filters, planType: '', locale: '', category: '', os: '' });
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Period pills */}
      <div className="inline-flex bg-white border border-border rounded-lg p-1 shadow-sm">
        {PERIODS.map((p) => (
          <button
            key={p.key}
            onClick={() => onChange({ ...filters, period: p.key })}
            className={cn(
              'px-3 py-1.5 text-sm font-medium rounded-md transition-colors',
              filters.period === p.key
                ? 'bg-[#0E3687] text-white shadow-sm'
                : 'text-muted-foreground hover:text-[#0E3687] hover:bg-muted',
            )}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Secondary filters dropdown */}
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="h-auto py-2">
            <SlidersHorizontal className="h-3.5 w-3.5 mr-1.5" />
            Filters
            {activeSecondary > 0 && (
              <span className="ml-1.5 inline-flex items-center justify-center h-5 min-w-[20px] px-1.5 rounded-full bg-[#0086D8] text-white text-[10px] font-bold">
                {activeSecondary}
              </span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80" align="start">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-sm font-semibold text-[#0E3687]">Additional filters</h4>
            {activeSecondary > 0 && (
              <button
                onClick={clearSecondary}
                className="text-xs text-muted-foreground hover:text-[#0E3687] flex items-center gap-1"
              >
                <X className="h-3 w-3" />
                Clear
              </button>
            )}
          </div>

          <div className="space-y-3">
            <FilterField label="Plan" value={filters.planType} options={planTypes} onChange={(v) => updateSecondary('planType', v)} format="capitalize" />
            <FilterField label="Locale" value={filters.locale} options={locales} onChange={(v) => updateSecondary('locale', v)} format="upper" />
            <FilterField label="Category" value={filters.category} options={categories} onChange={(v) => updateSecondary('category', v)} />
            <FilterField label="OS" value={filters.os} options={osValues} onChange={(v) => updateSecondary('os', v)} />
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function FilterField({
  label,
  value,
  options,
  onChange,
  format,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
  format?: 'capitalize' | 'upper';
}) {
  const fmt = (s: string) => {
    if (format === 'capitalize') return s.charAt(0).toUpperCase() + s.slice(1);
    if (format === 'upper') return s.toUpperCase();
    return s;
  };

  return (
    <div>
      <label className="block text-xs text-muted-foreground mb-1 font-medium">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full border border-border rounded-md px-2.5 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#0086D8] focus:border-transparent"
      >
        <option value="">All</option>
        {options.map((o) => (
          <option key={o} value={o}>{fmt(o)}</option>
        ))}
      </select>
    </div>
  );
}
