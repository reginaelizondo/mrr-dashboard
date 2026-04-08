'use client';

import { useState } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCurrency, SOURCE_COLORS } from '@/lib/constants';
import { ChartExportButton } from '@/components/charts/ChartExportButton';
import { buildProjectionBundle } from '@/lib/mrr-projection';
import type { MrrDailySnapshot } from '@/types';

interface SourceBreakdownChartProps {
  data: MrrDailySnapshot[];
}

const sources = [
  { key: 'apple', dataKey: 'mrr_apple_gross', label: 'App Store (iOS)', color: SOURCE_COLORS.apple },
  { key: 'google', dataKey: 'mrr_google_gross', label: 'Google Play', color: SOURCE_COLORS.google },
  { key: 'stripe', dataKey: 'mrr_stripe_gross', label: 'Web (Stripe)', color: SOURCE_COLORS.stripe },
] as const;

function CustomTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string }>; label?: string }) {
  if (!active || !payload || !payload.length) return null;
  const total = payload.reduce((acc, entry) => acc + entry.value, 0);
  return (
    <div className="rounded-xl border border-border/50 bg-white p-3 shadow-xl">
      <p className="text-xs font-medium text-muted-foreground mb-2">
        {label ? new Date(String(label) + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }) : ''}
      </p>
      {payload.map((entry, i) => (
        <div key={i} className="flex items-center gap-2 text-sm">
          <span className="h-2.5 w-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: entry.color }} />
          <span className="text-muted-foreground">{entry.name}:</span>
          <span className="font-semibold text-[#0E3687]">{formatCurrency(entry.value)}</span>
        </div>
      ))}
      <div className="mt-1.5 pt-1.5 border-t border-border/30 text-sm font-semibold text-[#0E3687]">
        Total: {formatCurrency(total)}
      </div>
    </div>
  );
}

export function SourceBreakdownChart({ data }: SourceBreakdownChartProps) {
  const [activeSources, setActiveSources] = useState<Set<string>>(
    new Set(sources.map(s => s.key))
  );

  function toggleSource(key: string) {
    setActiveSources(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        if (next.size > 1) next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  const visibleSources = sources.filter(s => activeSources.has(s.key));

  // Enrich each row with projected extras for the currently-visible sources
  const bundle = buildProjectionBundle(data);
  const enrichedData = data.map((s) => {
    const row = bundle.rows.get(s.snapshot_date);
    const is_stale = row?.is_stale || false;
    // Sum projected extras only across visible sources so stacking matches
    let projectedExtra = 0;
    for (const src of visibleSources) {
      const f = row?.fields[src.dataKey];
      if (is_stale && f) projectedExtra += Math.max(0, f.projected - f.actual);
    }
    return {
      ...s,
      _projected_extra: Math.round(projectedExtra),
      _is_stale: is_stale,
    };
  });
  const hasProjections = enrichedData.some((r) => r._projected_extra > 0);

  const exportData = data.map((s) => {
    const row = bundle.rows.get(s.snapshot_date);
    return {
      Period: s.snapshot_date,
      'App Store (iOS)': Number(s.mrr_apple_gross),
      'App Store (iOS) projected': Math.round(row?.fields.mrr_apple_gross?.projected || Number(s.mrr_apple_gross)),
      'Google Play': Number(s.mrr_google_gross),
      'Google Play projected': Math.round(row?.fields.mrr_google_gross?.projected || Number(s.mrr_google_gross)),
      'Web (Stripe)': Number(s.mrr_stripe_gross),
      'Web (Stripe) projected': Math.round(row?.fields.mrr_stripe_gross?.projected || Number(s.mrr_stripe_gross)),
      Total: Number(s.mrr_gross),
      'Is Stale': row?.is_stale || false,
    };
  });

  return (
    <Card className="overflow-hidden">
      <div className="h-1 bg-gradient-to-r from-[#0086D8] via-[#45C94E] to-[#0E3687]" />
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold text-[#0E3687]">Revenue by Source</CardTitle>
          <ChartExportButton data={exportData} filename="revenue-by-source" />
        </div>
        {/* Source filter toggles */}
        <div className="flex gap-2 mt-2">
          {sources.map((s) => {
            const isActive = activeSources.has(s.key);
            return (
              <button
                key={s.key}
                onClick={() => toggleSource(s.key)}
                className={`
                  flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium
                  transition-all duration-200 border
                  ${isActive
                    ? 'border-transparent text-white shadow-sm'
                    : 'border-border/50 text-muted-foreground bg-white hover:bg-muted/50'
                  }
                `}
                style={isActive ? { backgroundColor: s.color } : undefined}
              >
                <span className="h-2 w-2 rounded-full" style={{
                  backgroundColor: isActive ? 'white' : s.color,
                  opacity: isActive ? 0.8 : 0.5,
                }} />
                {s.label}
              </button>
            );
          })}
        </div>
      </CardHeader>
      <CardContent>
        <div className="h-[300px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={enrichedData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
              <defs>
                <pattern id="source-hatch" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(45)">
                  <rect width="8" height="8" fill="#0086D8" fillOpacity="0.15" />
                  <line x1="0" y1="0" x2="0" y2="8" stroke="#0086D8" strokeWidth="1.5" strokeOpacity="0.6" />
                </pattern>
              </defs>
              <CartesianGrid stroke="#E2E8F0" strokeOpacity={0.6} strokeDasharray="3 3" />
              <XAxis
                dataKey="snapshot_date"
                tick={{ fontSize: 12, fill: '#64748B' }}
                stroke="#94A3B8"
                tickFormatter={(val) => {
                  const d = new Date(val + 'T00:00:00Z');
                  const months = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
                  return `${months[d.getUTCMonth()]} ${d.getUTCFullYear().toString().slice(2)}`;
                }}
              />
              <YAxis
                tick={{ fontSize: 12, fill: '#64748B' }}
                stroke="#94A3B8"
                tickFormatter={(val) => formatCurrency(val)}
              />
              <Tooltip content={<CustomTooltip />} />
              <Legend />
              {visibleSources.map((s) => (
                <Bar
                  key={s.key}
                  dataKey={s.dataKey}
                  name={s.label}
                  stackId="source"
                  fill={s.color}
                />
              ))}
              <Bar
                dataKey="_projected_extra"
                name="Proyectado (stale)"
                stackId="source"
                fill="url(#source-hatch)"
                stroke="#0086D8"
                strokeWidth={1.5}
                strokeDasharray="4 2"
                radius={[4, 4, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
        {hasProjections && (
          <p className="text-[10px] text-muted-foreground mt-2 leading-relaxed border-t border-border/40 pt-2">
            Área rayada = proyección de los meses stale, suma de los extras por fuente visible. Cada fuente se proyecta con su propia tasa MoM.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
