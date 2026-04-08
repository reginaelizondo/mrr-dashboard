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
import { buildProjectionBundle } from '@/lib/mrr-projection';
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
  const bundle = buildProjectionBundle(data);

  // Estimate active subs by source using revenue proportion.
  // Total subs = new_subscriptions + renewals
  // Source share = mrr_{source}_gross / mrr_gross
  // For stale months we project the totals field-by-field then redistribute.
  const chartData = data.map((s) => {
    const row = bundle.rows.get(s.snapshot_date);
    const is_stale = row?.is_stale || false;

    // Actual values
    const totalSubsActual = Number(s.new_subscriptions) + Number(s.renewals);
    const grossTotalActual = Number(s.mrr_gross) || 1;
    const appleA = Math.round(totalSubsActual * (Number(s.mrr_apple_gross) / grossTotalActual));
    const googleA = Math.round(totalSubsActual * (Number(s.mrr_google_gross) / grossTotalActual));
    const stripeA = Math.round(totalSubsActual * (Number(s.mrr_stripe_gross) / grossTotalActual));

    // Projected total (only used if stale)
    let projectedExtra = 0;
    if (is_stale && row) {
      const newSubsP = row.fields.new_subscriptions?.projected || 0;
      const renewalsP = row.fields.renewals?.projected || 0;
      const totalSubsP = newSubsP + renewalsP;
      projectedExtra = Math.max(0, Math.round(totalSubsP - totalSubsActual));
    }

    return {
      date: s.snapshot_date,
      'App Store (iOS)': appleA,
      'Google Play': googleA,
      'Web (Stripe)': stripeA,
      _projected_extra: projectedExtra,
      _is_stale: is_stale,
    };
  });
  const hasProjections = chartData.some((d) => d._projected_extra > 0);

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
              <defs>
                <pattern id="subs-hatch" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(45)">
                  <rect width="8" height="8" fill="#0086D8" fillOpacity="0.15" />
                  <line x1="0" y1="0" x2="0" y2="8" stroke="#0086D8" strokeWidth="1.5" strokeOpacity="0.6" />
                </pattern>
              </defs>
              <CartesianGrid stroke="#E2E8F0" strokeOpacity={0.6} strokeDasharray="3 3" />
              <XAxis
                dataKey="date"
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
                tickFormatter={(val) => val.toLocaleString()}
              />
              <Tooltip content={<CustomTooltip />} />
              <Legend />
              <Bar dataKey="App Store (iOS)" stackId="source" fill={SOURCE_COLORS.apple} />
              <Bar dataKey="Google Play" stackId="source" fill={SOURCE_COLORS.google} />
              <Bar dataKey="Web (Stripe)" stackId="source" fill={SOURCE_COLORS.stripe} />
              <Bar
                dataKey="_projected_extra"
                name="Proyectado (stale)"
                stackId="source"
                fill="url(#subs-hatch)"
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
            Área rayada = estimación de suscripciones adicionales para los meses stale (basada en la proyección de new_subscriptions + renewals).
          </p>
        )}
      </CardContent>
    </Card>
  );
}
