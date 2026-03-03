'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { ChevronLeft, ChevronRight, Calendar } from 'lucide-react';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

interface MonthPickerProps {
  label: string;
  /** Selected value as "YYYY-MM" (e.g. "2026-01") */
  value: string;
  onChange: (value: string) => void;
  /** Min selectable month as "YYYY-MM" */
  min?: string;
  /** Max selectable month as "YYYY-MM" */
  max?: string;
}

function parseYearMonth(val: string): { year: number; month: number } {
  const [y, m] = val.split('-').map(Number);
  return { year: y, month: m };
}

function formatYearMonth(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

function formatDisplay(val: string): string {
  if (!val) return '';
  const { year, month } = parseYearMonth(val);
  return `${MONTHS[month - 1]} ${year}`;
}

export function MonthPicker({ label, value, onChange, min, max }: MonthPickerProps) {
  const current = value ? parseYearMonth(value) : { year: new Date().getFullYear(), month: new Date().getMonth() + 1 };
  const [viewYear, setViewYear] = useState(current.year);
  const [open, setOpen] = useState(false);

  const minParsed = min ? parseYearMonth(min) : null;
  const maxParsed = max ? parseYearMonth(max) : null;

  function isDisabled(year: number, month: number): boolean {
    const ym = year * 100 + month;
    if (minParsed && ym < minParsed.year * 100 + minParsed.month) return true;
    if (maxParsed && ym > maxParsed.year * 100 + maxParsed.month) return true;
    return false;
  }

  function isSelected(year: number, month: number): boolean {
    return current.year === year && current.month === month;
  }

  function handleSelect(month: number) {
    onChange(formatYearMonth(viewYear, month));
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            'h-8 text-xs gap-1.5 min-w-[120px] justify-start font-normal',
            !value && 'text-muted-foreground'
          )}
        >
          <Calendar className="h-3.5 w-3.5 opacity-50" />
          {value ? formatDisplay(value) : label}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[240px] p-3" align="start">
        {/* Year navigation */}
        <div className="flex items-center justify-between mb-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={() => setViewYear((y) => y - 1)}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm font-medium">{viewYear}</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={() => setViewYear((y) => y + 1)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>

        {/* Month grid 4x3 */}
        <div className="grid grid-cols-4 gap-1">
          {MONTHS.map((name, i) => {
            const monthNum = i + 1;
            const disabled = isDisabled(viewYear, monthNum);
            const selected = isSelected(viewYear, monthNum);

            return (
              <Button
                key={name}
                variant={selected ? 'default' : 'ghost'}
                size="sm"
                disabled={disabled}
                onClick={() => handleSelect(monthNum)}
                className={cn(
                  'h-8 text-xs',
                  selected && 'bg-primary text-primary-foreground',
                  disabled && 'opacity-30'
                )}
              >
                {name}
              </Button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
