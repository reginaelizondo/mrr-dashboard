'use client';

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
import { SOURCE_COLORS } from '@/lib/constants';
import { ChartExportButton } from '@/components/charts/ChartExportButton';
import type { MrrDailySnapshot } from '@/types';

interface ActiveSubsBySourceChartProps {
  data: MrrDailySnapshot[];
}

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
          <span className="font-semibold text-[#0E3687]">{entry.value.toLocaleString()}</span>
        </div>
      ))}
      <div className="mt-1.5 pt-1.5 border-t border-border/30 text-sm font-semibold text-[#0E3687]">
        Total: {total.toLocaleString()}
      </div>
    </div>
  );
}

export function ActiveSubsBySourceChart({ data }: ActiveSubsBySourceChartProps) {
  // Estimate active subs by source using revenue proportion
  // Total subs = new_subscriptions + renewals
  // Source share = mrr_{source}_gross / mrr_gross
  const chartData = data.map((s) => {
    const totalSubs = Number(s.new_subscriptions) + Number(s.renewals);
    const grossTotal = Number(s.mrr_gross) || 1; // avoid division by zero
    const appleShare = Number(s.mrr_apple_gross) / grossTotal;
    const googleShare = Number(s.mrr_google_gross) / grossTotal;
    const stripeShare = Number(s.mrr_stripe_gross) / grossTotal;

    return {
      date: s.snapshot_date,
      'App Store (iOS)': Math.round(totalSubs * appleShare),
      'Google Play': Math.round(totalSubs * googleShare),
      'Web (Stripe)': Math.round(totalSubs * stripeShare),
    };
  });

  const exportData = chartData.map((d) => ({
    Period: d.date,
    ...d,
    date: undefined,
  }));

  return (
    <Card className="overflow-hidden">
      <div className="h-1 bg-gradient-to-r from-[#0086D8] via-[#45C94E] to-[#0E3687]" />
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold text-[#0E3687]">Active Subscriptions by Source</CardTitle>
          <ChartExportButton data={exportData} filename="active-subs-by-source" />
        </div>
      </CardHeader>
      <CardContent>
        <div className="h-[300px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
              <CartesianGrid stroke="#E2E8F0" strokeOpacity={0.6} strokeDasharray="3 3" />
              <XAxis
                dataKey="date"
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
                tickFormatter={(val) => val.toLocaleString()}
              />
              <Tooltip content={<CustomTooltip />} />
              <Legend />
              <Bar
                dataKey="App Store (iOS)"
                stackId="source"
                fill={SOURCE_COLORS.apple}
              />
              <Bar
                dataKey="Google Play"
                stackId="source"
                fill={SOURCE_COLORS.google}
              />
              <Bar
                dataKey="Web (Stripe)"
                stackId="source"
                fill={SOURCE_COLORS.stripe}
                radius={[4, 4, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
