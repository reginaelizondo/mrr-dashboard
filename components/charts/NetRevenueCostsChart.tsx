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
  ReferenceLine,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCurrency } from '@/lib/constants';
import { ChartExportButton } from '@/components/charts/ChartExportButton';
import { projectMrr } from '@/lib/mrr-projection';
import type { MrrDailySnapshot } from '@/types';

/**
 * Net MRR view: same shape as RevenueCostsChart but uses mrr_net on top
 * and stacks all gross→net deductions (commissions + taxes + refunds + disputes)
 * as a single negative bar so the visual identity holds: positive bar + extra
 * (projection) + negative deductions.
 */

interface NetRevenueCostsChartProps {
  data: MrrDailySnapshot[];
}

interface TooltipEntry {
  name: string;
  value: number;
  color: string;
  payload?: ChartRow;
}
interface ChartRow {
  date: string;
  'Net Revenue': number;
  'Projected Extra': number;
  'Deductions': number;
  commissions: number;
  taxes: number;
  refunds: number;
  disputes: number;
  is_stale: boolean;
  projected_total: number;
}

function CustomTooltip({ active, payload, label }: { active?: boolean; payload?: TooltipEntry[]; label?: string }) {
  if (!active || !payload || !payload.length) return null;
  const row = payload[0]?.payload;
  const actual = (row?.['Net Revenue'] || 0);
  const extra = (row?.['Projected Extra'] || 0);
  const deductions = Math.abs(row?.['Deductions'] || 0);
  return (
    <div className="rounded-xl border border-border/50 bg-white p-3 shadow-xl min-w-[220px]">
      <p className="text-xs font-medium text-muted-foreground mb-2">
        {label ? new Date(String(label) + 'T00:00:00Z').toLocaleDateString('es-MX', { month: 'long', year: 'numeric', timeZone: 'UTC' }) : ''}
        {row?.is_stale && (
          <span className="ml-2 inline-block rounded bg-amber-100 px-1.5 py-0.5 text-[9px] font-bold text-amber-700 uppercase tracking-wider">
            Stale
          </span>
        )}
      </p>
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-3 text-sm">
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full flex-shrink-0 bg-[#10B981]" />
            <span className="text-muted-foreground">{row?.is_stale ? 'Actual (stale):' : 'Net Revenue:'}</span>
          </div>
          <span className="font-semibold text-[#0E3687] tabular-nums">{formatCurrency(actual)}</span>
        </div>
        {row?.is_stale && extra > 0 && (
          <>
            <div className="flex items-center justify-between gap-3 text-sm">
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full flex-shrink-0 border border-[#10B981] bg-[#10B981]/30" />
                <span className="text-muted-foreground">Proyectado extra:</span>
              </div>
              <span className="font-semibold text-[#10B981] tabular-nums">+{formatCurrency(extra)}</span>
            </div>
            <div className="flex items-center justify-between gap-3 text-sm border-t border-border/40 pt-1 mt-1">
              <span className="font-medium text-muted-foreground">Proyectado total:</span>
              <span className="font-bold text-[#0E3687] tabular-nums">{formatCurrency(row.projected_total)}</span>
            </div>
          </>
        )}
        <div className="flex items-center justify-between gap-3 text-sm border-t border-border/40 pt-1 mt-1">
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full flex-shrink-0 bg-[#E53E3E]" />
            <span className="text-muted-foreground">Total deducciones:</span>
          </div>
          <span className="font-semibold text-[#0E3687] tabular-nums">{formatCurrency(deductions)}</span>
        </div>
        <div className="pl-4 space-y-0.5 text-[11px] text-muted-foreground">
          <div className="flex justify-between gap-3"><span>· Commissions</span><span className="tabular-nums">{formatCurrency(row?.commissions || 0)}</span></div>
          <div className="flex justify-between gap-3"><span>· Taxes</span><span className="tabular-nums">{formatCurrency(row?.taxes || 0)}</span></div>
          <div className="flex justify-between gap-3"><span>· Refunds</span><span className="tabular-nums">{formatCurrency(row?.refunds || 0)}</span></div>
          <div className="flex justify-between gap-3"><span>· Disputes</span><span className="tabular-nums">{formatCurrency(row?.disputes || 0)}</span></div>
        </div>
      </div>
    </div>
  );
}

export function NetRevenueCostsChart({ data }: NetRevenueCostsChartProps) {
  const projection = projectMrr(data);
  const projByDate = new Map(projection.months.map((p) => [p.snapshot_date, p]));

  const chartData: ChartRow[] = data.map((s) => {
    const proj = projByDate.get(s.snapshot_date);
    const actual = Number(s.mrr_net);
    const projectedTotal = proj?.mrr_net_projected || actual;
    const extra = proj?.is_stale ? Math.max(0, projectedTotal - actual) : 0;
    const commissions = Number(s.total_commissions || 0);
    const taxes = Number(s.total_taxes || 0);
    const refunds = Number(s.total_refunds || 0);
    const disputes = Number(s.total_disputes || 0);
    const deductions = commissions + taxes + refunds + disputes;
    return {
      date: s.snapshot_date,
      'Net Revenue': actual,
      'Projected Extra': extra,
      'Deductions': -deductions,
      commissions,
      taxes,
      refunds,
      disputes,
      is_stale: proj?.is_stale || false,
      projected_total: projectedTotal,
    };
  });

  const exportData = data.map((s) => {
    const proj = projByDate.get(s.snapshot_date);
    return {
      Period: s.snapshot_date,
      'Net Revenue (Actual)': Number(s.mrr_net),
      'Net Revenue (Projected)': proj?.mrr_net_projected || Number(s.mrr_net),
      'Is Stale': proj?.is_stale || false,
      Commissions: Number(s.total_commissions || 0),
      Taxes: Number(s.total_taxes || 0),
      Refunds: Number(s.total_refunds || 0),
      Disputes: Number(s.total_disputes || 0),
      'Gross Revenue': Number(s.mrr_gross),
    };
  });

  const hasProjections = projection.months.some((m) => m.is_stale);
  const projPctMoM = (projection.avgMoMGrowthNet * 100).toFixed(1);

  return (
    <Card className="overflow-hidden">
      <div className="h-1 bg-gradient-to-r from-[#10B981] to-[#E53E3E]" />
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold text-[#0E3687]">
            Net Revenue vs Deductions
            {hasProjections && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                (con proyección para meses stale)
              </span>
            )}
          </CardTitle>
          <ChartExportButton data={exportData} filename="net-revenue-vs-deductions" />
        </div>
      </CardHeader>
      <CardContent>
        <div className="h-[350px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
              <defs>
                <pattern id="net-projected-hatch" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(45)">
                  <rect width="8" height="8" fill="#10B981" fillOpacity="0.15" />
                  <line x1="0" y1="0" x2="0" y2="8" stroke="#10B981" strokeWidth="1.5" strokeOpacity="0.6" />
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
                tick={{ fontSize: 12, fill: '#64748B' }}
                stroke="#94A3B8"
                tickFormatter={(val) => formatCurrency(val)}
              />
              <Tooltip content={<CustomTooltip />} />
              <Legend />
              <ReferenceLine y={0} stroke="#94A3B8" />
              <Bar dataKey="Net Revenue" stackId="net" fill="#10B981" radius={[0, 0, 0, 0]} />
              <Bar dataKey="Projected Extra" stackId="net" fill="url(#net-projected-hatch)" stroke="#10B981" strokeWidth={1.5} strokeDasharray="4 2" radius={[4, 4, 0, 0]} />
              <Bar dataKey="Deductions" fill="#E53E3E" radius={[0, 0, 4, 4]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        {hasProjections && projection.sampleSize > 0 && (
          <p className="text-[11px] text-muted-foreground mt-2 leading-relaxed border-t border-border/40 pt-2">
            <strong>Cómo se calcula la proyección:</strong> los snapshots mensuales se actualizan
            cada día pero hasta que pasa <em>month_end + 7 días</em> el sistema asume que pueden
            seguir llegando reportes tardíos de Apple/Google/Stripe. Para meses marcados como
            <em> stale</em>, se proyecta el final aplicando el crecimiento MoM Net promedio
            de los últimos {projection.sampleSize} meses maduros ({projPctMoM}%) desde el
            último mes maduro ({projection.latestMatureMonth || '—'}). El área rayada en verde
            claro representa el delta proyectado sobre la barra sólida (dato actual).
          </p>
        )}
      </CardContent>
    </Card>
  );
}
