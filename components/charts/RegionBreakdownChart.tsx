'use client';

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCurrency, REGION_COLORS, REGION_LABELS } from '@/lib/constants';
import { ChartExportButton } from '@/components/charts/ChartExportButton';
import type { MrrDailySnapshot } from '@/types';

interface RegionBreakdownChartProps {
  data: MrrDailySnapshot[];
}

function CustomTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string }>; label?: string }) {
  if (!active || !payload || !payload.length) return null;
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
    </div>
  );
}

export function RegionBreakdownChart({ data }: RegionBreakdownChartProps) {
  const exportData = data.map((s) => ({
    Period: s.snapshot_date,
    'US & Canada': Number(s.mrr_us_canada),
    Mexico: Number(s.mrr_mexico),
    Brazil: Number(s.mrr_brazil),
    'Rest of World': Number(s.mrr_rest_of_world),
  }));

  return (
    <Card className="overflow-hidden">
      <div className="h-1 bg-gradient-to-r from-[#0086D8] via-[#45C94E] to-[#DA4D7A]" />
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold text-[#0E3687]">Revenue by Region</CardTitle>
          <ChartExportButton data={exportData} filename="revenue-by-region" />
        </div>
      </CardHeader>
      <CardContent>
        <div className="h-[300px]">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
              <defs>
                <linearGradient id="regionUsCanada" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={REGION_COLORS.us_canada} stopOpacity={0.8} />
                  <stop offset="95%" stopColor={REGION_COLORS.us_canada} stopOpacity={0.3} />
                </linearGradient>
                <linearGradient id="regionMexico" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={REGION_COLORS.mexico} stopOpacity={0.8} />
                  <stop offset="95%" stopColor={REGION_COLORS.mexico} stopOpacity={0.3} />
                </linearGradient>
                <linearGradient id="regionBrazil" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={REGION_COLORS.brazil} stopOpacity={0.8} />
                  <stop offset="95%" stopColor={REGION_COLORS.brazil} stopOpacity={0.3} />
                </linearGradient>
                <linearGradient id="regionRest" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={REGION_COLORS.rest_of_world} stopOpacity={0.8} />
                  <stop offset="95%" stopColor={REGION_COLORS.rest_of_world} stopOpacity={0.3} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#E2E8F0" strokeOpacity={0.6} strokeDasharray="3 3" />
              <XAxis
                dataKey="snapshot_date"
                tick={{ fontSize: 12, fill: '#64748B' }}
                stroke="#94A3B8"
                tickFormatter={(val) => {
                  const d = new Date(val + 'T00:00:00Z');
                  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
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
              <Area
                type="monotone"
                dataKey="mrr_us_canada"
                name={REGION_LABELS.us_canada}
                stackId="region"
                fill="url(#regionUsCanada)"
                stroke={REGION_COLORS.us_canada}
                strokeWidth={1.5}
              />
              <Area
                type="monotone"
                dataKey="mrr_mexico"
                name={REGION_LABELS.mexico}
                stackId="region"
                fill="url(#regionMexico)"
                stroke={REGION_COLORS.mexico}
                strokeWidth={1.5}
              />
              <Area
                type="monotone"
                dataKey="mrr_brazil"
                name={REGION_LABELS.brazil}
                stackId="region"
                fill="url(#regionBrazil)"
                stroke={REGION_COLORS.brazil}
                strokeWidth={1.5}
              />
              <Area
                type="monotone"
                dataKey="mrr_rest_of_world"
                name={REGION_LABELS.rest_of_world}
                stackId="region"
                fill="url(#regionRest)"
                stroke={REGION_COLORS.rest_of_world}
                strokeWidth={1.5}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
