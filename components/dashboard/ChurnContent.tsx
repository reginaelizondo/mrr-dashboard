'use client';

import { useSearchParams } from 'next/navigation';
import { parseFiltersFromParams, applyFilters, computeTotals, getPeriodLabel } from '@/lib/filters';
import { ChurnChart } from '@/components/charts/ChurnChart';
import { ChurnByPlanChart } from '@/components/charts/ChurnByPlanChart';
import { MetricCard } from '@/components/dashboard/MetricCard';
import { ExportButton } from '@/components/dashboard/ExportButton';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCurrency } from '@/lib/constants';
import { Users, TrendingDown, Percent, DollarSign, Clock, AlertTriangle } from 'lucide-react';
import type { MrrDailySnapshot } from '@/types';

export function ChurnContent({ snapshots }: { snapshots: MrrDailySnapshot[] }) {
  const searchParams = useSearchParams();
  const filters = parseFiltersFromParams(new URLSearchParams(searchParams.toString()));
  const filtered = applyFilters(snapshots, filters);
  const totals = computeTotals(filtered);
  const periodLabel = getPeriodLabel(filtered);

  // Churn metrics
  const totalSubsCount = totals.newSubs + totals.renewals;
  const churnRate = totalSubsCount + totals.refundCount > 0
    ? (totals.refundCount / (totalSubsCount + totals.refundCount)) * 100
    : 0;

  // Weighted monthly churn: weight each month's churn by its subscriber volume
  let weightedChurn = 0;
  let totalWeight = 0;
  for (const s of filtered) {
    const subs = Number(s.new_subscriptions) + Number(s.renewals);
    const lost = Number(s.refund_count);
    const base = subs + lost;
    if (base > 0) {
      const monthChurn = lost / base;
      weightedChurn += monthChurn * base;
      totalWeight += base;
    }
  }
  const avgWeightedChurn = totalWeight > 0 ? (weightedChurn / totalWeight) * 100 : 0;

  // LTV estimation: Average Revenue Per User / Monthly Churn Rate
  // ARPU = total net revenue / total subscribers over the period
  const arpu = totalSubsCount > 0 ? totals.net / totalSubsCount : 0;
  const monthlyChurnDecimal = avgWeightedChurn / 100;
  const ltv = monthlyChurnDecimal > 0 ? arpu / monthlyChurnDecimal : 0;

  // MoM lost renewals trend (last vs prior month)
  let lostTrend = 0;
  if (filtered.length >= 2) {
    const latest = filtered[filtered.length - 1];
    const prior = filtered[filtered.length - 2];
    if (prior.refund_count > 0) {
      lostTrend = ((latest.refund_count - prior.refund_count) / prior.refund_count) * 100;
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

      {/* Row 1: Key churn metrics */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <MetricCard
          label="Monthly Churn Rate"
          value={avgWeightedChurn}
          format="percent"
          icon={TrendingDown}
          accentColor="red"
          subtitle="Weighted avg across period"
        />
        <MetricCard
          label="Estimated LTV"
          value={ltv}
          format="currency"
          icon={DollarSign}
          accentColor="green"
          subtitle="ARPU / monthly churn"
        />
        <MetricCard
          label="Lost Subs Trend"
          value={lostTrend}
          format="percent"
          icon={AlertTriangle}
          accentColor={lostTrend > 0 ? 'red' : 'green'}
          subtitle="Last month vs prior"
        />
      </div>

      {/* Row 2: Volume metrics */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          label="Active Subscriptions"
          value={totalSubsCount}
          format="number"
          icon={Users}
          accentColor="teal"
          subtitle="New + renewals"
        />
        <MetricCard
          label="Lost (Refunds)"
          value={totals.refundCount}
          format="number"
          icon={TrendingDown}
          accentColor="rose"
        />
        <MetricCard
          label="Refund Amount"
          value={totals.refunds}
          format="currency"
          icon={DollarSign}
          accentColor="rose"
        />
        <MetricCard
          label="ARPU (Net)"
          value={arpu}
          format="currency"
          icon={Clock}
          accentColor="navy"
          subtitle="Avg revenue per user"
        />
      </div>

      {/* Charts */}
      <ChurnChart data={filtered} />

      <ChurnByPlanChart data={filtered} />

      {/* Detailed table */}
      <Card className="overflow-hidden">
        <div className="h-1 bg-gradient-to-r from-[#45C94E] via-[#F59E0B] to-[#E53E3E]" />
        <CardHeader>
          <CardTitle className="text-base font-semibold text-[#0E3687]">Monthly Churn Detail</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/50 bg-[#F8F9FB]">
                  <th className="text-left py-3 px-3 font-semibold text-[#0E3687] text-xs uppercase tracking-wider">Period</th>
                  <th className="text-right py-3 px-3 font-semibold text-[#0E3687] text-xs uppercase tracking-wider">New</th>
                  <th className="text-right py-3 px-3 font-semibold text-[#0E3687] text-xs uppercase tracking-wider">Renewals</th>
                  <th className="text-right py-3 px-3 font-semibold text-[#0E3687] text-xs uppercase tracking-wider">Lost</th>
                  <th className="text-right py-3 px-3 font-semibold text-[#0E3687] text-xs uppercase tracking-wider">Churn %</th>
                  <th className="text-right py-3 px-3 font-semibold text-[#0E3687] text-xs uppercase tracking-wider">Refund $</th>
                  <th className="text-right py-3 px-3 font-semibold text-[#0E3687] text-xs uppercase tracking-wider">Net Change</th>
                  <th className="text-right py-3 px-3 font-semibold text-[#0E3687] text-xs uppercase tracking-wider">MoM Lost</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((s, i) => {
                  const subs = Number(s.new_subscriptions) + Number(s.renewals);
                  const lost = Number(s.refund_count);
                  const base = subs + lost;
                  const churn = base > 0 ? ((lost / base) * 100).toFixed(1) : '0.0';
                  const netChange = subs - lost;

                  // MoM change in lost subs
                  let momLost = '';
                  if (i > 0) {
                    const prevLost = Number(filtered[i - 1].refund_count);
                    const diff = lost - prevLost;
                    momLost = diff >= 0 ? `+${diff}` : `${diff}`;
                  }

                  const d = new Date(s.snapshot_date + 'T00:00:00Z');
                  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
                  const periodStr = `${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;

                  return (
                    <tr key={s.snapshot_date} className={`border-b border-border/30 last:border-0 hover:bg-[#F0F4FF]/50 transition-colors ${i % 2 === 0 ? '' : 'bg-[#F8F9FB]/50'}`}>
                      <td className="py-2.5 px-3 font-medium">{periodStr}</td>
                      <td className="text-right py-2.5 px-3 tabular-nums text-[#0086D8]">{s.new_subscriptions.toLocaleString()}</td>
                      <td className="text-right py-2.5 px-3 tabular-nums text-[#45C94E]">{s.renewals.toLocaleString()}</td>
                      <td className="text-right py-2.5 px-3 tabular-nums text-[#E53E3E] font-medium">{lost.toLocaleString()}</td>
                      <td className="text-right py-2.5 px-3 tabular-nums">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${Number(churn) > 10 ? 'bg-red-100 text-red-700' : Number(churn) > 5 ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700'}`}>
                          {churn}%
                        </span>
                      </td>
                      <td className="text-right py-2.5 px-3 tabular-nums text-[#E53E3E]">{formatCurrency(Number(s.total_refunds))}</td>
                      <td className={`text-right py-2.5 px-3 tabular-nums font-medium ${netChange >= 0 ? 'text-[#45C94E]' : 'text-[#E53E3E]'}`}>
                        {netChange >= 0 ? '+' : ''}{netChange.toLocaleString()}
                      </td>
                      <td className={`text-right py-2.5 px-3 tabular-nums font-medium ${momLost.startsWith('+') ? 'text-[#E53E3E]' : momLost.startsWith('-') ? 'text-[#45C94E]' : 'text-muted-foreground'}`}>
                        {momLost || '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
