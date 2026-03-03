'use client';

import {
  ComposedChart,
  Bar,
  Line,
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
import type { MrrDailySnapshot } from '@/types';

interface CommissionsBreakdownChartProps {
  data: MrrDailySnapshot[];
}

function CustomTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string; dataKey?: string }>; label?: string }) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div className="rounded-xl border border-border/50 bg-white p-3 shadow-xl min-w-[220px]">
      <p className="text-xs font-medium text-muted-foreground mb-2">
        {label ? new Date(String(label) + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }) : ''}
      </p>
      {payload.map((entry, i) => (
        <div key={i} className="flex items-center gap-2 text-sm">
          <span className="h-2.5 w-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: entry.color }} />
          <span className="text-muted-foreground">{entry.name}:</span>
          <span className="font-semibold text-[#0E3687]">
            {entry.dataKey === 'commissionRate' ? `${entry.value}%` : formatCurrency(entry.value)}
          </span>
        </div>
      ))}
    </div>
  );
}

export function CommissionsBreakdownChart({ data }: CommissionsBreakdownChartProps) {
  // Commission per source = gross - net for each source
  const chartData = data.map((s) => {
    const appleComm = Number(s.mrr_apple_gross) - Number(s.mrr_apple_net);
    const googleComm = Number(s.mrr_google_gross) - Number(s.mrr_google_net);
    const stripeComm = Number(s.mrr_stripe_gross) - Number(s.mrr_stripe_net);
    const totalGross = Number(s.mrr_gross);
    const totalComm = Number(s.total_commissions);
    const rate = totalGross > 0 ? (totalComm / totalGross) * 100 : 0;

    return {
      date: s.snapshot_date,
      'App Store (iOS)': Math.round(appleComm),
      'Google Play': Math.round(googleComm),
      'Web (Stripe)': Math.round(stripeComm),
      commissionRate: Number(rate.toFixed(1)),
    };
  });

  const exportData = data.map((s) => {
    const appleComm = Number(s.mrr_apple_gross) - Number(s.mrr_apple_net);
    const googleComm = Number(s.mrr_google_gross) - Number(s.mrr_google_net);
    const stripeComm = Number(s.mrr_stripe_gross) - Number(s.mrr_stripe_net);
    const totalGross = Number(s.mrr_gross);
    const totalComm = Number(s.total_commissions);
    const rate = totalGross > 0 ? (totalComm / totalGross) * 100 : 0;

    return {
      Period: s.snapshot_date,
      'App Store (iOS)': Math.round(appleComm),
      'Google Play': Math.round(googleComm),
      'Web (Stripe)': Math.round(stripeComm),
      'Total Commissions': Math.round(totalComm),
      'Commission Rate (%)': Number(rate.toFixed(1)),
    };
  });

  return (
    <Card className="overflow-hidden">
      <div className="h-1 bg-gradient-to-r from-[#E53E3E] via-[#F59E0B] to-[#0E3687]" />
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold text-[#0E3687]">Commissions by Source</CardTitle>
          <ChartExportButton data={exportData} filename="commissions-by-source" />
        </div>
        <p className="text-xs text-muted-foreground mt-1">Store fees charged by Apple, Google, and Stripe per month</p>
      </CardHeader>
      <CardContent>
        <div className="h-[350px]">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
              <CartesianGrid stroke="#E2E8F0" strokeOpacity={0.6} strokeDasharray="3 3" />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 11, fill: '#64748B' }}
                stroke="#94A3B8"
                tickFormatter={(val) => {
                  const d = new Date(val + 'T00:00:00Z');
                  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
                  return `${months[d.getUTCMonth()]} ${d.getUTCFullYear().toString().slice(2)}`;
                }}
              />
              <YAxis
                yAxisId="left"
                tick={{ fontSize: 12, fill: '#64748B' }}
                stroke="#94A3B8"
                tickFormatter={(val) => formatCurrency(val)}
              />
              <YAxis
                yAxisId="right"
                orientation="right"
                tick={{ fontSize: 12, fill: '#64748B' }}
                stroke="#94A3B8"
                tickFormatter={(val) => `${val}%`}
                domain={[0, 'auto']}
              />
              <Tooltip content={<CustomTooltip />} />
              <Legend />
              <Bar
                yAxisId="left"
                dataKey="App Store (iOS)"
                stackId="comm"
                fill={SOURCE_COLORS.apple}
              />
              <Bar
                yAxisId="left"
                dataKey="Google Play"
                stackId="comm"
                fill={SOURCE_COLORS.google}
              />
              <Bar
                yAxisId="left"
                dataKey="Web (Stripe)"
                stackId="comm"
                fill={SOURCE_COLORS.stripe}
                radius={[4, 4, 0, 0]}
              />
              <Line
                yAxisId="right"
                type="monotone"
                dataKey="commissionRate"
                name="Commission Rate"
                stroke="#E53E3E"
                strokeWidth={2.5}
                dot={{ fill: '#E53E3E', r: 4 }}
                activeDot={{ r: 6, fill: '#E53E3E', stroke: 'white', strokeWidth: 2 }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
