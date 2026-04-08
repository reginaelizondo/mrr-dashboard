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
import { buildProjectionBundle } from '@/lib/mrr-projection';
import type { MrrDailySnapshot } from '@/types';

interface NetNewMrrChartProps {
  data: MrrDailySnapshot[];
}

interface NetNewData {
  month: string;
  snapshot_date: string;
  netNew: number;
  projectedExtra: number;
  projectedTotal: number;
  is_stale: boolean;
}

function computeNetNew(data: MrrDailySnapshot[]): NetNewData[] {
  const bundle = buildProjectionBundle(data);
  const result: NetNewData[] = [];

  for (let i = 1; i < data.length; i++) {
    const curr = data[i];
    const prev = data[i - 1];
    const actualPrev = Number(prev.mrr_net);
    const actualCurr = Number(curr.mrr_net);
    const netNewActual = Math.round(actualCurr - actualPrev);

    const projCurr = bundle.rows.get(curr.snapshot_date);
    const projPrev = bundle.rows.get(prev.snapshot_date);
    const projectedCurrVal = projCurr?.fields.mrr_net?.projected ?? actualCurr;
    const projectedPrevVal = projPrev?.fields.mrr_net?.projected ?? actualPrev;
    const netNewProjected = Math.round(projectedCurrVal - projectedPrevVal);

    const is_stale = projCurr?.is_stale || false;
    // Only overlay the "extra" when the month is stale AND the projection
    // adds to the net-new. Prevents negative shading on growth months.
    const projectedExtra = is_stale
      ? Math.max(0, netNewProjected - netNewActual)
      : 0;

    const d = new Date(curr.snapshot_date + 'T00:00:00Z');
    const months = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
    const monthLabel = `${months[d.getUTCMonth()]} ${d.getUTCFullYear().toString().slice(2)}`;

    result.push({
      month: monthLabel,
      snapshot_date: curr.snapshot_date,
      netNew: netNewActual,
      projectedExtra,
      projectedTotal: netNewActual + projectedExtra,
      is_stale,
    });
  }
  return result;
}

interface TooltipPayload {
  payload?: NetNewData;
}

function CustomTooltip({ active, payload, label }: { active?: boolean; payload?: TooltipPayload[]; label?: string }) {
  if (!active || !payload || !payload.length) return null;
  const row = payload[0]?.payload;
  if (!row) return null;
  const val = row.netNew;
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
        {val >= 0 ? '+' : ''}{formatCurrency(val)}
      </p>
      {row.is_stale && row.projectedExtra > 0 && (
        <>
          <div className="text-xs text-[#0086D8] mt-1">
            + {formatCurrency(row.projectedExtra)} proyectado extra
          </div>
          <div className="text-sm font-semibold text-[#0E3687] border-t border-border/40 mt-1 pt-1">
            Proyectado total: {formatCurrency(row.projectedTotal)}
          </div>
        </>
      )}
      <p className="text-xs text-muted-foreground mt-1">Net new MRR added</p>
    </div>
  );
}

export function NetNewMrrChart({ data }: NetNewMrrChartProps) {
  const chartData = computeNetNew(data);

  // Show last 6 months
  const displayData = chartData.slice(-6);
  const hasProjections = displayData.some((d) => d.projectedExtra > 0);

  const exportData = chartData.map((d) => ({
    Month: d.month,
    'Net New MRR ($)': d.netNew,
    'Projected Extra ($)': d.projectedExtra,
    'Projected Total ($)': d.projectedTotal,
    'Is Stale': d.is_stale,
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
              <defs>
                <pattern id="netnew-hatch" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(45)">
                  <rect width="8" height="8" fill="#0086D8" fillOpacity="0.15" />
                  <line x1="0" y1="0" x2="0" y2="8" stroke="#0086D8" strokeWidth="1.5" strokeOpacity="0.6" />
                </pattern>
              </defs>
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
              <Bar dataKey="netNew" stackId="netnew" barSize={40}>
                {displayData.map((entry, i) => (
                  <Cell key={i} fill={entry.netNew >= 0 ? '#45C94E' : '#E53E3E'} />
                ))}
              </Bar>
              <Bar
                dataKey="projectedExtra"
                stackId="netnew"
                fill="url(#netnew-hatch)"
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
            Área rayada = proyección para meses stale. Se calcula como la diferencia entre el net new con valores proyectados vs actuales.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
