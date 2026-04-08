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
import { buildProjectionBundle } from '@/lib/mrr-projection';
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
  const bundle = buildProjectionBundle(data);

  // Commission per source = gross - net for each source. For stale months
  // we use projected gross/net to estimate the commission that would land.
  const chartData = data.map((s) => {
    const row = bundle.rows.get(s.snapshot_date);
    const is_stale = row?.is_stale || false;

    const appleComm = Number(s.mrr_apple_gross) - Number(s.mrr_apple_net);
    const googleComm = Number(s.mrr_google_gross) - Number(s.mrr_google_net);
    const stripeComm = Number(s.mrr_stripe_gross) - Number(s.mrr_stripe_net);
    const totalGross = Number(s.mrr_gross);
    const totalComm = Number(s.total_commissions);
    const rate = totalGross > 0 ? (totalComm / totalGross) * 100 : 0;

    let projectedExtra = 0;
    if (is_stale && row) {
      const projAppleComm =
        (row.fields.mrr_apple_gross?.projected || 0) - (row.fields.mrr_apple_net?.projected || 0);
      const projGoogleComm =
        (row.fields.mrr_google_gross?.projected || 0) - (row.fields.mrr_google_net?.projected || 0);
      const projStripeComm =
        (row.fields.mrr_stripe_gross?.projected || 0) - (row.fields.mrr_stripe_net?.projected || 0);
      const projTotalComm = projAppleComm + projGoogleComm + projStripeComm;
      projectedExtra = Math.max(0, Math.round(projTotalComm - totalComm));
    }

    return {
      date: s.snapshot_date,
      'App Store (iOS)': Math.round(appleComm),
      'Google Play': Math.round(googleComm),
      'Web (Stripe)': Math.round(stripeComm),
      _projected_extra: projectedExtra,
      _is_stale: is_stale,
      commissionRate: Number(rate.toFixed(1)),
    };
  });
  const hasProjections = chartData.some((d) => d._projected_extra > 0);

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
              <defs>
                <pattern id="comm-hatch" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(45)">
                  <rect width="8" height="8" fill="#0086D8" fillOpacity="0.15" />
                  <line x1="0" y1="0" x2="0" y2="8" stroke="#0086D8" strokeWidth="1.5" strokeOpacity="0.6" />
                </pattern>
              </defs>
              <CartesianGrid stroke="#E2E8F0" strokeOpacity={0.6} strokeDasharray="3 3" />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 11, fill: '#64748B' }}
                stroke="#94A3B8"
                tickFormatter={(val) => {
                  const d = new Date(val + 'T00:00:00Z');
                  const months = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
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
              />
              <Bar
                yAxisId="left"
                dataKey="_projected_extra"
                name="Proyectado (stale)"
                stackId="comm"
                fill="url(#comm-hatch)"
                stroke="#0086D8"
                strokeWidth={1.5}
                strokeDasharray="4 2"
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
        {hasProjections && (
          <p className="text-[10px] text-muted-foreground mt-2 leading-relaxed border-t border-border/40 pt-2">
            Área rayada = commission adicional proyectada para los meses stale (calculada con gross/net proyectados por fuente).
          </p>
        )}
      </CardContent>
    </Card>
  );
}
