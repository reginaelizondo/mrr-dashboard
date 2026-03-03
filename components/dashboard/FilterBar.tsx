'use client';

import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { SOURCE_LABELS, REGION_LABELS, PLAN_LABELS_SHORT } from '@/lib/constants';
import { getPresetDates } from '@/lib/filters';
import { MonthPicker } from '@/components/dashboard/MonthPicker';
import type { Source, Region, PlanType, DatePreset } from '@/types';
import { ChevronDown, X, CalendarDays } from 'lucide-react';

// ─── Constants ──────────────────────────────────────────────────

const DATE_PRESETS: { label: string; value: DatePreset }[] = [
  { label: 'This Month', value: 'this_month' },
  { label: 'Last Month', value: 'last_month' },
  { label: 'Last 3 Months', value: '3m' },
  { label: 'Last 6 Months', value: '6m' },
  { label: 'Last 12 Months', value: '12m' },
  { label: 'Year to Date', value: 'ytd' },
  { label: 'All Time', value: 'all' },
];

const ALL_SOURCES: Source[] = ['apple', 'google', 'stripe'];
const ALL_REGIONS: Region[] = ['us_canada', 'mexico', 'brazil', 'rest_of_world'];
const ALL_PLANS: PlanType[] = ['monthly', 'yearly', 'semesterly', 'quarterly', 'weekly', 'lifetime', 'other'];

// ─── Helpers ────────────────────────────────────────────────────

function parseMultiParam<T extends string>(value: string | null): T[] {
  if (!value) return [];
  return value.split(',').filter(Boolean) as T[];
}

/** Convert YYYY-MM-DD or YYYY-MM to "YYYY-MM" */
function toYearMonth(dateStr: string): string {
  if (!dateStr) return '';
  return dateStr.slice(0, 7);
}

/** Convert "YYYY-MM" to "YYYY-MM-01" */
function fromYearMonthStart(ym: string): string {
  return `${ym}-01`;
}

/** Convert "YYYY-MM" to the last day of that month */
function fromYearMonthEnd(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  return `${ym}-${String(lastDay).padStart(2, '0')}`;
}

function getPresetLabel(preset: string): string {
  const found = DATE_PRESETS.find((p) => p.value === preset);
  return found ? found.label : 'Last 12 Months';
}

// ─── Multi-Select Dropdown ──────────────────────────────────────

function MultiSelectDropdown<T extends string>({
  label,
  items,
  selected,
  onToggle,
  labelMap,
}: {
  label: string;
  items: T[];
  selected: T[];
  onToggle: (value: T) => void;
  labelMap: Record<string, string>;
}) {
  const count = selected.length;
  const displayLabel = count > 0 ? `${label} (${count})` : label;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            'h-8 text-xs gap-1',
            count > 0 && 'border-[#0086D8]/50 bg-[#0086D8]/5 text-[#0086D8]'
          )}
        >
          {displayLabel}
          <ChevronDown className="h-3 w-3 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          Filter by {label}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {items.map((item) => (
          <DropdownMenuCheckboxItem
            key={item}
            checked={selected.length === 0 || selected.includes(item)}
            onCheckedChange={() => onToggle(item)}
            className="text-xs"
          >
            {labelMap[item] || item}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ─── FilterBar ──────────────────────────────────────────────────

export function FilterBar() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Read current state from URL
  const preset = (searchParams.get('preset') as DatePreset | null) || '12m';
  const sources = parseMultiParam<Source>(searchParams.get('sources'));
  const regions = parseMultiParam<Region>(searchParams.get('regions'));
  const plans = parseMultiParam<PlanType>(searchParams.get('plans'));
  const startDate = searchParams.get('start') || '';
  const endDate = searchParams.get('end') || '';

  const isCustom = preset === 'custom';
  const hasActiveFilters = sources.length > 0 || regions.length > 0 || plans.length > 0;

  // Derive month picker values from start/end
  const fromMonth = startDate ? toYearMonth(startDate) : '';
  const toMonth = endDate ? toYearMonth(endDate) : '';

  // ─── URL updater ────────────────────────────────────────────

  function updateParams(updates: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === '') {
        params.delete(key);
      } else {
        params.set(key, value);
      }
    }
    router.push(`${pathname}?${params.toString()}`);
  }

  // ─── Date preset handler ───────────────────────────────────

  function handlePreset(p: DatePreset) {
    if (p === 'custom') {
      updateParams({ preset: 'custom' });
    } else {
      const { start, end } = getPresetDates(p);
      updateParams({ preset: p, start, end });
    }
  }

  // ─── Month picker handlers ─────────────────────────────────

  function handleFromMonth(ym: string) {
    updateParams({
      preset: 'custom',
      start: fromYearMonthStart(ym),
    });
  }

  function handleToMonth(ym: string) {
    updateParams({
      preset: 'custom',
      end: fromYearMonthEnd(ym),
    });
  }

  // ─── Multi-select toggle ───────────────────────────────────

  function toggleMultiParam(paramName: string, value: string, currentValues: string[]) {
    let newValues: string[];
    if (currentValues.includes(value)) {
      newValues = currentValues.filter((v) => v !== value);
    } else {
      newValues = [...currentValues, value];
    }
    updateParams({ [paramName]: newValues.length > 0 ? newValues.join(',') : null });
  }

  // ─── Clear all filters ────────────────────────────────────

  function clearFilters() {
    updateParams({ sources: null, regions: null, plans: null });
  }

  return (
    <div className="bg-white rounded-xl border border-border/50 px-4 py-3 shadow-sm flex items-center gap-2 flex-wrap">
      {/* Date Preset Dropdown */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className={cn(
              'h-8 text-xs gap-1.5',
              isCustom && 'border-primary/50 bg-primary/5 text-primary'
            )}
          >
            <CalendarDays className="h-3.5 w-3.5 opacity-60" />
            {isCustom ? 'Custom Range' : getPresetLabel(preset)}
            <ChevronDown className="h-3 w-3 opacity-50" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-44">
          {DATE_PRESETS.map((p) => (
            <DropdownMenuItem
              key={p.value}
              onClick={() => handlePreset(p.value)}
              className={cn(
                'text-xs',
                preset === p.value && 'bg-accent font-medium'
              )}
            >
              {p.label}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => handlePreset('custom')}
            className={cn('text-xs', isCustom && 'bg-accent font-medium')}
          >
            Custom Range...
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Month Pickers (From / To) */}
      <MonthPicker
        label="From"
        value={fromMonth}
        onChange={handleFromMonth}
        max={toMonth || undefined}
      />
      <span className="text-xs text-muted-foreground">–</span>
      <MonthPicker
        label="To"
        value={toMonth}
        onChange={handleToMonth}
        min={fromMonth || undefined}
      />

      {/* Vertical separator */}
      <div className="h-6 w-px bg-border mx-1" />

      {/* OS Filter */}
      <MultiSelectDropdown
        label="OS"
        items={ALL_SOURCES}
        selected={sources}
        onToggle={(v) => toggleMultiParam('sources', v, sources)}
        labelMap={SOURCE_LABELS}
      />

      {/* Country Filter */}
      <MultiSelectDropdown
        label="Country"
        items={ALL_REGIONS}
        selected={regions}
        onToggle={(v) => toggleMultiParam('regions', v, regions)}
        labelMap={REGION_LABELS as Record<string, string>}
      />

      {/* Plan Filter */}
      <MultiSelectDropdown
        label="Plan"
        items={ALL_PLANS}
        selected={plans}
        onToggle={(v) => toggleMultiParam('plans', v, plans)}
        labelMap={PLAN_LABELS_SHORT}
      />

      {/* Clear filters button */}
      {hasActiveFilters && (
        <Button
          variant="ghost"
          size="sm"
          onClick={clearFilters}
          className="h-8 text-xs gap-1 text-muted-foreground hover:text-destructive"
        >
          <X className="h-3 w-3" />
          Clear
        </Button>
      )}
    </div>
  );
}
