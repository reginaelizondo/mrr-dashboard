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
import { formatCurrency, PLAN_COLORS } from '@/lib/constants';
import { ChartExportButton } from '@/components/charts/ChartExportButton';
import type { MrrDailySnapshot } from '@/types';

interface ChurnByPlanChartProps {
  data: MrrDailySnapshot[];
}

// MRR lost by plan type = refund_count proportioned by each plan's MRR share
// Since we don't have per-plan refund data, we show MRR distribution by plan
// to indicate where churn risk is concentrated
const planKeys = [
  { key: 'mrr_monthly', label: 'Monthly', color: PLAN_COLORS.monthly },
  { key: 'mrr_yearly', label: 'Yearly', color: PLAN_COLORS.yearly },
  { key: 'mrr_semesterly', label: 'Semesterly', color: PLAN_COLORS.semesterly },
  { key: 'mrr_quarterly', label: 'Quarterly', color: PLAN_COLORS.quarterly },
  { key: 'mrr_weekly', label: 'Weekly', color: PLAN_COLORS.weekly },
  { key: 'mrr_lifetime', label: 'Lifetime', color: PLAN_COLORS.lifetime },
] as const;

function CustomTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string }>; label?: string }) {
  if (!active || !payload || !payload.length) return null;
  const total = payload.reduce((acc, entry) => acc + entry.value, 0);
  return (
    <div className="rounded-xl border border-border/50 bg-white p-3 shadow-xl">
      <p className="text-xs font-medium text-muted-foreground mb-2">
        {label ? new Date(String(label) + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }) : ''}
      </p>
      {payload.map((entry, i) => {
        const pct = total > 0 ? ((entry.value / total) * 100).toFixed(0) : '0';
        return (
          <div key={i} className="flex items-center gap-2 text-sm">
            <span className="h-2.5 w-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: entry.color }} />
            <span className="text-muted-foreground">{entry.name}:</span>
            <span className="font-semibold text-[#0E3687]">{formatCurrency(entry.value)}</span>
            <span className="text-xs text-muted-foreground">({pct}%)</span>
          </div>
        );
      })}
      <div className="mt-1.5 pt-1.5 border-t border-border/30 text-sm font-semibold text-[#0E3687]">
        Total: {formatCurrency(total)}
      </div>
    </div>
  );
}

export function ChurnByPlanChart({ data }: ChurnByPlanChartProps) {
  const exportData = data.map((s) => ({
    Period: s.snapshot_date,
    Monthly: Number(s.mrr_monthly),
    Yearly: Number(s.mrr_yearly),
    Semesterly: Number(s.mrr_semesterly),
    Quarterly: Number(s.mrr_quarterly),
    Weekly: Number(s.mrr_weekly),
    Lifetime: Number(s.mrr_lifetime),
  }));

  return (
    <Card className="overflow-hidden">
      <div className="h-1 bg-gradient-to-r from-[#0086D8] via-[#F59E0B] to-[#DA4D7A]" />
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold text-[#0E3687]">MRR at Risk by Plan Type</CardTitle>
          <ChartExportButton data={exportData} filename="mrr-at-risk-by-plan" />
        </div>
        <p className="text-xs text-muted-foreground mt-1">Distribution of revenue across plan types - higher monthly concentration = higher churn risk</p>
      </CardHeader>
      <CardContent>
        <div className="h-[300px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
              <CartesianGrid stroke="#E2E8F0" strokeOpacity={0.6} strokeDasharray="3 3" />
              <XAxis
                dataKey="snapshot_date"
                tick={{ fontSize: 11, fill: '#64748B' }}
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
              {planKeys.map((p, i) => (
                <Bar
                  key={p.key}
                  dataKey={p.key}
                  name={p.label}
                  stackId="plan"
                  fill={p.color}
                  radius={i === planKeys.length - 1 ? [4, 4, 0, 0] : undefined}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
