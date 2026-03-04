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
import { ChartExportButton } from '@/components/charts/ChartExportButton';
import type { MrrDailySnapshot } from '@/types';

interface ChurnChartProps {
  data: MrrDailySnapshot[];
}

interface ChurnData {
  date: string;
  activeSubs: number;
  newSubs: number;
  lostSubs: number;
  churnRate: number;
}

/**
 * Compute churn data from snapshots.
 * Lost subs = previous active + new this month − current active
 * Churn rate = lost / previous active × 100
 */
function computeChurnData(data: MrrDailySnapshot[]): ChurnData[] {
  return data.map((s, i) => {
    const activeSubs = Number(s.active_subscriptions || 0);
    const newSubs = Number(s.new_subscriptions || 0);

    let lostSubs = 0;
    let churnRate = 0;

    if (i > 0) {
      const prevActive = Number(data[i - 1].active_subscriptions || 0);
      // Lost = subs that were active last month but aren't this month
      // prevActive + newSubs - activeSubs = churned out
      lostSubs = Math.max(0, prevActive + newSubs - activeSubs);
      // Churn rate relative to previous month's base
      churnRate = prevActive > 0 ? (lostSubs / prevActive) * 100 : 0;
    }

    return {
      date: s.snapshot_date,
      activeSubs,
      newSubs,
      lostSubs,
      churnRate: Number(churnRate.toFixed(1)),
    };
  });
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
            {entry.dataKey === 'churnRate' ? `${entry.value}%` : entry.value.toLocaleString()}
          </span>
        </div>
      ))}
    </div>
  );
}

export function ChurnChart({ data }: ChurnChartProps) {
  const chartData = computeChurnData(data);

  const exportData = chartData.map((d) => ({
    Period: d.date,
    'Active Subscriptions': d.activeSubs,
    'New Subscriptions': d.newSubs,
    'Lost Subscriptions': d.lostSubs,
    'Churn Rate (%)': d.churnRate,
  }));

  return (
    <Card className="overflow-hidden">
      <div className="h-1 bg-gradient-to-r from-[#45C94E] via-[#F59E0B] to-[#E53E3E]" />
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold text-[#0E3687]">Active vs Lost Subscriptions</CardTitle>
          <ChartExportButton data={exportData} filename="churn-analysis" />
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          Lost = subscriptions that expired or didn&apos;t renew (previous active + new − current active)
        </p>
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
                tickFormatter={(val) => val.toLocaleString()}
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
                dataKey="activeSubs"
                name="Active Subscriptions"
                fill="#45C94E"
                radius={[4, 4, 0, 0]}
              />
              <Bar
                yAxisId="left"
                dataKey="lostSubs"
                name="Lost Subscriptions"
                fill="#E53E3E"
                radius={[4, 4, 0, 0]}
              />
              <Line
                yAxisId="right"
                type="monotone"
                dataKey="churnRate"
                name="Churn Rate"
                stroke="#F59E0B"
                strokeWidth={2.5}
                dot={{ fill: '#F59E0B', r: 4 }}
                activeDot={{ r: 6, fill: '#F59E0B', stroke: 'white', strokeWidth: 2 }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
