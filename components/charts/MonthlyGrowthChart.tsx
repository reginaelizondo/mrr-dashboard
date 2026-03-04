'use client';

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
  ReferenceLine,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ChartExportButton } from '@/components/charts/ChartExportButton';
import type { MrrDailySnapshot } from '@/types';

interface MonthlyGrowthChartProps {
  data: MrrDailySnapshot[];
}

interface GrowthData {
  month: string;
  growthPct: number;
}

function computeGrowth(data: MrrDailySnapshot[]): GrowthData[] {
  const result: GrowthData[] = [];
  for (let i = 1; i < data.length; i++) {
    const prev = Number(data[i - 1].mrr_net);
    const curr = Number(data[i].mrr_net);
    const growthPct = prev > 0 ? ((curr - prev) / prev) * 100 : 0;

    const d = new Date(data[i].snapshot_date + 'T00:00:00Z');
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const monthLabel = `${months[d.getUTCMonth()]} ${d.getUTCFullYear().toString().slice(2)}`;

    result.push({ month: monthLabel, growthPct: Number(growthPct.toFixed(1)) });
  }
  return result;
}

function CustomTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ value: number }>; label?: string }) {
  if (!active || !payload || !payload.length) return null;
  const val = payload[0].value;
  return (
    <div className="rounded-xl border border-border/50 bg-white p-3 shadow-xl min-w-[160px]">
      <p className="text-xs font-medium text-muted-foreground mb-1">{label}</p>
      <p className={`text-lg font-bold ${val >= 0 ? 'text-[#45C94E]' : 'text-[#E53E3E]'}`}>
        {val >= 0 ? '+' : ''}{val}%
      </p>
      <p className="text-xs text-muted-foreground">MRR Net growth MoM</p>
    </div>
  );
}

export function MonthlyGrowthChart({ data }: MonthlyGrowthChartProps) {
  const chartData = computeGrowth(data);

  // Show max last 6 months for cleaner view
  const displayData = chartData.slice(-6);

  const exportData = chartData.map((d) => ({
    Month: d.month,
    'Growth Rate (%)': d.growthPct,
  }));

  return (
    <Card className="overflow-hidden">
      <div className="h-1 bg-gradient-to-r from-[#0086D8] to-[#45C94E]" />
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold text-[#0E3687]">Monthly Growth Rate</CardTitle>
          <ChartExportButton data={exportData} filename="monthly-growth-rate" />
        </div>
        <p className="text-xs text-muted-foreground">MRR Net month-over-month growth %</p>
      </CardHeader>
      <CardContent>
        <div className="h-[250px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={displayData}
              layout="vertical"
              margin={{ top: 5, right: 40, left: 10, bottom: 5 }}
            >
              <CartesianGrid stroke="#E2E8F0" strokeOpacity={0.6} horizontal={false} />
              <XAxis
                type="number"
                tick={{ fontSize: 11, fill: '#64748B' }}
                stroke="#94A3B8"
                tickFormatter={(val) => `${val}%`}
              />
              <YAxis
                type="category"
                dataKey="month"
                tick={{ fontSize: 12, fill: '#64748B' }}
                stroke="#94A3B8"
                width={55}
              />
              <Tooltip content={<CustomTooltip />} />
              <ReferenceLine x={0} stroke="#94A3B8" strokeDasharray="3 3" />
              <Bar dataKey="growthPct" radius={[0, 4, 4, 0]} barSize={20}>
                {displayData.map((entry, i) => (
                  <Cell
                    key={i}
                    fill={entry.growthPct >= 0 ? '#0086D8' : '#E53E3E'}
                    fillOpacity={0.85}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
