'use client';

import { useSearchParams } from 'next/navigation';
import { parseFiltersFromParams, applyFilters, computeTotals, getPeriodLabel } from '@/lib/filters';
import { SourceBreakdownChart } from '@/components/charts/SourceBreakdownChart';
import { ActiveSubsBySourceChart } from '@/components/charts/ActiveSubsBySourceChart';
import { MetricCard } from '@/components/dashboard/MetricCard';
import { ExportButton } from '@/components/dashboard/ExportButton';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DollarSign, Wallet, TrendingUp, Calendar } from 'lucide-react';
import type { MrrDailySnapshot } from '@/types';

export function TrendsContent({ snapshots }: { snapshots: MrrDailySnapshot[] }) {
  const searchParams = useSearchParams();
  const filters = parseFiltersFromParams(new URLSearchParams(searchParams.toString()));
  const filtered = applyFilters(snapshots, filters);
  const totals = computeTotals(filtered);
  const periodLabel = getPeriodLabel(filtered);

  // Compute growth rate based on Net MRR (matches Tableau methodology)
  let growthRate = 0;
  if (filtered.length >= 2) {
    const latest = filtered[filtered.length - 1];
    const previous = filtered[filtered.length - 2];
    if (previous.mrr_net > 0) {
      growthRate = ((latest.mrr_net - previous.mrr_net) / previous.mrr_net) * 100;
    }
  }

  return (
    <>
      <div className="flex items-center justify-between">
        {periodLabel && (
          <p className="text-sm text-muted-foreground">
            Showing accumulated totals for <span className="font-semibold text-[#0E3687]">{periodLabel}</span>
            {filtered.length > 1 && <span> ({filtered.length} months)</span>}
          </p>
        )}
        <ExportButton snapshots={filtered} />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          label="Total MRR (Net)"
          value={totals.net}
          icon={TrendingUp}
          accentColor="teal"
          subtitle="After store commissions"
        />
        <MetricCard
          label="Total Gross Revenue"
          value={totals.gross}
          icon={DollarSign}
          accentColor="green"
          subtitle="Before commissions"
        />
        <MetricCard
          label="MoM Growth Rate"
          value={growthRate}
          format="percent"
          icon={Wallet}
          accentColor="navy"
          subtitle="Net MRR, last vs prior month"
        />
        <MetricCard
          label="Data Points"
          value={filtered.length}
          format="number"
          icon={Calendar}
          accentColor="rose"
          subtitle="months in range"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <SourceBreakdownChart data={filtered} />
        <ActiveSubsBySourceChart data={filtered} />
      </div>

      <Card className="overflow-hidden">
        <div className="h-1 bg-gradient-to-r from-[#0086D8] to-[#0E3687]" />
        <CardHeader>
          <CardTitle className="text-base font-semibold text-[#0E3687]">Period-over-Period Summary</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/50 bg-[#F8F9FB]">
                  <th className="text-left py-3 px-3 font-semibold text-[#0E3687] text-xs uppercase tracking-wider">Period</th>
                  <th className="text-right py-3 px-3 font-semibold text-[#0E3687] text-xs uppercase tracking-wider">Gross</th>
                  <th className="text-right py-3 px-3 font-semibold text-[#0E3687] text-xs uppercase tracking-wider">Net</th>
                  <th className="text-right py-3 px-3 font-semibold text-[#0E3687] text-xs uppercase tracking-wider">Commissions</th>
                  <th className="text-right py-3 px-3 font-semibold text-[#0E3687] text-xs uppercase tracking-wider">Refunds</th>
                  <th className="text-right py-3 px-3 font-semibold text-[#0E3687] text-xs uppercase tracking-wider">New Subs</th>
                  <th className="text-right py-3 px-3 font-semibold text-[#0E3687] text-xs uppercase tracking-wider">Renewals</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((s, i) => (
                  <tr key={s.snapshot_date} className={`border-b border-border/30 last:border-0 hover:bg-[#F0F4FF]/50 transition-colors ${i % 2 === 0 ? '' : 'bg-[#F8F9FB]/50'}`}>
                    <td className="py-2.5 px-3 font-medium">{s.snapshot_date}</td>
                    <td className="text-right py-2.5 px-3 tabular-nums">${Number(s.mrr_gross).toLocaleString()}</td>
                    <td className="text-right py-2.5 px-3 tabular-nums">${Number(s.mrr_net).toLocaleString()}</td>
                    <td className="text-right py-2.5 px-3 tabular-nums">${Number(s.total_commissions).toLocaleString()}</td>
                    <td className="text-right py-2.5 px-3 tabular-nums">${Number(s.total_refunds).toLocaleString()}</td>
                    <td className="text-right py-2.5 px-3 tabular-nums">{s.new_subscriptions}</td>
                    <td className="text-right py-2.5 px-3 tabular-nums">{s.renewals}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
