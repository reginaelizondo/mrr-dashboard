export const dynamic = 'force-dynamic';

import { Suspense } from 'react';
import { getSnapshots } from '@/lib/dashboard';
import { getPresetDates } from '@/lib/filters';
import { FilterBar } from '@/components/dashboard/FilterBar';
import { BreakdownContent } from '@/components/dashboard/BreakdownContent';
import { Skeleton } from '@/components/ui/skeleton';
import type { DatePreset } from '@/types';

export default async function BreakdownPage({
  searchParams,
}: {
  searchParams: Promise<{
    preset?: string;
    start?: string;
    end?: string;
    sources?: string;
    regions?: string;
    plans?: string;
    tab?: string;
  }>;
}) {
  const params = await searchParams;
  const preset = (params.preset as DatePreset) || '12m';
  const tab = params.tab || 'source';

  // Resolve date range from preset or custom params
  let start = params.start;
  let end = params.end;
  if (preset !== 'custom' || !start || !end) {
    const dates = getPresetDates(preset);
    start = start || dates.start;
    end = end || dates.end;
  }

  const snapshots = await getSnapshots(start, end);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[#0E3687]">MRR Breakdown</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Revenue segmented by source, region, and plan type</p>
      </div>

      <Suspense fallback={<Skeleton className="h-8 w-full" />}>
        <FilterBar />
      </Suspense>

      <Suspense fallback={<Skeleton className="h-96 w-full" />}>
        <BreakdownContent snapshots={snapshots} defaultTab={tab} />
      </Suspense>
    </div>
  );
}
