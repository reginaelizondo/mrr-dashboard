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
import { formatCurrency, PLAN_COLORS, PLAN_LABELS } from '@/lib/constants';
import { ChartExportButton } from '@/components/charts/ChartExportButton';
import { buildProjectionBundle } from '@/lib/mrr-projection';
import type { MrrDailySnapshot } from '@/types';

interface PlanBreakdownChartProps {
  data: MrrDailySnapshot[];
}

const planTypes = [
  { key: 'mrr_lifetime', label: PLAN_LABELS.lifetime, color: PLAN_COLORS.lifetime },
  { key: 'mrr_yearly', label: PLAN_LABELS.yearly, color: PLAN_COLORS.yearly },
  { key: 'mrr_semesterly', label: PLAN_LABELS.semesterly, color: PLAN_COLORS.semesterly },
  { key: 'mrr_quarterly', label: PLAN_LABELS.quarterly, color: PLAN_COLORS.quarterly },
  { key: 'mrr_monthly', label: PLAN_LABELS.monthly, color: PLAN_COLORS.monthly },
  { key: 'mrr_weekly', label: PLAN_LABELS.weekly, color: PLAN_COLORS.weekly },
  { key: 'mrr_other', label: PLAN_LABELS.other, color: PLAN_COLORS.other },
];

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

export function PlanBreakdownChart({ data }: PlanBreakdownChartProps) {
  const bundle = buildProjectionBundle(data);

  const enrichedData = data.map((s) => {
    const row = bundle.rows.get(s.snapshot_date);
    const is_stale = row?.is_stale || false;
    let projectedExtra = 0;
    if (is_stale && row) {
      for (const pt of planTypes) {
        const fld = row.fields[pt.key];
        if (fld) projectedExtra += Math.max(0, fld.projected - fld.actual);
      }
    }
    return { ...s, _projected_extra: Math.round(projectedExtra), _is_stale: is_stale };
  });
  const hasProjections = enrichedData.some((r) => r._projected_extra > 0);

  const exportData = data.map((s) => ({
    Period: s.snapshot_date,
    Lifetime: Number(s.mrr_lifetime),
    Yearly: Number(s.mrr_yearly),
    Semesterly: Number(s.mrr_semesterly),
    Quarterly: Number(s.mrr_quarterly),
    Monthly: Number(s.mrr_monthly),
    Weekly: Number(s.mrr_weekly),
    Other: Number(s.mrr_other),
  }));

  return (
    <Card className="overflow-hidden">
      <div className="h-1 bg-gradient-to-r from-[#0E3687] via-[#F59E0B] to-[#45C94E]" />
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold text-[#0E3687]">MRR by Plan Type</CardTitle>
          <ChartExportButton data={exportData} filename="mrr-by-plan-type" />
        </div>
      </CardHeader>
      <CardContent>
        <div className="h-[350px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={enrichedData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
              <defs>
                <pattern id="plan-hatch" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(45)">
                  <rect width="8" height="8" fill="#0086D8" fillOpacity="0.15" />
                  <line x1="0" y1="0" x2="0" y2="8" stroke="#0086D8" strokeWidth="1.5" strokeOpacity="0.6" />
                </pattern>
              </defs>
              <CartesianGrid stroke="#E2E8F0" strokeOpacity={0.6} strokeDasharray="3 3" />
              <XAxis
                dataKey="snapshot_date"
                tick={{ fontSize: 11, fill: '#64748B' }}
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
              {planTypes.map((pt) => (
                <Bar
                  key={pt.key}
                  dataKey={pt.key}
                  name={pt.label}
                  stackId="plan"
                  fill={pt.color}
                />
              ))}
              <Bar
                dataKey="_projected_extra"
                name="Proyectado (stale)"
                stackId="plan"
                fill="url(#plan-hatch)"
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
            Área rayada = proyección de los meses stale, suma de extras por plan.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
