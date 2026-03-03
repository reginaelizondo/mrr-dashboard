'use client';

import { useSearchParams } from 'next/navigation';
import { parseFiltersFromParams, applyFilters, computeTotals, getPeriodLabel } from '@/lib/filters';
import { MetricCard } from '@/components/dashboard/MetricCard';
import { SourceBreakdownChart } from '@/components/charts/SourceBreakdownChart';
import { ActiveSubsBySourceChart } from '@/components/charts/ActiveSubsBySourceChart';
import { RevenueCostsChart } from '@/components/charts/RevenueCostsChart';
import { ExportButton } from '@/components/dashboard/ExportButton';
import { TrendingUp, DollarSign, Percent, RotateCcw } from 'lucide-react';
import type { MrrDailySnapshot } from '@/types';

export function OverviewContent({ snapshots }: { snapshots: MrrDailySnapshot[] }) {
  const searchParams = useSearchParams();
  const filters = parseFiltersFromParams(new URLSearchParams(searchParams.toString()));
  const filtered = applyFilters(snapshots, filters);
  const totals = computeTotals(filtered);
  const periodLabel = getPeriodLabel(filtered);

  const commissionPct = totals.gross > 0 ? ((totals.commissions / totals.gross) * 100).toFixed(1) : '0.0';

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

      <RevenueCostsChart data={filtered} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <SourceBreakdownChart data={filtered} />
        <ActiveSubsBySourceChart data={filtered} />
      </div>
    </>
  );
}
