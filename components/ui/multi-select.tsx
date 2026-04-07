'use client';

import { useState, useRef, useEffect, useMemo } from 'react';
import { Check, ChevronDown, X, Search } from 'lucide-react';

export interface MultiSelectOption {
  value: string;
  label: string;
  hint?: string; // optional secondary text (e.g. volume, flag)
}

interface MultiSelectProps {
  options: MultiSelectOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  label?: string;
  allLabel?: string;
  maxWidth?: string;
  disabled?: boolean;
}

/**
 * Multi-select dropdown with search.
 * - Shows "Todos" when nothing is selected.
 * - Shows count ("3 seleccionados") when >1 is selected.
 * - Shows the single value when exactly 1 is selected.
 * - Closes on outside click.
 */
export function MultiSelect({
  options,
  selected,
  onChange,
  placeholder = 'Todos',
  label,
  allLabel = 'Todos',
  maxWidth = '320px',
  disabled = false,
}: MultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) {
      document.addEventListener('mousedown', onClick);
      return () => document.removeEventListener('mousedown', onClick);
    }
  }, [open]);

  const filtered = useMemo(() => {
    if (!query) return options;
    const q = query.toLowerCase();
    return options.filter(
      (o) => o.value.toLowerCase().includes(q) || o.label.toLowerCase().includes(q)
    );
  }, [options, query]);

  function toggle(value: string) {
    if (selected.includes(value)) {
      onChange(selected.filter((v) => v !== value));
    } else {
      onChange([...selected, value]);
    }
  }

  function selectAll() {
    onChange(filtered.map((o) => o.value));
  }

  function clearAll() {
    onChange([]);
  }

  const displayText = (() => {
    if (selected.length === 0) return allLabel;
    if (selected.length === 1) {
      const found = options.find((o) => o.value === selected[0]);
      return found ? `${found.hint ? found.hint + ' ' : ''}${found.label}` : selected[0];
    }
    return `${selected.length} seleccionados`;
  })();

  return (
    <div className="inline-flex items-center gap-2" ref={ref}>
      {label && (
        <span className="text-xs uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
      )}
      <div className="relative">
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen((o) => !o)}
          className={`flex items-center gap-2 rounded-md border border-border bg-white px-3 py-1.5 text-sm font-medium transition-colors ${
            disabled
              ? 'cursor-not-allowed opacity-50'
              : 'hover:bg-[#F0F4FF] hover:border-[#0086D8]/40'
          } ${selected.length > 0 ? 'text-[#0E3687] border-[#0086D8]/60' : 'text-muted-foreground'}`}
          style={{ minWidth: '180px', maxWidth }}
        >
          <span className="truncate flex-1 text-left">{displayText || placeholder}</span>
          {selected.length > 0 && (
            <X
              className="h-3.5 w-3.5 flex-shrink-0 hover:text-red-600"
              onClick={(e) => {
                e.stopPropagation();
                clearAll();
              }}
            />
          )}
          <ChevronDown className={`h-4 w-4 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>

        {open && (
          <div
            className="absolute z-50 mt-1 rounded-md border border-border bg-white shadow-xl"
            style={{ minWidth: '260px', maxWidth: '360px' }}
          >
            {/* Search */}
            <div className="border-b border-border/60 p-2">
              <div className="flex items-center gap-2 rounded border border-border px-2 py-1">
                <Search className="h-3.5 w-3.5 text-muted-foreground" />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Buscar…"
                  className="flex-1 bg-transparent text-sm outline-none"
                  autoFocus
                />
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center justify-between border-b border-border/60 px-2 py-1.5 text-xs">
              <button
                onClick={selectAll}
                className="rounded px-2 py-0.5 text-[#0086D8] hover:bg-[#F0F4FF]"
              >
                Seleccionar todos
              </button>
              <button
                onClick={clearAll}
                className="rounded px-2 py-0.5 text-muted-foreground hover:bg-gray-50"
              >
                Limpiar
              </button>
            </div>

            {/* Options */}
            <div className="max-h-[280px] overflow-y-auto py-1">
              {filtered.length === 0 && (
                <div className="py-4 text-center text-xs text-muted-foreground">
                  Sin resultados
                </div>
              )}
              {filtered.map((opt) => {
                const active = selected.includes(opt.value);
                return (
                  <button
                    key={opt.value}
                    onClick={() => toggle(opt.value)}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[#F0F4FF] ${
                      active ? 'bg-[#0086D8]/5' : ''
                    }`}
                  >
                    <div
                      className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border ${
                        active
                          ? 'border-[#0086D8] bg-[#0086D8]'
                          : 'border-gray-300 bg-white'
                      }`}
                    >
                      {active && <Check className="h-3 w-3 text-white" />}
                    </div>
                    {opt.hint && <span className="text-xs">{opt.hint}</span>}
                    <span className="flex-1 truncate text-[#0E3687]">{opt.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
