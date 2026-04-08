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
import { buildProjectionBundle } from '@/lib/mrr-projection';
import type { MrrDailySnapshot } from '@/types';

interface MonthlyGrowthChartProps {
  data: MrrDailySnapshot[];
}

interface GrowthData {
  month: string;
  snapshot_date: string;
  growthPct: number;
  projectedExtra: number;
  projectedTotal: number;
  is_stale: boolean;
}

function computeGrowth(data: MrrDailySnapshot[]): GrowthData[] {
  const bundle = buildProjectionBundle(data);
  const result: GrowthData[] = [];

  for (let i = 1; i < data.length; i++) {
    const prev = data[i - 1];
    const curr = data[i];
    const actualPrev = Number(prev.mrr_net);
    const actualCurr = Number(curr.mrr_net);
    const actualGrowth = actualPrev > 0 ? ((actualCurr - actualPrev) / actualPrev) * 100 : 0;

    const projCurr = bundle.rows.get(curr.snapshot_date);
    const projPrev = bundle.rows.get(prev.snapshot_date);
    const projectedCurrVal = projCurr?.fields.mrr_net?.projected ?? actualCurr;
    const projectedPrevVal = projPrev?.fields.mrr_net?.projected ?? actualPrev;
    const projectedGrowth =
      projectedPrevVal > 0 ? ((projectedCurrVal - projectedPrevVal) / projectedPrevVal) * 100 : 0;

    const is_stale = projCurr?.is_stale || false;
    // Only overlay when the month is stale AND the projection increases the
    // growth rate. Mirrors the convention used by the other charts.
    const projectedExtra = is_stale ? Math.max(0, projectedGrowth - actualGrowth) : 0;

    const d = new Date(curr.snapshot_date + 'T00:00:00Z');
    const months = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
    const monthLabel = `${months[d.getUTCMonth()]} ${d.getUTCFullYear().toString().slice(2)}`;

    result.push({
      month: monthLabel,
      snapshot_date: curr.snapshot_date,
      growthPct: Number(actualGrowth.toFixed(1)),
      projectedExtra: Number(projectedExtra.toFixed(1)),
      projectedTotal: Number((actualGrowth + projectedExtra).toFixed(1)),
      is_stale,
    });
  }
  return result;
}

interface TooltipPayload {
  payload?: GrowthData;
}

function CustomTooltip({ active, payload, label }: { active?: boolean; payload?: TooltipPayload[]; label?: string }) {
  if (!active || !payload || !payload.length) return null;
  const row = payload[0]?.payload;
  if (!row) return null;
  const val = row.growthPct;
  return (
    <div className="rounded-xl border border-border/50 bg-white p-3 shadow-xl min-w-[200px]">
      <p className="text-xs font-medium text-muted-foreground mb-1">
        {label}
        {row.is_stale && (
          <span className="ml-2 inline-block rounded bg-amber-100 px-1.5 py-0.5 text-[9px] font-bold text-amber-700 uppercase tracking-wider">
            Stale
          </span>
        )}
      </p>
      <p className={`text-lg font-bold ${val >= 0 ? 'text-[#45C94E]' : 'text-[#E53E3E]'}`}>
        {val >= 0 ? '+' : ''}{val}%
      </p>
      {row.is_stale && row.projectedExtra > 0 && (
        <>
          <div className="text-xs text-[#0086D8] mt-1">
            + {row.projectedExtra.toFixed(1)}pp proyectado
          </div>
          <div className="text-sm font-semibold text-[#0E3687] border-t border-border/40 mt-1 pt-1">
            Proyectado total: {row.projectedTotal >= 0 ? '+' : ''}{row.projectedTotal}%
          </div>
        </>
      )}
      <p className="text-xs text-muted-foreground mt-1">MRR Net growth MoM</p>
    </div>
  );
}

export function MonthlyGrowthChart({ data }: MonthlyGrowthChartProps) {
  const chartData = computeGrowth(data);

  // Show max last 6 months for cleaner view
  const displayData = chartData.slice(-6);
  const hasProjections = displayData.some((d) => d.projectedExtra > 0);

  const exportData = chartData.map((d) => ({
    Month: d.month,
    'Growth Rate (%)': d.growthPct,
    'Projected Extra (pp)': d.projectedExtra,
    'Projected Total (%)': d.projectedTotal,
    'Is Stale': d.is_stale,
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
              <defs>
                <pattern id="growth-hatch" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(45)">
                  <rect width="8" height="8" fill="#0086D8" fillOpacity="0.15" />
                  <line x1="0" y1="0" x2="0" y2="8" stroke="#0086D8" strokeWidth="1.5" strokeOpacity="0.6" />
                </pattern>
              </defs>
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
              <Bar dataKey="growthPct" stackId="growth" barSize={20}>
                {displayData.map((entry, i) => (
                  <Cell
                    key={i}
                    fill={entry.growthPct >= 0 ? '#0086D8' : '#E53E3E'}
                    fillOpacity={0.85}
                  />
                ))}
              </Bar>
              <Bar
                dataKey="projectedExtra"
                stackId="growth"
                fill="url(#growth-hatch)"
                stroke="#0086D8"
                strokeWidth={1.5}
                strokeDasharray="4 2"
                radius={[0, 4, 4, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
        {hasProjections && (
          <p className="text-[10px] text-muted-foreground mt-2 leading-relaxed border-t border-border/40 pt-2">
            Área rayada = puntos porcentuales adicionales proyectados para meses stale. Se calcula como growth MoM usando valores proyectados menos growth MoM usando valores actuales.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
