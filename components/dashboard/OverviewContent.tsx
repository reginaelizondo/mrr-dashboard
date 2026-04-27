'use client';

import { useSearchParams } from 'next/navigation';
import { parseFiltersFromParams, applyFilters, computeTotals, getPeriodLabel } from '@/lib/filters';
import { MetricCard } from '@/components/dashboard/MetricCard';
import { GoalProgressCard } from '@/components/dashboard/GoalProgressCard';
import { SourceBreakdownChart } from '@/components/charts/SourceBreakdownChart';
import { ActiveSubsBySourceChart } from '@/components/charts/ActiveSubsBySourceChart';
import { RevenueCostsChart } from '@/components/charts/RevenueCostsChart';
import { NetRevenueCostsChart } from '@/components/charts/NetRevenueCostsChart';
import { MonthlyGrowthChart } from '@/components/charts/MonthlyGrowthChart';
import { NetNewMrrChart } from '@/components/charts/NetNewMrrChart';
import { ExportButton } from '@/components/dashboard/ExportButton';
import { TrendingUp, DollarSign, Percent, RotateCcw, Zap, Activity } from 'lucide-react';
import type { MrrDailySnapshot } from '@/types';

// ARR Goal — adjust as needed
const ARR_GOAL = 6_000_000;

export function OverviewContent({ snapshots }: { snapshots: MrrDailySnapshot[] }) {
  const searchParams = useSearchParams();
  const filters = parseFiltersFromParams(new URLSearchParams(searchParams.toString()));
  const filtered = applyFilters(snapshots, filters);
  const totals = computeTotals(filtered);
  const periodLabel = getPeriodLabel(filtered);

  const commissionPct = totals.gross > 0 ? ((totals.commissions / totals.gross) * 100).toFixed(1) : '0.0';

  // ARR, growth, and goal always use ALL snapshots (unfiltered) for accuracy
  const allSorted = [...snapshots].sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));
  const latestMrr = allSorted.length > 0 ? Number(allSorted[allSorted.length - 1].mrr_net) : 0;

  // ARR = Trailing Twelve Months (sum of last 12 months of gross revenue)
  const last12 = allSorted.slice(-12);
  const arr = last12.reduce((sum, s) => sum + Number(s.mrr_gross), 0);

  // MoM growth (always from latest 2 months, unfiltered)
  let momGrowth = 0;
  if (allSorted.length >= 2) {
    const prev = Number(allSorted[allSorted.length - 2].mrr_net);
    const curr = Number(allSorted[allSorted.length - 1].mrr_net);
    if (prev > 0) momGrowth = ((curr - prev) / prev) * 100;
  }

  // 6-month growth multiplier (always from unfiltered data)
  let sixMonthMultiplier = 0;
  if (allSorted.length >= 7) {
    const sixAgo = Number(allSorted[allSorted.length - 7].mrr_net);
    if (sixAgo > 0) sixMonthMultiplier = latestMrr / sixAgo;
  } else if (allSorted.length >= 2) {
    const first = Number(allSorted[0].mrr_net);
    if (first > 0) sixMonthMultiplier = latestMrr / first;
  }

  return (
    <>
      {/* Period indicator + Export */}
      <div className="flex items-center justify-between">
        {periodLabel && (
          <p className="text-sm text-muted-foreground">
            Showing accumulated totals for <span className="font-semibold text-[#0E3687]">{periodLabel}</span>
            {filtered.length > 1 && <span> ({filtered.length} months)</span>}
          </p>
        )}
        <ExportButton snapshots={filtered} />
      </div>

      {/* Row 1: Key MRR metrics */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          label="MRR (Net Revenue)"
          value={totals.net}
          icon={TrendingUp}
          accentColor="teal"
          subtitle="After store commissions"
        />
        <MetricCard
          label="Gross Revenue"
          value={totals.gross}
          icon={DollarSign}
          accentColor="green"
          subtitle="Before commissions"
        />
        <MetricCard
          label="Commissions"
          value={totals.commissions}
          icon={Percent}
          accentColor="red"
          subtitle={`${commissionPct}% of gross revenue`}
        />
        <MetricCard
          label="Refunds"
          value={totals.refunds}
          icon={RotateCcw}
          accentColor="rose"
        />
      </div>

      {/* Row 2: ARR, Growth, Goal */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          label="ARR"
          value={arr}
          icon={DollarSign}
          accentColor="navy"
          subtitle="Trailing 12 months (TTM)"
        />
        <MetricCard
          label="MoM Growth"
          value={momGrowth}
          format="percent"
          icon={Zap}
          accentColor={momGrowth >= 0 ? 'green' : 'red'}
          subtitle="Net MRR vs prior month"
        />
        <MetricCard
          label="6-Month Growth"
          value={sixMonthMultiplier}
          format="multiplier"
          icon={Activity}
          accentColor="teal"
          subtitle="MRR growth over 6 months"
        />
        <GoalProgressCard
          label="Road to $6M ARR"
          current={arr}
          goal={ARR_GOAL}
          subtitle="Based on current run rate"
        />
      </div>

      <RevenueCostsChart data={filtered} />

      <NetRevenueCostsChart data={filtered} />

      {/* Growth charts side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <NetNewMrrChart data={filtered} />
        <MonthlyGrowthChart data={filtered} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <SourceBreakdownChart data={filtered} />
        <ActiveSubsBySourceChart data={filtered} />
      </div>
    </>
  );
}

