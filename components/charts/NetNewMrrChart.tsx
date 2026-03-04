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
import { formatCurrency } from '@/lib/constants';
import type { MrrDailySnapshot } from '@/types';

interface NetNewMrrChartProps {
  data: MrrDailySnapshot[];
}

interface NetNewData {
  month: string;
  netNew: number;
}

function computeNetNew(data: MrrDailySnapshot[]): NetNewData[] {
  const result: NetNewData[] = [];
  for (let i = 1; i < data.length; i++) {
    const prev = Number(data[i - 1].mrr_net);
    const curr = Number(data[i].mrr_net);
    const netNew = curr - prev;

    const d = new Date(data[i].snapshot_date + 'T00:00:00Z');
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const monthLabel = `${months[d.getUTCMonth()]} ${d.getUTCFullYear().toString().slice(2)}`;

    result.push({ month: monthLabel, netNew: Math.round(netNew) });
  }
  return result;
}

function CustomTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ value: number }>; label?: string }) {
  if (!active || !payload || !payload.length) return null;
  const val = payload[0].value;
  return (
    <div className="rounded-xl border border-border/50 bg-white p-3 shadow-xl min-w-[180px]">
      <p className="text-xs font-medium text-muted-foreground mb-1">{label}</p>
      <p className={`text-lg font-bold ${val >= 0 ? 'text-[#45C94E]' : 'text-[#E53E3E]'}`}>
        {val >= 0 ? '+' : ''}{formatCurrency(val)}
      </p>
      <p className="text-xs text-muted-foreground">Net new MRR added</p>
    </div>
  );
}

export function NetNewMrrChart({ data }: NetNewMrrChartProps) {
  const chartData = computeNetNew(data);

  // Show last 6 months
  const displayData = chartData.slice(-6);

  const exportData = chartData.map((d) => ({
    Month: d.month,
    'Net New MRR ($)': d.netNew,
  }));

  return (
    <Card className="overflow-hidden">
      <div className="h-1 bg-gradient-to-r from-[#45C94E] to-[#0E3687]" />
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold text-[#0E3687]">Net New MRR by Month</CardTitle>
          <ChartExportButton data={exportData} filename="net-new-mrr" />
        </div>
        <p className="text-xs text-muted-foreground">Monthly change in Net MRR (current − previous month)</p>
      </CardHeader>
      <CardContent>
        <div className="h-[250px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={displayData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
              <CartesianGrid stroke="#E2E8F0" strokeOpacity={0.6} strokeDasharray="3 3" />
              <XAxis
                dataKey="month"
                tick={{ fontSize: 11, fill: '#64748B' }}
                stroke="#94A3B8"
              />
              <YAxis
                tick={{ fontSize: 12, fill: '#64748B' }}
                stroke="#94A3B8"
                tickFormatter={(val) => {
                  if (Math.abs(val) >= 1000) return `$${(val / 1000).toFixed(0)}k`;
                  return `$${val}`;
                }}
              />
              <Tooltip content={<CustomTooltip />} />
              <ReferenceLine y={0} stroke="#94A3B8" strokeDasharray="3 3" />
              <Bar dataKey="netNew" radius={[4, 4, 0, 0]} barSize={40}>
                {displayData.map((entry, i) => (
                  <Cell
                    key={i}
                    fill={entry.netNew >= 0 ? '#45C94E' : '#E53E3E'}
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
