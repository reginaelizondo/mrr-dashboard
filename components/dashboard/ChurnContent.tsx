'use client';

import { useSearchParams } from 'next/navigation';
import { parseFiltersFromParams, applyFilters, computeTotals, getPeriodLabel } from '@/lib/filters';
import { ChurnChart } from '@/components/charts/ChurnChart';
import { ChurnByPlanChart } from '@/components/charts/ChurnByPlanChart';
import { MetricCard } from '@/components/dashboard/MetricCard';
import { ExportButton } from '@/components/dashboard/ExportButton';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Users, TrendingDown, DollarSign, Clock, AlertTriangle } from 'lucide-react';
import type { MrrDailySnapshot } from '@/types';

export function ChurnContent({ snapshots }: { snapshots: MrrDailySnapshot[] }) {
  const searchParams = useSearchParams();
  const filters = parseFiltersFromParams(new URLSearchParams(searchParams.toString()));
  const filtered = applyFilters(snapshots, filters);
  const totals = computeTotals(filtered);
  const periodLabel = getPeriodLabel(filtered);

  // ─── Churn metrics using active_subscriptions ───
  // Calculate lost subs per month and weighted churn
  let totalLost = 0;
  let weightedChurn = 0;
  let totalWeight = 0;
  const monthlyChurnRates: number[] = [];

  for (let i = 1; i < filtered.length; i++) {
    const prevActive = Number(filtered[i - 1].active_subscriptions || 0);
    const currActive = Number(filtered[i].active_subscriptions || 0);
    const currNew = Number(filtered[i].new_subscriptions || 0);

    // Lost = previous active + new this month - current active
    const lost = Math.max(0, prevActive + currNew - currActive);
    totalLost += lost;

    // Monthly churn rate = lost / previous active base
    if (prevActive > 0) {
      const monthChurn = lost / prevActive;
      monthlyChurnRates.push(monthChurn);
      weightedChurn += monthChurn * prevActive;
      totalWeight += prevActive;
    }
  }

  const avgWeightedChurn = totalWeight > 0 ? (weightedChurn / totalWeight) * 100 : 0;

  // Latest month active subs
  const latestActive = filtered.length > 0
    ? Number(filtered[filtered.length - 1].active_subscriptions || 0)
    : 0;

  // ARPU = total net revenue / total active subscription-months
  const totalActiveSubs = filtered.reduce((sum, s) => sum + Number(s.active_subscriptions || 0), 0);
  const arpu = totalActiveSubs > 0 ? totals.net / totalActiveSubs : 0;

  // LTV estimation: ARPU / Monthly Churn Rate
  const monthlyChurnDecimal = avgWeightedChurn / 100;
  const ltv = monthlyChurnDecimal > 0 ? arpu / monthlyChurnDecimal : 0;

  // MoM lost trend (last vs prior month)
  let lostTrend = 0;
  if (filtered.length >= 3) {
    const prevPrevActive = Number(filtered[filtered.length - 3].active_subscriptions || 0);
    const prevActive = Number(filtered[filtered.length - 2].active_subscriptions || 0);
    const prevNew = Number(filtered[filtered.length - 2].new_subscriptions || 0);
    const currActive = Number(filtered[filtered.length - 1].active_subscriptions || 0);
    const currNew = Number(filtered[filtered.length - 1].new_subscriptions || 0);

    const prevLost = Math.max(0, prevPrevActive + prevNew - prevActive);
    const currLost = Math.max(0, prevActive + currNew - currActive);
    if (prevLost > 0) {
      lostTrend = ((currLost - prevLost) / prevLost) * 100;
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
          value={latestActive}
          format="number"
          icon={Users}
          accentColor="teal"
          subtitle="Current month (by spreading)"
        />
        <MetricCard
          label="Lost Subscriptions"
          value={totalLost}
          format="number"
          icon={TrendingDown}
          accentColor="rose"
          subtitle="Expired / didn't renew"
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
          subtitle="Avg revenue per active sub"
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
          <p className="text-xs text-muted-foreground">
            Lost = subscriptions that expired or didn&apos;t renew (prev active + new − current active)
          </p>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/50 bg-[#F8F9FB]">
                  <th className="text-left py-3 px-3 font-semibold text-[#0E3687] text-xs uppercase tracking-wider">Period</th>
                  <th className="text-right py-3 px-3 font-semibold text-[#0E3687] text-xs uppercase tracking-wider">Active</th>
                  <th className="text-right py-3 px-3 font-semibold text-[#0E3687] text-xs uppercase tracking-wider">New</th>
                  <th className="text-right py-3 px-3 font-semibold text-[#0E3687] text-xs uppercase tracking-wider">Renewals</th>
                  <th className="text-right py-3 px-3 font-semibold text-[#0E3687] text-xs uppercase tracking-wider">Lost</th>
                  <th className="text-right py-3 px-3 font-semibold text-[#0E3687] text-xs uppercase tracking-wider">Churn %</th>
                  <th className="text-right py-3 px-3 font-semibold text-[#0E3687] text-xs uppercase tracking-wider">Net Change</th>
                  <th className="text-right py-3 px-3 font-semibold text-[#0E3687] text-xs uppercase tracking-wider">MoM Lost</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((s, i) => {
                  const activeSubs = Number(s.active_subscriptions || 0);
                  const newSubs = Number(s.new_subscriptions || 0);
                  const renewalCount = Number(s.renewals || 0);

                  let lost = 0;
                  let churnPct = '0.0';
                  if (i > 0) {
                    const prevActive = Number(filtered[i - 1].active_subscriptions || 0);
                    lost = Math.max(0, prevActive + newSubs - activeSubs);
                    churnPct = prevActive > 0 ? ((lost / prevActive) * 100).toFixed(1) : '0.0';
                  }

                  const netChange = activeSubs - Number(i > 0 ? filtered[i - 1].active_subscriptions || 0 : 0);

                  // MoM change in lost subs
                  let momLost = '';
                  if (i > 1) {
                    const ppActive = Number(filtered[i - 2].active_subscriptions || 0);
                    const pActive = Number(filtered[i - 1].active_subscriptions || 0);
                    const pNew = Number(filtered[i - 1].new_subscriptions || 0);
                    const prevLost = Math.max(0, ppActive + pNew - pActive);
                    const diff = lost - prevLost;
                    momLost = diff >= 0 ? `+${diff.toLocaleString()}` : `${diff.toLocaleString()}`;
                  }

                  const d = new Date(s.snapshot_date + 'T00:00:00Z');
                  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
                  const periodStr = `${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;

                  return (
                    <tr key={s.snapshot_date} className={`border-b border-border/30 last:border-0 hover:bg-[#F0F4FF]/50 transition-colors ${i % 2 === 0 ? '' : 'bg-[#F8F9FB]/50'}`}>
                      <td className="py-2.5 px-3 font-medium">{periodStr}</td>
                      <td className="text-right py-2.5 px-3 tabular-nums text-[#0E3687] font-medium">{activeSubs.toLocaleString()}</td>
                      <td className="text-right py-2.5 px-3 tabular-nums text-[#0086D8]">{newSubs.toLocaleString()}</td>
                      <td className="text-right py-2.5 px-3 tabular-nums text-[#45C94E]">{renewalCount.toLocaleString()}</td>
                      <td className="text-right py-2.5 px-3 tabular-nums text-[#E53E3E] font-medium">{i === 0 ? '—' : lost.toLocaleString()}</td>
                      <td className="text-right py-2.5 px-3 tabular-nums">
                        {i === 0 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${Number(churnPct) > 10 ? 'bg-red-100 text-red-700' : Number(churnPct) > 5 ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700'}`}>
                            {churnPct}%
                          </span>
                        )}
                      </td>
                      <td className={`text-right py-2.5 px-3 tabular-nums font-medium ${i === 0 ? 'text-muted-foreground' : netChange >= 0 ? 'text-[#45C94E]' : 'text-[#E53E3E]'}`}>
                        {i === 0 ? '—' : `${netChange >= 0 ? '+' : ''}${netChange.toLocaleString()}`}
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
