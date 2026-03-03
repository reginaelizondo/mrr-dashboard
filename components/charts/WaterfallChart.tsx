'use client';

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
  ReferenceLine,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCurrency } from '@/lib/constants';

interface WaterfallChartProps {
  gross: number;
  commissions: number;
  taxes: number;
  refunds: number;
  disputes: number;
  net: number;
  periodLabel?: string;
}

export function WaterfallChart({
  gross,
  commissions,
  taxes,
  refunds,
  disputes,
  net,
  periodLabel,
}: WaterfallChartProps) {
  // Build items, filtering out zero-value deductions
  const items: { name: string; value: number; fill: string; isTotal: boolean }[] = [
    { name: 'Gross Sales', value: gross, fill: '#0086D8', isTotal: true },
  ];

  if (commissions > 0) {
    items.push({ name: 'Commissions', value: -commissions, fill: '#DA4D7A', isTotal: false });
  }
  if (taxes > 0) {
    items.push({ name: 'Taxes', value: -taxes, fill: '#0E3687', isTotal: false });
  }
  if (refunds > 0) {
    items.push({ name: 'Refunds', value: -refunds, fill: '#DA4D7A', isTotal: false });
  }
  if (disputes > 0) {
    items.push({ name: 'Disputes', value: -disputes, fill: '#0E3687', isTotal: false });
  }

  items.push({ name: 'Net Revenue', value: net, fill: '#45C94E', isTotal: true });

  // Compute waterfall positioning
  let running = 0;
  const waterfallData = items.map((item) => {
    if (item.isTotal) {
      // Total bars (Gross, Net) start from 0
      if (item.name === 'Gross Sales') running = item.value;
      return { ...item, base: 0, display: item.value, actualValue: item.value };
    }
    // Deduction bars: hang from previous running total down to new running total
    const prevRunning = running;
    running += item.value; // item.value is negative
    return {
      ...item,
      base: running, // invisible portion (from 0 to where bar bottom sits)
      display: Math.abs(item.value), // visible colored portion
      actualValue: item.value,
    };
  });

  // Custom tooltip that shows actual amounts
  const CustomTooltip = ({ active, payload }: { active?: boolean; payload?: Array<{ payload: typeof waterfallData[0] }> }) => {
    if (!active || !payload || !payload.length) return null;
    const entry = payload[0]?.payload;
    if (!entry) return null;
    return (
      <div className="rounded-xl border border-border/50 bg-white p-3 shadow-xl">
        <p className="text-sm font-medium text-[#0E3687]">{entry.name}</p>
        <p className="text-sm font-semibold mt-0.5" style={{ color: entry.fill }}>
          {entry.actualValue < 0 ? '-' : ''}{formatCurrency(Math.abs(entry.actualValue))}
        </p>
      </div>
    );
  };

  return (
    <Card className="overflow-hidden">
      <div className="h-1 bg-gradient-to-r from-[#0086D8] via-[#DA4D7A] to-[#45C94E]" />
      <CardHeader>
        <div className="flex items-baseline gap-2">
          <CardTitle className="text-base font-semibold text-[#0E3687]">Revenue Waterfall</CardTitle>
          {periodLabel && (
            <span className="text-xs text-muted-foreground font-normal">
              — {periodLabel}
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <div className="h-[300px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={waterfallData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#64748B' }} stroke="#94A3B8" />
              <YAxis tickFormatter={(val) => formatCurrency(val)} tick={{ fontSize: 12, fill: '#64748B' }} stroke="#94A3B8" />
              <Tooltip content={<CustomTooltip />} />
              <ReferenceLine y={0} stroke="#94A3B8" />
              <Bar dataKey="base" stackId="waterfall" isAnimationActive={false} radius={0}>
                {waterfallData.map((_entry, index) => (
                  <Cell key={index} fill="transparent" stroke="none" />
                ))}
              </Bar>
              <Bar dataKey="display" stackId="waterfall" isAnimationActive={false} radius={[4, 4, 0, 0]}>
                {waterfallData.map((entry, index) => (
                  <Cell key={index} fill={entry.fill} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
